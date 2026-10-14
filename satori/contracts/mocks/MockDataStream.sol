// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// Mock Custom DataStream contract for testing
contract MockDataStream {
    int256 public value;

    function setValue(int256 _value) external {
        value = _value;
    }

    function getValue() external view returns (int256) {
        return value;
    }
}

// Mock Chainlink AggregatorV3Interface for testing.
// Defaults to a healthy round: answer = 0, roundId/answeredInRound = 1,
// updatedAt = block.timestamp at first read (advance via setRoundData).
// Stale/carried-forward/zero-updated cases are testable via setRoundData.
contract MockChainlinkAggregator {
    int256  public answer;
    uint80  public roundId           = 1;
    uint80  public answeredInRound   = 1;
    uint256 public updatedAt;
    uint256 public startedAt;

    // Optional UI metadata (decimals/description) — additive, only read by the
    // OPTIONAL IStreamAdapterUIDescriptor.valueDisplay path. Defaults mirror a
    // common USD price feed (8 decimals).
    uint8  private _decimals    = 8;
    string private _description = "ETH / USD";

    constructor() {
        updatedAt = block.timestamp;
        startedAt = block.timestamp;
    }

    function setMetadata(uint8 d, string calldata desc) external {
        _decimals = d;
        _description = desc;
    }

    function decimals() external view returns (uint8) {
        return _decimals;
    }

    function description() external view returns (string memory) {
        return _description;
    }

    /// Test helper for the common "happy round" update path.
    function setAnswer(int256 _answer) external {
        answer = _answer;
        roundId++;
        answeredInRound = roundId;
        updatedAt = block.timestamp;
        startedAt = block.timestamp;
    }

    /// Full-control setter for staleness / carried-forward / unfinished-round tests.
    function setRoundData(
        uint80  _roundId,
        int256  _answer,
        uint256 _startedAt,
        uint256 _updatedAt,
        uint80  _answeredInRound
    ) external {
        roundId         = _roundId;
        answer          = _answer;
        startedAt       = _startedAt;
        updatedAt       = _updatedAt;
        answeredInRound = _answeredInRound;
    }

    function latestRoundData() external view returns (
        uint80, int256, uint256, uint256, uint80
    ) {
        return (roundId, answer, startedAt, updatedAt, answeredInRound);
    }
}

// Mock Uniswap V3 Pool whose `observe` reverts — exercises the natural
// failure mode at create / updateValue when a pool's cardinality is
// insufficient to serve the requested window. The other adapter checks
// (fee tier, age) are satisfied so observe is the only failing path.
contract RevertingUniswapV3Pool {
    function observe(uint32[] calldata /*secondsAgos*/)
        external pure
        returns (int56[] memory, uint160[] memory)
    {
        revert("OLD");
    }

    function fee() external pure returns (uint24) { return 3000; }

    function slot0() external pure returns (
        uint160, int24, uint16, uint16, uint16, uint8, bool
    ) {
        // Cardinality must clear UniswapV3Adapter.requiredCardinality for the
        // default window (1800/1 = 1800) so this pool reaches the `observe`
        // probe, which is the rejection this mock exists to exercise. At 100 it
        // would be refused for capacity first and the probe would never run.
        return (0, 0, 0, 1800, 1800, 0, true);
    }

    function observations(uint256) external view returns (
        uint32 blockTimestamp,
        int56,
        uint160,
        bool initialized
    ) {
        // Pretend the oldest observation is 2 days old so the adapter's
        // age check passes and the failure surfaces in the observe probe.
        return (uint32(block.timestamp > 2 days ? block.timestamp - 2 days : 1), 0, 0, true);
    }
}

// Mock Uniswap V3 Pool for testing.
// Defaults to a healthy adapter-passable state: 0.3% fee tier, an observation
// ring large enough for the adapter's requiredCardinality, and an oldest
// observation timestamp of construction time - 2 days (well past the 1-day
// minimum). Tests override via the setter helpers.
contract MockUniswapV3Pool {
    int56  public tickCumulative0;
    int56  public tickCumulative1;
    uint24 private _feeTier         = 3000;
    uint16 private _obsIndex        = 0;
    // Must be >= UniswapV3Adapter.requiredCardinality(DEFAULT_TWAP_WINDOW)
    // (1800/1 = 1800), or every stream creation in the suite reverts
    // InsufficientCardinality. Was 100, which predates that check.
    uint16 private _cardinality     = 1800;
    uint32 private _oldestTimestamp;
    bool   private _oldestInitialized = true;

    constructor() {
        // Stamp oldest observation as 2 days ago so the adapter's 1-day
        // pool-age check passes by default. Tests can override via
        // setOldestObservation for the "too young" cases.
        _oldestTimestamp = uint32(block.timestamp > 2 days ? block.timestamp - 2 days : 1);
    }

    function setTickCumulatives(int56 _tick0, int56 _tick1) external {
        tickCumulative0 = _tick0;
        tickCumulative1 = _tick1;
    }

    function setFee(uint24 newFee) external { _feeTier = newFee; }

    function setOldestObservation(uint32 timestamp, bool initialized) external {
        _oldestTimestamp = timestamp;
        _oldestInitialized = initialized;
    }

    function setCardinality(uint16 cardinality, uint16 obsIndex) external {
        _cardinality = cardinality;
        _obsIndex = obsIndex;
    }

    function observe(uint32[] calldata /* secondsAgos */)
        external view
        returns (int56[] memory tickCumulatives, uint160[] memory secondsPerLiquidityCumulativeX128s) {

        tickCumulatives = new int56[](2);
        secondsPerLiquidityCumulativeX128s = new uint160[](2);
        tickCumulatives[0] = tickCumulative0;
        tickCumulatives[1] = tickCumulative1;
    }

    function fee() external view returns (uint24) { return _feeTier; }

    function slot0() external view returns (
        uint160 sqrtPriceX96,
        int24 tick,
        uint16 observationIndex,
        uint16 observationCardinality,
        uint16 observationCardinalityNext,
        uint8 feeProtocol,
        bool unlocked
    ) {
        // Only observationIndex and observationCardinality are read by the
        // adapter; other fields can stay zero.
        return (0, 0, _obsIndex, _cardinality, _cardinality, 0, true);
    }

    function observations(uint256 index) external view returns (
        uint32 blockTimestamp,
        int56 tickCumulative,
        uint160 secondsPerLiquidityCumulativeX128,
        bool initialized
    ) {
        // Both the "oldest" slot the adapter looks at first and the
        // fallback index-0 slot return the same controllable timestamp.
        // Real V3 pools have a richer ring; the adapter only reads the
        // oldest, so this is sufficient.
        index; // silence unused-parameter warning
        return (_oldestTimestamp, 0, 0, _oldestInitialized);
    }
}