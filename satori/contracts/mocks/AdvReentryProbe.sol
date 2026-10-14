// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "../interfaces/IPredictionGame.sol";
import "../interfaces/ISatoriCore.sol";

interface IReentryHook {
    function onReenter() external;
}

/// @notice Adversarial ERC20 whose transfer/transferFrom fire a one-shot
///         attacker callback. Weaponizes cross-contract reentrancy through the
///         SatoriBounties fund/stake/unstake/withdraw ERC20 legs.
contract ReentrantBountyToken is ERC20 {
    IReentryHook public hook;
    bool public armed;

    constructor(string memory n, string memory s) ERC20(n, s) {}

    function mint(address to, uint256 amount) external { _mint(to, amount); }
    function setHook(address h) external { hook = IReentryHook(h); }
    function arm() external { armed = true; }

    function _update(address from, address to, uint256 value) internal override {
        super._update(from, to, value);
        if (armed && from != address(0) && to != address(0) && address(hook) != address(0)) {
            armed = false;
            hook.onReenter();
        }
    }
}

/// @notice Generic attacker hook: on onReenter() it makes ONE low-level call to
///         a preconfigured (target, calldata) and records success + returndata,
///         WITHOUT reverting the outer flow (so the test can observe whether the
///         reentry was blocked by a guard or actually executed).
contract BountyReenterHook is IReentryHook {
    address public target;
    bytes   public data;
    bool    public lastOk;
    bytes   public lastReturn;
    bool    public fired;

    function set(address t, bytes calldata d) external { target = t; data = d; }

    function onReenter() external override {
        fired = true;
        (bool ok, bytes memory ret) = target.call(data);
        lastOk = ok;
        lastReturn = ret;
        // deliberately swallow — do not revert the outer bounty leg.
    }
}

/// @notice Adversarial adapter that reenters on the FIRST record() call (predict
///         path), probing whether the predict entry point's nonReentrant guard
///         covers the record() callback the same way H4 covered score().
contract RecordReentrantAdapter is IPredictionGame {
    address public immutable core;
    bool public armed;
    bool public inReenter;
    address public reenterTarget; // contract to call during record()
    bytes  public reenterData;
    bool   public swallow;        // if true, do NOT bubble the reenter revert
    bool   public lastOk;
    bytes  public lastReturn;

    mapping(uint32 => mapping(address => uint64))  public pendingRound;
    mapping(uint32 => mapping(address => uint256)) public pendingWeight;

    constructor(address _core) { core = _core; }

    function arm(address t, bytes calldata d) external { armed = true; reenterTarget = t; reenterData = d; }
    function armSwallow(address t, bytes calldata d) external { armed = true; swallow = true; reenterTarget = t; reenterData = d; }

    function validateForStream(uint32, bytes calldata) external pure override {}

    function record(address user, uint32 gameId, uint256 predictionPower, uint256, bytes calldata)
        external override
    {
        require(msg.sender == core, "only core");
        pendingWeight[gameId][user] = predictionPower;
        pendingRound[gameId][user] = uint64(ISatoriCore(core).getCurrentRound());
        if (armed && !inReenter) {
            inReenter = true;
            (bool ok, bytes memory ret) = reenterTarget.call(reenterData);
            inReenter = false;
            lastOk = ok;
            lastReturn = ret;
            // Bubble up so the test sees the revert reason if the guard fires,
            // UNLESS swallow mode is on (then record + continue).
            if (!ok && !swallow) {
                assembly { revert(add(ret, 0x20), mload(ret)) }
            }
        }
    }

    function score(address user, uint32 gameId)
        external override returns (bool scored, uint256 userScore, uint256 multiplier, uint256 total, uint256 bountyTotal, uint64 roundIndex)
    {
        require(msg.sender == core, "only core");
        uint64 r = pendingRound[gameId][user];
        if (r == 0) return (false, 0, 0, 0, 0, 0);
        uint64 cur = uint64(ISatoriCore(core).getCurrentRound());
        if (cur <= r) return (false, 0, 0, 0, 0, 0);
        uint256 w = pendingWeight[gameId][user];
        delete pendingRound[gameId][user];
        delete pendingWeight[gameId][user];
        return (true, w, 1, w, w, r);
    }
}
