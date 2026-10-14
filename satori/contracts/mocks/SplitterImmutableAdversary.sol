// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

interface ISplitterImmutable {
    function withdraw(address token, uint256 slotId) external returns (uint256);
    function rotateAt(address parent, address newPayee) external;
    function approveRotation(address parent, address newPayee) external;
    function rotateRecipient(address newPayee) external;
    function setWithdrawCaller(address caller) external;
}

/// @notice Test helper standing in for the PARENT splitter that a
///         SatoriSplitterImmutable holds a slot in. Each mode is a different way
///         a hostile or broken parent could try to abuse `rotateAt`'s outbound
///         call: 0 accepts silently, 1 reverts, 2 tries to reenter withdraw,
///         3 tries to reenter rotateAt itself, 4 tries to move the child's own
///         internal slots.
contract HostileParent {
    uint8 public mode;
    address public target;
    address public lastPayee;
    uint256 public calls;

    function setTarget(address t) external { target = t; }
    function setMode(uint8 m) external { mode = m; }

    function rotateRecipient(address newPayee) external {
        calls += 1;
        if (mode == 1) revert("hostile parent");
        if (mode == 2) ISplitterImmutable(target).withdraw(address(0), 0);
        if (mode == 3) ISplitterImmutable(target).rotateAt(address(this), newPayee);
        if (mode == 4) ISplitterImmutable(target).rotateRecipient(newPayee);
        lastPayee = newPayee;
    }

    /// @notice Let the parent push ETH onward, as a real parent splitter would.
    function pay(address to, uint256 amount) external {
        (bool ok, ) = payable(to).call{value: amount}("");
        require(ok, "pay failed");
    }

    receive() external payable {}
}

/// @notice A recipient contract that tries to reenter on ETH receipt, and can
///         also be pointed at approveRotation to probe the vote tally.
contract HostileRecipient {
    ISplitterImmutable public immutable splitter;
    uint256 public slotId;
    uint8 public mode; // 0 = accept, 1 = revert, 2 = reenter withdraw,
                       // 3 = set its own withdraw gate mid-payout
    address public voteParent;
    address public votePayee;
    address public gate;

    constructor(address _splitter) {
        splitter = ISplitterImmutable(_splitter);
    }

    function setSlot(uint256 s) external { slotId = s; }
    function setMode(uint8 m) external { mode = m; }
    function setVote(address p, address n) external { voteParent = p; votePayee = n; }
    function setGate(address g) external { gate = g; }

    function pull(address token) external { splitter.withdraw(token, slotId); }
    function rotate(address to) external { splitter.rotateRecipient(to); }
    function vote() external { splitter.approveRotation(voteParent, votePayee); }

    receive() external payable {
        if (mode == 1) revert("nope");
        if (mode == 2) splitter.withdraw(address(0), slotId);
        if (mode == 3) splitter.setWithdrawCaller(gate);
    }
}

/// @notice A token whose balance can be cut out of band — stands in for the
///         rebasing-DOWN class the splitter explicitly does not support. Proves
///         `releasable` reports zero instead of underflowing and that the
///         withdraw clamp keeps the contract solvent.
/// @dev Moved here (renamed) from mocks/SplitterMaliciousTokens.sol, which was
///      removed with the mutable splitters. Renamed rather than copied so the
///      artifact name cannot collide if that file ever returns.
contract BurnableERC20Mock is ERC20 {
    constructor() ERC20("Burn", "BRN") {}

    function mint(address to, uint256 amount) external { _mint(to, amount); }
    function burn(address from, uint256 amount) external { _burn(from, amount); }
}

/// @notice A token that can be made to revert inside `balanceOf`, to prove one
///         broken token can only ever break its own withdraw and never ETH or
///         any other token.
/// @dev Same provenance and renaming rationale as BurnableERC20Mock above.
contract RevertingBalanceERC20Mock is ERC20 {
    bool public bricked;

    constructor() ERC20("Brick", "BRK") {}

    function mint(address to, uint256 amount) external { _mint(to, amount); }
    function setBricked(bool b) external { bricked = b; }

    function balanceOf(address account) public view override returns (uint256) {
        require(!bricked, "bricked balanceOf");
        return super.balanceOf(account);
    }
}
