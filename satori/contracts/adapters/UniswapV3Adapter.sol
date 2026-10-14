// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../interfaces/IStreamAdapter.sol";
import "../interfaces/IStreamAdapterUIDescriptor.sol";

/**
 * @title UniswapV3Adapter
 * @notice Canonical adapter for Uniswap V3 pool TWAP feeds.
 * @dev Stores the raw TWAP tick, not a price: price is 1.0001^tick, monotonic,
 *      so direction (all scoring needs) is preserved. Ticks are in
 *      [-887272, 887272], within int128.
 */
interface IUniswapV3Pool {
    function observe(uint32[] calldata secondsAgos)
        external view
        returns (
            int56[] memory tickCumulatives,
            uint160[] memory secondsPerLiquidityCumulativeX128s
        );

    /// @notice Fee tier in hundredths of a bip (3000 = 0.3%).
    function fee() external view returns (uint24);

    function slot0() external view returns (
        uint160 sqrtPriceX96,
        int24 tick,
        uint16 observationIndex,
        uint16 observationCardinality,
        uint16 observationCardinalityNext,
        uint8 feeProtocol,
        bool unlocked
    );

    function observations(uint256 index) external view returns (
        uint32 blockTimestamp,
        int56 tickCumulative,
        uint160 secondsPerLiquidityCumulativeX128,
        bool initialized
    );
}

