// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../../contracts/channels/PaymentChannels.sol";
import "../../contracts/mocks/MockERC20Permit.sol";

/**
 * @title PaymentChannels stateful-invariant handler
 * @notice Opens channels between a few payers and payees (each with its own
 *         voucher key), tops them up from strangers, signs ever-higher vouchers
 *         (sometimes past the deposit), settles old and new ones, requests
 *         closes, lets time pass, withdraws and closes. Ghosts track what each
 *         side was paid, so the invariants can say where every token went.
 */
contract PaymentChannelsHandler is Test {
    PaymentChannels public channels;
    MockERC20Permit public token;

    uint256[] internal signerKeys;
    address[] public payers;
    address[] public payees;
    bytes32[] public ids;
    mapping(bytes32 => uint256) public signerKeyOf;
    mapping(bytes32 => uint96) public signedTotal;

    uint256 public ghostDeposited;
    uint256 public ghostPaidToPayees;
    uint256 public ghostRefunded;
    /// A settle paid more than the newest voucher allowed.
    bool public ghostOverpaid;
    /// A withdraw succeeded before its grace period ended.
    bool public ghostEarlyWithdraw;
    /// The newest voucher had something to pay on an open channel, and settling it failed.
    bool public ghostPayeeBlocked;
    /// The grace period had ended on an open channel, and the payer's withdraw failed.
    bool public ghostPayerBlocked;

    constructor() {
        channels = new PaymentChannels();
        token = new MockERC20Permit("Satori", "SATORI", 18);
        for (uint256 i = 1; i <= 3; i++) {
            signerKeys.push(0xA11CE + i);
            payers.push(address(uint160(0xBA0 + i)));
            payees.push(address(uint160(0xEE0 + i)));
        }
    }

    function _fund(address who, uint256 amount) internal {
        token.mint(who, amount);
        vm.prank(who);
        token.approve(address(channels), amount);
    }

    function _pick(uint256 seed) internal view returns (bytes32 id, bool ok) {
        if (ids.length == 0) return (bytes32(0), false);
        id = ids[seed % ids.length];
        ok = !channels.getChannel(id).closed;
    }

    function open(uint256 who, uint96 deposit, bool byStranger) external {
        deposit = uint96(bound(deposit, 1, 1e24));
        uint256 k = who % 3;
        address payer = payers[k];
        address funder = byStranger ? address(0xF00D) : payer;
        address signer = vm.addr(signerKeys[k]);
        bytes32 salt = bytes32(ids.length);
        _fund(funder, deposit);
        vm.prank(funder);
        bytes32 id = channels.open(payer, payees[(who / 3) % 3], address(token), signer, deposit, salt);
        ids.push(id);
        signerKeyOf[id] = signerKeys[k];
        ghostDeposited += deposit;
    }

    function topUp(uint256 seed, uint96 amount) external {
        (bytes32 id, bool ok) = _pick(seed);
        if (!ok) return;
        amount = uint96(bound(amount, 1, 1e24));
        _fund(address(0xF00D), amount);
        vm.prank(address(0xF00D));
        channels.topUp(id, amount);
        ghostDeposited += amount;
    }

    function settle(uint256 seed, uint96 more, bool replayOld) external {
        (bytes32 id, bool ok) = _pick(seed);
        if (!ok) return;
        uint96 total = replayOld ? signedTotal[id] / 2 : signedTotal[id] + uint96(bound(more, 0, 5e23));
        if (total > signedTotal[id]) signedTotal[id] = total;
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerKeyOf[id], channels.voucherDigest(id, total));
        PaymentChannels.Channel memory before = channels.getChannel(id);
        address payee = before.payee;
        uint256 had = token.balanceOf(payee);
        uint96 due = total < before.deposit ? total : before.deposit;
        try channels.settle(id, total, abi.encodePacked(r, s, v)) {
            uint256 paid = token.balanceOf(payee) - had;
            ghostPaidToPayees += paid;
            if (before.settled + paid > signedTotal[id] || before.settled + paid > before.deposit) ghostOverpaid = true;
        } catch {
            if (due > before.settled) ghostPayeeBlocked = true;
        }
    }

    /// Every channel's newest voucher at once, through settleMany, plus junk entries it must skip.
    function settleAll(uint96 junk) external {
        uint256 n = ids.length;
        bytes32[] memory batch = new bytes32[](n + 1);
        uint96[] memory totals = new uint96[](n + 1);
        bytes[] memory sigs = new bytes[](n + 1);
        uint256 before;
        uint256 owedBefore;
        for (uint256 i = 0; i < n; i++) {
            batch[i] = ids[i];
            totals[i] = signedTotal[ids[i]];
            (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerKeyOf[ids[i]], channels.voucherDigest(ids[i], totals[i]));
            sigs[i] = abi.encodePacked(r, s, v);
        }
        batch[n] = keccak256(abi.encode(junk));
        totals[n] = junk;
        for (uint256 i = 0; i < payees.length; i++) before += token.balanceOf(payees[i]);
        owedBefore = token.balanceOf(address(channels));
        try channels.settleMany(batch, totals, sigs) {} catch {
            ghostPayeeBlocked = true;
            return;
        }
        uint256 afterPaid;
        for (uint256 i = 0; i < payees.length; i++) afterPaid += token.balanceOf(payees[i]);
        ghostPaidToPayees += afterPaid - before;
        if (owedBefore - token.balanceOf(address(channels)) != afterPaid - before) ghostOverpaid = true;
        for (uint256 i = 0; i < n; i++) {
            PaymentChannels.Channel memory c = channels.getChannel(ids[i]);
            uint96 due = totals[i] < c.deposit ? totals[i] : c.deposit;
            if (!c.closed && c.settled < due) ghostPayeeBlocked = true;
        }
    }

    function requestClose(uint256 seed, bool bySigner) external {
        (bytes32 id, bool ok) = _pick(seed);
        if (!ok) return;
        PaymentChannels.Channel memory c = channels.getChannel(id);
        vm.prank(bySigner ? c.signer : c.payer);
        channels.requestClose(id);
    }

    function withdraw(uint256 seed) external {
        (bytes32 id, bool ok) = _pick(seed);
        if (!ok) return;
        PaymentChannels.Channel memory c = channels.getChannel(id);
        uint256 had = token.balanceOf(c.payer);
        bool due = c.closeRequestedAt != 0 && block.timestamp >= uint256(c.closeRequestedAt) + channels.CLOSE_GRACE_PERIOD();
        vm.prank(c.payer);
        try channels.withdraw(id) {
            if (!due) ghostEarlyWithdraw = true;
            ghostRefunded += token.balanceOf(c.payer) - had;
        } catch {
            if (due) ghostPayerBlocked = true;
        }
    }

    function payeeClose(uint256 seed, bool withVoucher) external {
        (bytes32 id, bool ok) = _pick(seed);
        if (!ok) return;
        PaymentChannels.Channel memory c = channels.getChannel(id);
        bytes memory sig;
        uint96 total = signedTotal[id];
        if (withVoucher) {
            (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerKeyOf[id], channels.voucherDigest(id, total));
            sig = abi.encodePacked(r, s, v);
        }
        uint256 payeeHad = token.balanceOf(c.payee);
        uint256 payerHad = token.balanceOf(c.payer);
        vm.prank(c.payee);
        channels.close(id, total, sig);
        ghostPaidToPayees += token.balanceOf(c.payee) - payeeHad;
        ghostRefunded += token.balanceOf(c.payer) - payerHad;
    }

    function cancelClose(uint256 seed) external {
        (bytes32 id, bool ok) = _pick(seed);
        if (!ok) return;
        PaymentChannels.Channel memory c = channels.getChannel(id);
        if (c.closeRequestedAt == 0) return;
        vm.prank(c.payer);
        channels.cancelClose(id);
    }

    function wait(uint32 seconds_) external {
        vm.warp(block.timestamp + bound(seconds_, 1, 10 days));
    }

    function idCount() external view returns (uint256) {
        return ids.length;
    }

    function idAt(uint256 i) external view returns (bytes32) {
        return ids[i];
    }
}

