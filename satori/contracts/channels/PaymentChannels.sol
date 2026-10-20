// SPDX-License-Identifier: MIT
pragma solidity 0.8.20;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title PaymentChannels
/// @notice Unidirectional ERC-20 payment channels paid by cumulative EIP-712
///         vouchers: `Voucher(bytes32 channelId,uint96 cumulativeAmount)`.
///         Immutable, no admin, no fee. Design: Satori/satori docs/plans/market.md.
contract PaymentChannels is EIP712, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint64 public constant CLOSE_GRACE_PERIOD = 7 days;
    bytes32 public constant VOUCHER_TYPEHASH =
        keccak256("Voucher(bytes32 channelId,uint96 cumulativeAmount)");

    struct Channel {
        address payer;
        uint96 deposit;
        address payee;
        uint96 settled;
        address token;
        uint64 closeRequestedAt;
        bool closed;
        address signer;
    }

    mapping(bytes32 => Channel) private _channels;

    event Opened(
        bytes32 indexed channelId,
        address indexed payer,
        address indexed payee,
        address token,
        address signer,
        address funder,
        bytes32 salt,
        uint96 deposit
    );
    event ToppedUp(
        bytes32 indexed channelId, address indexed payer, address indexed payee,
        address funder, uint96 amount, uint96 deposit
    );
    event Settled(
        bytes32 indexed channelId, address indexed payer, address indexed payee,
        uint96 cumulativeAmount, uint96 paid, uint96 settled
    );
    event CloseRequested(
        bytes32 indexed channelId, address indexed payer, address indexed payee, address by, uint64 graceEnds
    );
    event CloseCancelled(bytes32 indexed channelId, address indexed payer, address indexed payee);
    event Closed(
        bytes32 indexed channelId, address indexed payer, address indexed payee,
        address by, uint96 settled, uint96 refunded
    );

    error BadInput();
    error ChannelExists();
    error UnknownChannel();
    error ChannelClosed();
    error NotPayee();
    error NotPayer();
    error NotPayerOrSigner();
    error BadSignature();
    error NothingToSettle();
    error CloseNotRequested();
    error CloseNotReady();
    error UnsupportedToken();

    constructor() EIP712("PaymentChannels", "1") {}

    /// @notice Open a channel from `payer` to `payee`, funded by the caller.
    ///         `signer` signs the vouchers; refunds always go to `payer`.
    function open(address payer, address payee, address token, address signer, uint96 deposit, bytes32 salt)
        external
        nonReentrant
        returns (bytes32)
    {
        return _open(payer, payee, token, signer, deposit, salt);
    }

    /// @notice `open`, approving the deposit with the caller's ERC-2612 permit.
    function openWithPermit(
        address payer,
        address payee,
        address token,
        address signer,
        uint96 deposit,
        bytes32 salt,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external nonReentrant returns (bytes32) {
        // A permit already used (front-run) leaves the allowance in place; the pull decides.
        try IERC20Permit(token).permit(msg.sender, address(this), deposit, deadline, v, r, s) {} catch {}
        return _open(payer, payee, token, signer, deposit, salt);
    }

    /// @notice Add to a channel's deposit. Anyone may; it doesn't touch a pending close.
    function topUp(bytes32 channelId, uint96 amount) external nonReentrant {
        Channel storage c = _live(channelId);
        if (amount == 0) revert BadInput();
        uint256 deposit = uint256(c.deposit) + amount;
        if (deposit > type(uint96).max) revert BadInput();
        c.deposit = uint96(deposit);
        _pull(c.token, amount);
        emit ToppedUp(channelId, c.payer, c.payee, msg.sender, amount, c.deposit);
    }

    /// @notice Pay the payee what a voucher owes beyond what is already paid,
    ///         up to the deposit. Anyone may submit; only the payee is paid.
    function settle(bytes32 channelId, uint96 cumulativeAmount, bytes calldata signature) external nonReentrant {
        Channel storage c = _live(channelId);
        if (_settle(channelId, c, cumulativeAmount, signature) == 0) revert NothingToSettle();
    }

    /// @notice `settle` for many channels in one transaction. An entry that
    ///         can't pay (unknown, closed, nothing new, a bad signature) is
    ///         skipped. A contract signer can still burn the batch's gas, and a
    ///         token transfer can still revert it, so a seller batches only
    ///         channels with key (ECDSA) signers and tokens it trusts.
    function settleMany(bytes32[] calldata channelIds, uint96[] calldata cumulativeAmounts, bytes[] calldata signatures)
        external
        nonReentrant
        returns (uint256 settledCount)
    {
        uint256 n = channelIds.length;
        if (cumulativeAmounts.length != n || signatures.length != n) revert BadInput();
        for (uint256 i = 0; i < n; i++) {
            bytes32 id = channelIds[i];
            Channel storage c = _channels[id];
            if (c.payer == address(0) || c.closed) continue;
            uint96 target = _target(c, cumulativeAmounts[i]);
            if (target <= c.settled) continue;
            if (!_validSignature(c.signer, voucherDigest(id, cumulativeAmounts[i]), signatures[i])) continue;
            _pay(id, c, cumulativeAmounts[i], target);
            settledCount++;
        }
    }

    /// @notice The payee ends the channel at once: settles the voucher (if one
    ///         is given) and refunds the rest to the payer.
    function close(bytes32 channelId, uint96 cumulativeAmount, bytes calldata signature) external nonReentrant {
        Channel storage c = _live(channelId);
        if (msg.sender != c.payee) revert NotPayee();
        if (signature.length != 0) _settle(channelId, c, cumulativeAmount, signature);
        _finalize(channelId, c);
    }

    /// @notice Start the grace period after which the payer can withdraw.
    ///         Asking again does not restart it.
    function requestClose(bytes32 channelId) external nonReentrant {
        Channel storage c = _live(channelId);
        if (msg.sender != c.payer && msg.sender != c.signer) revert NotPayerOrSigner();
        if (c.closeRequestedAt != 0) return;
        c.closeRequestedAt = uint64(block.timestamp);
        emit CloseRequested(channelId, c.payer, c.payee, msg.sender, uint64(block.timestamp) + CLOSE_GRACE_PERIOD);
    }

    /// @notice The payer withdraws its close request. Not the signer: a hot key
    ///         undoing each request would keep the refund from ever coming due.
    function cancelClose(bytes32 channelId) external nonReentrant {
        Channel storage c = _live(channelId);
        if (msg.sender != c.payer) revert NotPayer();
        if (c.closeRequestedAt == 0) revert CloseNotRequested();
        c.closeRequestedAt = 0;
        emit CloseCancelled(channelId, c.payer, c.payee);
    }

    /// @notice After the grace period, refund what was not settled to the payer.
    function withdraw(bytes32 channelId) external nonReentrant {
        Channel storage c = _live(channelId);
        if (msg.sender != c.payer && msg.sender != c.signer) revert NotPayerOrSigner();
        if (c.closeRequestedAt == 0) revert CloseNotRequested();
        if (block.timestamp < uint256(c.closeRequestedAt) + CLOSE_GRACE_PERIOD) revert CloseNotReady();
        _finalize(channelId, c);
    }

    function getChannel(bytes32 channelId) external view returns (Channel memory) {
        return _channels[channelId];
    }

    function computeChannelId(address payer, address payee, address token, address signer, bytes32 salt)
        public
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(payer, payee, token, signer, salt));
    }

    function voucherDigest(bytes32 channelId, uint96 cumulativeAmount) public view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(VOUCHER_TYPEHASH, channelId, cumulativeAmount)));
    }

    function domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    function _open(address payer, address payee, address token, address signer, uint96 deposit, bytes32 salt)
        private
        returns (bytes32 id)
    {
        if (
            payer == address(0) || payee == address(0) || token == address(0) || signer == address(0) || deposit == 0
                || payer == address(this) || payee == address(this)
        ) revert BadInput();
        id = computeChannelId(payer, payee, token, signer, salt);
        // Ids are never reused, even after close: an old voucher would otherwise pay again.
        if (_channels[id].payer != address(0)) revert ChannelExists();
        _channels[id] = Channel(payer, deposit, payee, 0, token, 0, false, signer);
        _pull(token, deposit);
        emit Opened(id, payer, payee, token, signer, msg.sender, salt, deposit);
    }

    function _settle(bytes32 id, Channel storage c, uint96 cumulativeAmount, bytes calldata signature)
        private
        returns (uint96)
    {
        uint96 target = _target(c, cumulativeAmount);
        if (target <= c.settled) return 0;
        if (!_validSignature(c.signer, voucherDigest(id, cumulativeAmount), signature)) revert BadSignature();
        return _pay(id, c, cumulativeAmount, target);
    }

    function _target(Channel storage c, uint96 cumulativeAmount) private view returns (uint96) {
        return cumulativeAmount < c.deposit ? cumulativeAmount : c.deposit;
    }

    function _pay(bytes32 id, Channel storage c, uint96 cumulativeAmount, uint96 target) private returns (uint96 paid) {
        paid = target - c.settled;
        c.settled = target;
        IERC20(c.token).safeTransfer(c.payee, paid);
        emit Settled(id, c.payer, c.payee, cumulativeAmount, paid, target);
    }

    function _finalize(bytes32 id, Channel storage c) private {
        uint96 refund = c.deposit - c.settled;
        c.closed = true;
        if (refund != 0) IERC20(c.token).safeTransfer(c.payer, refund);
        emit Closed(id, c.payer, c.payee, msg.sender, c.settled, refund);
    }

    /// ECDSA first, ERC-1271 only if that fails: an EOA can gain code at any time
    /// (EIP-7702), and asking that code first would let the payer void every
    /// voucher it already signed. Only one word of the answer is copied, so a
    /// huge reply costs the caller nothing extra. (OpenZeppelin's SignatureChecker
    /// needs solc 0.8.24; this repo builds with 0.8.20.)
    function _validSignature(address signer, bytes32 digest, bytes calldata signature) private view returns (bool valid) {
        (address recovered, ECDSA.RecoverError err, ) = ECDSA.tryRecover(digest, signature);
        if (err == ECDSA.RecoverError.NoError && recovered == signer) return true;
        if (signer.code.length == 0) return false;
        bytes memory data = abi.encodeCall(IERC1271.isValidSignature, (digest, signature));
        bytes32 magic = bytes32(IERC1271.isValidSignature.selector);
        assembly ("memory-safe") {
            let ok := staticcall(gas(), signer, add(data, 0x20), mload(data), 0x00, 0x20)
            valid := and(and(ok, gt(returndatasize(), 0x1f)), eq(mload(0x00), magic))
        }
    }

    function _live(bytes32 id) private view returns (Channel storage c) {
        c = _channels[id];
        if (c.payer == address(0)) revert UnknownChannel();
        if (c.closed) revert ChannelClosed();
    }

    /// A fee-on-transfer token is refused: a deposit must be exactly what arrived.
    function _pull(address token, uint96 amount) private {
        uint256 before = IERC20(token).balanceOf(address(this));
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        if (IERC20(token).balanceOf(address(this)) - before != amount) revert UnsupportedToken();
    }
}