contract UniswapV3Adapter is IStreamAdapter, IStreamAdapterUIDescriptor {
    /// @notice TWAP window when a stream supplies no config; per-stream via a
    ///         uint32 of seconds in `config`.
    uint32 public constant DEFAULT_TWAP_WINDOW = 30 minutes;

    /// @notice Floor on a configured window. Below ~this a TWAP buys little: it
    ///         resists manipulation only because an attacker must hold a false
    ///         price for a real share of the window (15 min ≈ 450 Base blocks).
    uint32 public constant MIN_TWAP_WINDOW = 15 minutes;

    // NO CEILING on the window, deliberately: `requiredCardinality` already
    // limits it honestly (cardinality is uint16, so ~18.2h of guaranteed reach),
    // and a policy ceiling would only forbid the legitimate deep-ring case.

    /// @notice Shortest gap between two observations, in seconds.
    /// @dev ONE — a structural fact about Uniswap V3, not a block-time
    ///      assumption: observation timestamps are uint32 seconds and
    ///      `Oracle.write` early-returns when the new timestamp equals the last,
    ///      so a pool records at most one observation per second at any block
    ///      speed. Do NOT re-derive from block time — that made an earlier
    ///      version silently halve coverage if the chain shortened its blocks.
    uint32 public constant MIN_OBSERVATION_INTERVAL = 1;

    /// @notice Observation-ring size a pool must already have to guarantee
    ///         `window` FOREVER (worst case: one observation per second).
    /// @dev `validate`'s `observe` probe only proves the pool can serve the
    ///      window right now; a pool can silently lose that later by getting
    ///      busier. This is the durable guarantee. Growing the ring is
    ///      permissionless via `increaseObservationCardinalityNext`.
    function requiredCardinality(uint32 window) public pure returns (uint256) {
        return uint256(window) / uint256(MIN_OBSERVATION_INTERVAL);
    }

    /// @notice The window a stream will actually use: its config, or the default.
    /// @dev Central so `readValue` and `validate` cannot disagree — a divergence
    ///      would validate one window and read another.
    function windowOf(bytes calldata config) public pure returns (uint32) {
        if (config.length == 0) return DEFAULT_TWAP_WINDOW;
        return abi.decode(config, (uint32));
    }

    /// @notice Minimum pool age before a stream can use it. Defense against
    ///         wash-bootstrap: a freshly-deployed pool seeded with manipulated
    ///         observations must age this long first.
    uint32 public constant MIN_POOL_AGE = 1 days;

    error InvalidPool();
    error PoolNotReady();
    /// @dev Tier 100 (0.01%) is included on purpose: it hosts the deepest Base
    ///      stablecoin pools (audit F50). Non-canonical tiers stay rejected.
    error BadFeeTier();
    error PoolTooYoung();
    /// @dev `need` is uint32, not uint16: it can legitimately exceed a pool's max
    ///      cardinality (that is how an over-long window is refused), and
    ///      truncating would under-report and misdirect the caller.
    error InsufficientCardinality(uint16 have, uint32 need);
    error TwapWindowTooShort();

    function readValue(address target, bytes calldata config)
        external view override returns (int232)
    {
        uint32 twapWindow = windowOf(config);
        uint32[] memory secondsAgos = new uint32[](2);
        secondsAgos[0] = twapWindow;
        secondsAgos[1] = 0;
        (int56[] memory tickCumulatives,) = IUniswapV3Pool(target).observe(secondsAgos);
        int56 tickCumulativeDelta = tickCumulatives[1] - tickCumulatives[0];
        int56 window = int56(uint56(twapWindow));
        int56 meanTick = tickCumulativeDelta / window;
        // Floor toward -inf to match canonical Uniswap OracleLibrary.consult:
        // integer division truncates toward zero, so a NEGATIVE delta with a
        // nonzero remainder rounds the mean tick UP by one. Decrement to get the
        // true arithmetic-mean tick (off-by-one only on negative ticks).
        if (tickCumulativeDelta < 0 && tickCumulativeDelta % window != 0) {
            meanTick--;
        }
        return int232(int24(meanTick));
    }

    function validate(address target, bytes calldata config)
        external view override
    {
        // Bounds before touching the pool, so a bad config can't look like a bad pool.
        uint32 twapWindow = windowOf(config);
        if (twapWindow < MIN_TWAP_WINDOW) revert TwapWindowTooShort();
        if (target == address(0)) revert InvalidPool();
        IUniswapV3Pool pool = IUniswapV3Pool(target);

        uint24 feeTier = pool.fee();
        if (feeTier != 100 && feeTier != 500 && feeTier != 3000 && feeTier != 10000) revert BadFeeTier();

        (, , uint16 obsIndex, uint16 cardinality, , , ) = pool.slot0();
        if (cardinality == 0) revert PoolNotReady();

        // Capacity, not just today's reachability: without this a stream
        // validates now and silently stops months later as the pool gets busy.
        uint256 need = requiredCardinality(twapWindow);
        if (uint256(cardinality) < need) {
            revert InsufficientCardinality(cardinality, uint32(need));
        }
        uint16 oldestIdx = uint16((uint256(obsIndex) + 1) % uint256(cardinality));
        (uint32 oldestTs, , , bool initialized) = pool.observations(oldestIdx);
        if (!initialized) {
            // Ring not full yet — index 0 is the oldest.
            (oldestTs, , , ) = pool.observations(0);
        }
        if (block.timestamp - uint256(oldestTs) < uint256(MIN_POOL_AGE)) revert PoolTooYoung();

        uint32[] memory secondsAgos = new uint32[](2);
        secondsAgos[0] = twapWindow;
        secondsAgos[1] = 0;
        try pool.observe(secondsAgos) {
        } catch {
            revert PoolNotReady();
        }
    }

    // IStreamAdapterUIDescriptor: view-only, never called by core/registry.

    /// @inheritdoc IStreamAdapterUIDescriptor
    function uiSchemaVersion() external pure override returns (uint16) {
        return 1;
    }

    /// @inheritdoc IStreamAdapterUIDescriptor
    function configSchema() external pure override returns (string memory) {
        return '{"version":1,"fields":[{"key":"twapWindow","label":"TWAP window (seconds)","type":"uint32","min":"900","max":"65535","optional":true,"default":"1800","help":"Averaging window. Longer resists price manipulation better but needs a deeper pool observation ring. Minimum 15m, default 30m; the maximum is whatever ring the pool actually has."}]}';
    }

    /// @inheritdoc IStreamAdapterUIDescriptor
    function valueDisplay(address /* target */, bytes calldata /* config */)
        external pure override returns (uint8 decimals, string memory unit, string memory label)
    {
        return (0, "tick", "Uniswap V3 TWAP tick");
    }
}