contract PaymentChannelsInvariantTest is Test {
    PaymentChannelsHandler internal h;

    function setUp() public {
        h = new PaymentChannelsHandler();
        targetContract(address(h));
    }

    /// The contract holds exactly what its open channels still owe.
    function invariant_holdsWhatOpenChannelsOwe() public view {
        uint256 owed;
        for (uint256 i = 0; i < h.idCount(); i++) {
            PaymentChannels.Channel memory c = h.channels().getChannel(h.idAt(i));
            assertLe(c.settled, c.deposit);
            if (!c.closed) owed += c.deposit - c.settled;
        }
        assertEq(h.token().balanceOf(address(h.channels())), owed);
    }

    /// Every token deposited is held, was paid to a payee, or went back to a payer.
    function invariant_everyTokenAccountedFor() public view {
        assertEq(
            h.ghostDeposited(),
            h.token().balanceOf(address(h.channels())) + h.ghostPaidToPayees() + h.ghostRefunded()
        );
    }

    function invariant_neverOverpays() public view {
        assertFalse(h.ghostOverpaid());
    }

    function invariant_noEarlyWithdraw() public view {
        assertFalse(h.ghostEarlyWithdraw());
    }

    /// The payee can always collect the newest voucher, up to the deposit, while the channel is open.
    function invariant_payeeCanAlwaysCollect() public view {
        assertFalse(h.ghostPayeeBlocked());
    }

    /// Once the grace period ends, the payer can always take back what was not settled.
    function invariant_payerCanAlwaysExit() public view {
        assertFalse(h.ghostPayerBlocked());
    }
}
