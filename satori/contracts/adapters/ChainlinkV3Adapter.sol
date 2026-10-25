// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../interfaces/IStreamAdapter.sol";
import "../interfaces/IStreamAdapterUIDescriptor.sol";

/**
 * @title ChainlinkV3Adapter
 * @notice Canonical adapter for Chainlink price feeds (AggregatorV3Interface).
 * @dev `answer` is NOT required to be positive — some legitimate feeds go
 *      negative (commodity spreads, oil 2020); the int232 bound is the only floor.
 */
interface AggregatorV3Interface {
    function latestRoundData() external view returns (
        uint80 roundId,
        int256 answer,
        uint256 startedAt,
        uint256 updatedAt,
        uint80 answeredInRound
    );
}

/// @dev UI-descriptor (`valueDisplay`) only; the core read path never calls these.
interface AggregatorV3MetadataInterface {
    function decimals() external view returns (uint8);
    function description() external view returns (string memory);
}

contract ChainlinkV3Adapter is IStreamAdapter, IStreamAdapterUIDescriptor {
    // Bounds on per-feed maxFeedAge: 60s covers the fastest heartbeats, 26h the
    // slowest long-tail feeds (24h heartbeat + slack). Tightening either breaks feeds.
    uint64 public constant MIN_FEED_AGE = 60;
    uint64 public constant MAX_FEED_AGE = 26 hours;

    /// Chainlink's L2 sequencer-uptime feed (zero where there is no sequencer).
    /// Immutable: a different feed means a new adapter id.
    address public immutable SEQUENCER_UPTIME_FEED;
    uint256 public constant SEQUENCER_GRACE_PERIOD = 1 hours;

    error InvalidFeed();
    error SequencerDown();
    error SequencerGracePeriod();
    error MaxFeedAgeOutOfRange();
    error RoundNotComplete();
    error Stale();
    error ValueOverflow();

    constructor(address sequencerUptimeFeed) {
        SEQUENCER_UPTIME_FEED = sequencerUptimeFeed;
    }

    function readValue(address target, bytes calldata config)
        external view override returns (int232)
    {
        if (SEQUENCER_UPTIME_FEED != address(0)) {
            (, int256 down, uint256 startedAt, , ) = AggregatorV3Interface(SEQUENCER_UPTIME_FEED).latestRoundData();
            if (down != 0) revert SequencerDown();
            if (startedAt == 0 || block.timestamp - startedAt <= SEQUENCER_GRACE_PERIOD) revert SequencerGracePeriod();
        }
        uint64 maxFeedAge = abi.decode(config, (uint64));
        // answeredInRound / roundId intentionally ignored (audit F49): Chainlink
        // deprecated answeredInRound (many feeds return 0), so gating on it would
        // freeze those feeds. `updatedAt` freshness below guards staleness.
        (, int256 answer, , uint256 updatedAt, )
            = AggregatorV3Interface(target).latestRoundData();
        if (updatedAt == 0) revert RoundNotComplete();
        if (block.timestamp - updatedAt > maxFeedAge) revert Stale();
        if (answer < type(int232).min || answer > type(int232).max) revert ValueOverflow();
        return int232(answer);
    }

    function validate(address target, bytes calldata config)
        external view override
    {
        if (target == address(0)) revert InvalidFeed();
        uint64 maxFeedAge = abi.decode(config, (uint64));
        if (maxFeedAge < MIN_FEED_AGE || maxFeedAge > MAX_FEED_AGE) revert MaxFeedAgeOutOfRange();
        // Probe — confirms the target responds to the v3 interface.
        AggregatorV3Interface(target).latestRoundData();
    }

    // IStreamAdapterUIDescriptor: view-only, never called by core/registry.

    /// @inheritdoc IStreamAdapterUIDescriptor
    function uiSchemaVersion() external pure override returns (uint16) {
        return 1;
    }

    /// @inheritdoc IStreamAdapterUIDescriptor
    function configSchema() external pure override returns (string memory) {
        return '{"version":1,"fields":[{"key":"maxFeedAge","label":"Max feed age (seconds)","type":"uint64","min":"60","max":"93600","help":"Reject the Chainlink answer if older than this. 60s-26h."}]}';
    }

    /// @inheritdoc IStreamAdapterUIDescriptor
    /// @dev MUST NOT revert: each probe has a fallback.
    function valueDisplay(address target, bytes calldata /* config */)
        external view override returns (uint8 decimals, string memory unit, string memory label)
    {
        unit = "";
        // A high-level external call to a codeless address (EOA / dead address)
        // reverts in THIS frame via Solidity's extcodesize guard, which a
        // try/catch on the callee CANNOT catch. Short-circuit to the fallback
        // so valueDisplay never reverts. Once code exists, try/catch handles a
        // non-conforming aggregator (revert, short/garbage returndata).
        if (target.code.length == 0) {
            return (8, "", "Chainlink feed");
        }
        try AggregatorV3MetadataInterface(target).decimals() returns (uint8 d) {
            decimals = d;
        } catch {
            decimals = 8;
        }
        try AggregatorV3MetadataInterface(target).description() returns (string memory desc) {
            label = desc;
        } catch {
            label = "Chainlink feed";
        }
    }
}
