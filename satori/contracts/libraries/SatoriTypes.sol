// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title SatoriTypes
 * @notice Shared types, structs, and interfaces used across all Satori contracts
 */
library SatoriTypes {
    // ========== Constants ==========

    /// @notice One-time airdrop ceiling, the TEST-SIDE mirror of
    ///         `SatoriToken.AIRDROP_TOTAL_SUPPLY`. The token's copy is the one
    ///         enforced (it caps `airdropMint`), and `SatoriAirdrop` reads it
    ///         from the token rather than from here; this constant exists so the
    ///         Foundry suites can size tables without a live token. MUST equal
    ///         the token's copy (pinned by test).
    /// PLACEHOLDER 1_200_000 (owner, 2026-09-11) — see the note on
    /// `SatoriToken.AIRDROP_TOTAL_SUPPLY`.
    uint256 constant AIRDROP_TOTAL_SUPPLY = 1_200_000 ether;

    /// @notice Length of one protocol round in seconds (single source of truth).
    ///         Currently 24 hours — one round boundary per UTC day, landing
    ///         at UTC midnight.
    /// @dev Referenced by SatoriRegistry.timeUnitSeconds (SatoriToken declares its own TIME_UNIT_SECONDS = 86400 literal — the immutable token does not import this library)
    ///      so the two contracts cannot drift apart. The Unix-epoch alignment
    ///      means rounds emerge naturally at multiples of TIME_UNIT_SECONDS
    ///      from epoch — no explicit boundary check anywhere.
    uint256 constant TIME_UNIT_SECONDS = 86400; // 24h rounds (phase 5; was 43200)

    /// @notice Constant 30-minute slack applied to the cadence-gap timestamp
    ///         guard in `setValue` / `updateValue`. Cadence-period minus this
    ///         slack is the wall-clock floor between successive updates.
    /// @dev Hoisted from SatoriRegistry.sol. Fixed at 30 minutes regardless
    ///      of `timeUnitSeconds` — the slack is "human grace before the
    ///      cadence anniversary," not "a fraction of a round." Under 24-hour
    ///      rounds with cadence=1, it gives 23.5 hours.
    uint256 constant CADENCE_GAP_SLACK_SECONDS = 1800;


    /// @notice Size of the per-stream value-history ring buffer.
    /// @dev Hoisted from SatoriRegistry.sol. Unit is *stream ticks* — the
    ///      buffer holds the last HISTORY_SIZE value updates regardless of
    ///      how long each takes. Bounds how far back `getFirstTwoValuesAfter`
    ///      can locate B and C (up to HISTORY_SIZE - 2 ticks may pass between
    ///      a prediction and its scoring). Predictions whose anchor rolls
    ///      out of this ring force-finalize as `PredictionUnrecoverable`.
    uint16 constant HISTORY_SIZE = 768; // 768 hourly entries (~32 days of reach; phase 6)

    // ========== Enums ==========

    enum DataStreamType {
        Simple,    // Provider pushes values via setValue()
        Adapter    // Any pull-based source via IStreamAdapter (Chainlink, Uniswap, Custom, ...)
    }

    // ========== DataStream Structures ==========

    /// @notice StreamMeta contains cold storage (infrequently accessed).
    /// @dev Streams are permanent once created — no `exists`/tombstone flag.
    ///      `streamExists(id)` is a bounds check (`streamId > 0 &&
    ///      streamId <= streams.length`); equivalent to a provider check
    ///      in practice because every create path rejects `provider == 0`.
    /// @dev `minCadenceMinutes` is set once at creation and never mutated. The
    ///      single static slot packs `provider` (20) + `streamType` (1) +
    ///      `minCadenceMinutes` (3) + `adapterId` (2)
    ///      = 26/32 bytes; `config` and `name` are dynamic.
    ///      Semantics: minimum minutes that must elapse between successive
    ///      value updates. Updates can come slower; they cannot come faster.
    ///      `adapterId` is 0 for Simple streams; for Adapter streams it indexes
    ///      `SatoriRegistry.adapter[]` for the contract that knows how to read
    ///      `provider` + `config`.
    /// @dev `provider` carries TWO senses depending on `streamType`:
    ///      - **Simple stream**: `provider` is the key-holding address that pushes
    ///        values via `setValue`, can rename the stream, and can transfer the
    ///        role via `setProvider`. Providers are NOT paid by the protocol —
    ///        publishing a stream earns nothing directly; the reward flows to the
    ///        predictors of the games built on it.
    ///      - **Adapter stream**: `provider` is the data-source contract address
    ///        the adapter reads from (Chainlink feed, Uniswap pool, or a
    ///        user-deployed `IDataStream` contract). It is not a key-holding
    ///        address; `setValue`, `setDataStreamName`, and `setProvider` all
    ///        revert for adapter streams (the data source has no private key).
    ///        `updateValue` is permissionless and unpaid.
    struct StreamMeta {
        address provider;           // 20: Simple = key-holding publisher; Adapter = data source contract
        uint8   streamType;         //  1: Type: Simple or Adapter
        uint24  minCadenceMinutes;  //  3: Minimum MINUTES between updates — a
                                    //     duration, so its meaning survives a
                                    //     round-length change (phase 5). uint24
                                    //     holds ~31 years. Guard bands in
                                    //     SatoriRegistry (design §6): below a
                                    //     round drifts on elapsed time alone;
                                    //     a round and above stays bound to the
                                    //     round + the 30-min early allowance.
        uint16  adapterId;          //  2: Adapter registry index; 0 for Simple
        bool    named;              //  1: Named stream (A_named_streams), set once at creation
        // 27/32 bytes used in slot 0; 5 bytes slack. This repack (2026-09-06,
        // phase 4) deleted the dead derivedBase field and BREAKS the storage
        // lineage: from here the branch is redeploy-only. Authority field removed; the
        // provider's address absorbs both the data-source role (adapter streams)
        // and the publisher-key role (simple streams). See `setProvider`.
        bytes   config;             // Adapter-specific extra bytes; empty for Simple
        string  name;               // Human-readable identifier
    }

    /// @notice ValueState contains hot storage (frequently updated)
    /// Stores last 3 values using circular buffer for efficient writes
    /// Only 3 storage writes per update instead of 6
    struct ValueState {
        int232[3] values;          // Circular buffer of values
        uint24[3] rounds;          // Circular buffer of round numbers
        uint8 currentIdx;          // Index of current value (0, 1, or 2)
        uint8 count;               // Number of values stored (0-3)
        uint64 lastUpdateTimestamp; // Actual block.timestamp of most recent setValue call
    }

    // ========== Voting System Structures ==========

    // ========== Prediction System Structures ==========

    /// @notice Prediction data structure — view-only return type for
    ///         `SatoriEngine.predictions(...)`. The underlying storage is the
    ///         packed `uint256` in `SatoriEngine.userPredictions[user][gameId]`
    ///         (see `docs/narratives/A_predictions.md`); `_viewPred`
    ///         decodes the packed slot into this struct for off-chain
    ///         consumers.
    /// @dev The stream value at prediction time is intentionally not stored.
    ///      Scoring (phase 6) derives everything at settle from the
    ///      prediction's HOUR, the stream's cadence and the game's target —
    ///      three bands: moment-anchored (anchor = last entry at or before the
    ///      prediction's hour, target = first entry at least the game's target
    ///      later), ABC (first two entries after the prediction's hour), and
    ///      next-sample for above-round cadences. Nothing per-prediction is
    ///      cached: cadence and target are immutable, so live reads can never
    ///      disagree with what was true at predict time. `roundMade` below is
    ///      the POOL round, derived as the stored hour / 24.
    struct Prediction {
        uint8   direction;          // 1 = UP, 2 = DOWN                     (1 byte)
        uint64  roundMade;          // Round the prediction was made on     (8 bytes)
        uint96  rawPredictionPower; // Per-game share of the user's prediction power (balance + unclaimed + delegated-in), split across the batch's eligible games (12 bytes)
        bool    scored;             // Has this been scored (real outcome)? (1 byte)
        bool    eligible;           // Stream was eligible (had votes) in `roundMade` (1 byte)
        uint48  multiplier;         // Streak-curve multiplier captured at predict time (6 bytes)
        // 29 bytes used; 3 bytes slack. Still fits in a single 32-byte slot.
        //
        // `multiplier` exists so the per-(user, stream, round, direction)
        // committed weight can be re-derived at score time without a
        // dedicated `userWeightByDirection` storage slot per prediction.
        // NB: this Prediction struct is a MEMORY view DTO — predictions are
        // stored PACKED in the `uint256 userPredictions` slot, NOT as this
        // struct — so this field width just mirrors the 48-bit packed
        // multiplier it decodes.
        // Capacity: uint48 ≈ 2.8e14 — one bit WIDER than the 47-bit packed
        // field (PR_MULT_BITS = 47), so the view never truncates (audit F27).
        // The streak curve is the rational S-curve `_streakWeight`, which
        // saturates far below the field's capacity over any realistic run of
        // zero-miss 24-hour rounds; the SatoriRewards write path
        // guards the packed field against PR_MULT_MASK with `MultiplierOverflow`,
        // and `_viewPred` now widens it to this uint48 field faithfully (was
        // uint32, which wrapped the VIEW for streak ≳ 6554 while on-chain
        // scoring stayed exact).
        //
        // uint96 caps rawPredictionPower at ~7.9 × 10^28 wei. Daily reward
        // budget is 1440 ether (= 1.44 × 10^21 wei). 7.9e28 / 1.44e21 ≈
        // 5.5 × 10^7 days of full-budget concentration in one user's
        // power. Centuries-safe at any realistic emission schedule.
        //
        // `eligible` is captured at predict time: predictions on games with
        // zero vote weight at predict time commit zero weight and earn nothing
        // from the round budget; a correct one can still collect a bounty share.
    }

    // The `Prediction` struct above is the return type from
    // `SatoriEngine.predictions(...)`, which decodes the packed `userPredictions`
    // uint256 slot into a struct for off-chain consumers. The on-chain
    // storage is the packed slot itself — 2 prediction sub-slots + uint16
    // streak header + flags in one storage slot. See
    // `docs/narratives/A_predictions.md`.

    /// @notice Batch prediction request structure used by the sole prediction
    ///         entry points `predictMultipleWithPayloads` / `predictMultipleWithReferral`.
    /// @dev `gameId` selects the game; the protocol resolves the underlying
    ///      `streamId` via `SatoriGames.gameDispatch(gameId)`. The first byte
    ///      of `payload` is the direction the protocol records on the
    ///      prediction slot (and what type-0 binary games consume). The full
    ///      payload (including the first byte) is forwarded to the adapter's
    ///      `record(...)` call for type-1+ games, so adapters can attach any
    ///      extra ABI-encoded data after the leading direction byte (scalar
    ///      value, distribution mass, struct, etc.). Type-0 and type-1+
    ///      games can be mixed freely in a single batch. A length-1 array
    ///      is the single-prediction case; a longer array is the batched
    ///      case. The dapp / SDK is expected to provide a convenience
    ///      wrapper that turns `(gameId, direction)` into a length-1 array.
    struct PredictionRequestWithPayload {
        uint32 gameId;
        bytes  payload;
    }

    /// @notice Prediction delegation info structure.
    /// @dev One storage slot. ownPower/delegatedPower drive the predictor/
    ///      delegator split and the per-round delegator-rate accumulator.
    ///      (Previously held a third `uint256 sumPower` slot for per-stream
    ///      rawPower; that's now stored inline on SatoriEngine's packed
    ///      `userPredictions` slot — see Side A of the rawPower-into-packed-
    ///      slot optimization. One cold SSTORE saved per prediction.)
    struct PredictionDelegationInfo {
        uint128 ownPower;           // Predictor's own balance used
        uint128 delegatedPower;     // Total delegated power used
    }

    // ------------------------------------------------------------------
    // Permit authorizations (Route A — docs/design/permit-entry-points.md)
    //
    // Memory-only DTOs carried in calldata. Neither is ever stored, so neither
    // touches any contract's storage layout.
    //
    // In BOTH, `deadline == 0` means "no permit supplied": the entry point then
    // relies on an existing allowance and behaves exactly as its non-permit
    // twin. That is what lets one function serve a token with permit, a token
    // without, and a caller who has already approved.
    // ------------------------------------------------------------------

    /// @notice A signed ERC-2612 authorization for a THIRD-PARTY token.
    /// @dev `(v, r, s)` because that is the only shape ERC-2612 defines, and an
    ///      arbitrary bounty-funding token implements the standard or nothing.
    struct TokenPermit {
        uint256 value;
        uint256 deadline;
        uint8   v;
        bytes32 r;
        bytes32 s;
    }

    /// @notice A signed authorization for SATORI itself.
    /// @dev An arbitrary-length `signature` rather than `(v, r, s)`, because
    ///      `SatoriToken` carries an ERC-1271 permit overload and smart accounts
    ///      do not produce 65-byte signatures: a Safe concatenates owner
    ///      signatures, a passkey carries authenticator data. The token routes
    ///      codeless signers to ECDSA, so an ordinary EOA's 65-byte signature
    ///      passes through this same field unchanged.
    struct SatoriPermit {
        uint256 value;
        uint256 deadline;
        bytes   signature;
    }

    /// @notice A signed authorization for the hub to execute one action as
    ///         `user`, with `fee` SATORI paid to `relayer` for the gas
    ///         (docs/design/gasless-relay.md). `data` is the abi-encoded
    ///         arguments of the action; EIP-712 hashes it, so the signature
    ///         commits to every parameter.
    struct RelayRequest {
        address user;
        uint8   action;   // SatoriHub.RelayAction
        bytes   data;
        uint256 fee;
        address relayer;
        uint256 nonce;
        uint256 deadline;
    }
}

// External oracle interfaces (IDataStream, AggregatorV3Interface, IUniswapV3Pool)
// live alongside their adapters in `contracts/adapters/`. The core library
// no longer depends on any specific oracle protocol.
