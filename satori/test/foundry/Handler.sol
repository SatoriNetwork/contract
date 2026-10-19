// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import {VmSafe} from "forge-std/Vm.sol";
import "../../contracts/next/SatoriToken.sol";
import {SatoriEngine} from "../../contracts/next/SatoriEngine.sol";
import "../../contracts/next/SatoriProxy.sol";
import "../../contracts/next/SatoriHub.sol";
import "../../contracts/SatoriRegistry.sol";
import "../../contracts/SatoriVoting.sol";
import "../../contracts/SatoriRewards.sol";
import "../../contracts/SatoriBounties.sol";
import "../../contracts/SatoriGames.sol";
import "../../contracts/SatoriRewardsLens.sol";
import "../../contracts/libraries/SatoriTypes.sol";
import "../../contracts/adapters/CustomAdapter.sol";
import "../../contracts/mocks/YesNoGame.sol";
import "../../contracts/mocks/EveryoneWinsGame.sol";
import "../../contracts/mocks/ReentrantGameAdapter.sol";
import "../../contracts/mocks/MockDataStream.sol";
import "../../contracts/mocks/MockERC20.sol";

/**
 * @title Handler — call-surface for invariant fuzzing.
 * @notice Foundry's invariant runner picks random functions on this contract
 *         and supplies random args. We translate those into real contract
 *         calls and maintain "ghost" book-keeping the invariant assertions
 *         compare against contract state.
 *
 *         Bounded actor set (5 sim users) keeps the state space small enough
 *         to actually exercise multi-user cases without exploding combinatorics.
 *         All admin-only setup (setSatoriCore, initializeDefaultStream, adapter
 *         registration) happens once in the constructor, never via fuzzing.
 */
contract Handler is Test {
    // Split stack: `satori` is the HUB (the ISatoriCore facade + fee sink — the
    // split's equivalent of the monolith's core address, so handler.satori()
    // keeps resolving to "the core" for the invariant suite). `token` is the
    // immutable ERC20 + round clock; `engine` is the prediction state/logic
    // (behind a proxy). Route ERC20 ops to `token`, predict/settle to `engine`,
    // everything else to `satori` (the hub).
    SatoriHub public satori;
    SatoriToken public satoriToken;
    SatoriEngine public engine;
    SatoriRegistry public registry;
    SatoriVoting public voting;
    SatoriRewards public rewards;
    SatoriBounties public bounties;
    SatoriGames public games;
    /// @notice Computed-view lens hosting the per-(game,round,direction)
    ///         weight getters (userWeightByDirection / totalWeightByDirection)
    ///         that moved off SatoriRewards into SatoriRewardsLens for EIP-170
    ///         headroom. The Rewards INV-R4 weight-conservation invariant
    ///         reads through this.
    SatoriRewardsLens public lens;
    CustomAdapter public customAdapter;
    MockDataStream public mockStream;
    MockERC20 public bountyToken;
    MockERC20 public bountyTokenB;

    // ===== Adapter games (Phase 2) =====
    // Real shipped adapter (score/total accuracy game) + two hostile mocks the
    // fuzzer can register + play, since game-adapter registration is
    // permissionless. All three are wired into adapter games on the Adapter
    // data stream (stream 2). Game IDs are assigned at create time; the
    // Handler records them so the fuzz surface + invariants can enumerate them.
    YesNoGame public yesNoGame;
    EveryoneWinsGame public everyoneWinsGame;
    ReentrantGameAdapter public reentrantGame;

    // gameTypeIds assigned by registerGameAdapter (1+; 0 is the inline binary).
    uint16 public yesNoTypeId;
    uint16 public everyoneWinsTypeId;
    uint16 public reentrantTypeId;

    // The adapter game IDs (created on stream 2). Enumerated by the adapter
    // conservation invariants. Game IDs 1,2 are the auto-created binary games;
    // these are 3,4,5.
    uint32[] public adapterGameIds;
    mapping(uint32 => bool) public isAdapterGame;
    // The data stream every adapter game points at (stream 2 == mockStream).
    /// The adapter stream's id, CAPTURED from `createAdapterDataStream` rather
    /// than assumed.
    ///
    /// This was `constant = 2` and had silently become wrong when genesis
    /// created extra streams ahead of it (the since-deleted derived family at
    /// ids 2..4): every adapter game was built on the wrong stream, its votes
    /// reverted and were swallowed, and `AdapterSanity` failed its real
    /// assertion for months. Genesis is a single stream now, but the lesson is
    /// the id, not the number:
    ///
    /// Exactly the same defect as the hardcoded game id that §2 of
    /// docs/issues/closed/foundry-suite-silently-dead-since-burn-vote-migration.md fixed,
    /// one level up. Derive it; do not assume creation order.
    uint32 public adapterStreamId;

    // Ghost: SATORI credited per (adapterGameId, predictionRound). Mirror of
    // run.js's `creditByGameRound` backstop — under the score/total pin+cap the
    // most an adapter game can mint per round is exactly ONE pool (<= one round
    // budget), so this must never exceed ROUND_REWARD_BUDGET. Accumulated by
    // measuring the user's unclaimedRewards delta across each adapter score.
    mapping(uint32 => mapping(uint256 => uint256)) public ghostAdapterSatoriCredited;
    // Ghost: bounty token credited per (adapterGameId, predictionRound, token):
    // predictor auto-restake + fee-recipient accrual delta across each adapter
    // score. Must never exceed the round's dripped pot (roundBountyPot) for that
    // (game, round, token) — the pin+cap conservation on the adapter bounty rail.
    mapping(uint32 => mapping(uint256 => mapping(address => uint256))) public ghostAdapterBountyCredited;
    // Track (game,round) pairs that have received any adapter credit so the
    // invariant can iterate a bounded recent set without scanning all history.
    uint32[] public creditedGameRoundGames;
    uint256[] public creditedGameRoundRounds;
    mapping(uint32 => mapping(uint256 => bool)) internal _creditedSeen;

    // Pending adapter prediction round per (user, gameId), so settle can
    // attribute the credit delta to the round the prediction was MADE in
    // (not the round it settles in). 0 = none.
    mapping(address => mapping(uint32 => uint256)) public adapterPendingRound;

    uint256 public callCount_adapterPredict;
    uint256 public callCount_adapterSettle;
    uint256 public callCount_updateAdapterValue;
    uint256 public callCount_registerCommunityAdapter;

    address public deployer;
    address[5] public actors;

    // Ghost: total amount funded into the bounty pool across all funding
    // calls. The Bounty conservation invariant compares this against
    // `pool + Σ roundBountyPot + Σ unclaimedBounty` to make sure no
    // tokens were minted, lost, or double-counted internally. Keyed by
    // (streamId, tokenAddress) so the second bounty token is tracked
    // independently from the first.
    mapping(uint32 => mapping(address => uint256)) public ghostBountyFunded;
    // Stake side: parallel ghost. `stakeBountyToken` pulls tokens INTO the
    // rewards contract under a different bucket (`bountyStake[user][T]`),
    // not through pool/pots. Tracking it separately lets the conservation
    // invariant distinguish "funded for bounty" vs "staked for boost".
    mapping(address => uint256) public ghostBountyStaked;
    mapping(address => uint256) public ghostBountyUnstaked;

    // Track every address that has ever held tokens — the per-address sum
    // domain for the invariants that still walk holders (pending rewards,
    // prediction-delegation conservation, bounty solvency). It is NO LONGER the
    // domain of a voting-power sum: burn voting has no per-holder weight to add
    // up, so that law moved to the global supply identity in Conservation INV-1.
    address[] public touchedAddresses;
    mapping(address => bool) public addressTouched;

    // Ghost: track which stream IDs have been created.
    uint32[] public createdStreams;

    // Ghost: every SATORI wei destroyed by a successful `vote`. Voting is the
    // only burn this handler ever drives, and the only one the PROTOCOL drives:
    // `token.burnFrom` is reached from exactly one place, `SatoriHub.vote`, and
    // `crosschainBurn` is unreachable because it demands msg.sender ==
    // SUPERCHAIN_BRIDGE, the hardcoded OP predeploy, and no fuzz sender is ever
    // pranked to that address. SatoriToken also inherits
    // ERC20Burnable's permissionless `burn(uint256)` self-burn, which no fuzz
    // action calls — if one is ever added it MUST add to this ghost too, or
    // Conservation INV-1 will report a phantom shortfall.
    //
    // The fee "burns" (streamBurn / gameBurn / bountyBurn) are misnomers: they
    // transferFrom into the hub sink, which is a touched address, and do not
    // move totalSupply at all.
    //
    // This is what replaced `Σ getVotingPower == totalSupply` as the suite's
    // supply-conservation anchor. Weight is no longer a view over the supply, so
    // the accounting identity is now
    //     totalSupply + ghostBurned == totalRewardsMinted + airdropMinted
    // (Conservation INV-1). We record the INTENDED burn amount, not a measured
    // totalSupply delta, so the invariant genuinely tests that a vote destroys
    // exactly `amount` — a measured delta would tautologically agree.
    uint256 public ghostBurned;

    // Ghost: (gameId, round) pairs a prediction was actually placed on. The
    // FIRST predictor of a game in a round is the sole writer of that round's
    // numerator (`gameVotesAtRound`) and denominator (`roundVoteTotal`), and the
    // only other door into `recordGameVotesForRound` is
    // the removed `SatoriHub.recordOffchainGameVotes`, which was rewards-gated and needs an
    // off-chain game type — none is registered here. So the round's participant
    // list must be a subset of this ghost, and Conservation INV-2b asserts
    // exactly that: a game that shows up in `getEligibleGamesAtRound(r)` without
    // having been predicted in r means something else learned to write the
    // reward numerator.
    mapping(uint32 => mapping(uint256 => bool)) public ghostPredicted;

    // Binary games on 2-hour streams this handler writes: the band where an
    // UP and a DOWN of one round can both win, and where a round's values can
    // all land inside it. splitGameId is approved, so votes give it a SATORI
    // slice; bountyGameId is never approved, so it stays unweighted and only
    // pays bounties. Created after the adapter games, so ids 3-5 hold.
    uint32 public splitStreamId;
    uint32 public splitGameId;
    uint32 public bountyStreamId;
    uint32 public bountyGameId;
    uint256 public lastSplitRound;
    uint256 internal _roundBudgetSlot;

    // Ghost: SATORI credited per (binary game, prediction round) and per
    // round, from RewardSplit. Rewards credits a game-round at most its slice.
    mapping(uint32 => mapping(uint256 => uint256)) public ghostBinaryCredited;
    mapping(uint32 => mapping(uint256 => uint256)) public ghostBinaryCreditCount;
    mapping(uint256 => uint256) public ghostRoundCredited;
    mapping(uint32 => mapping(uint256 => bool)) internal _binaryCreditSeen;
    uint32[] internal _binaryCreditGames;
    uint256[] internal _binaryCreditRounds;

    // Ghost: predictions scored inside their own round. The engine leaves a
    // prediction pending until its round ends, so this stays 0. Counted from
    // PredictionScored at the end of an action, which misses a score in an
    // action that then crosses midnight, so splitRoundScenario also checks
    // its in-round settles directly.
    uint256 public ghostScoredInOwnRound;
    bytes32 internal constant PREDICTION_SCORED = keccak256("PredictionScored(address,uint32,uint256,bool,uint256,uint256)");

    // Counters for shrinking failure analysis.
    uint256 public callCount_transfer;
    uint256 public callCount_vote;
    /// Successes only — proves this action is not the no-op it used to be.
    uint256 public callCount_voteAdapterStreamGame;
    uint256 public callCount_predict;
    uint256 public callCount_splitWrite;
    uint256 public callCount_splitScenario;
    uint256 public callCount_delegate;
    uint256 public callCount_undelegate;
    uint256 public callCount_claim;
    uint256 public callCount_fundBounty;
    uint256 public callCount_setReferral;
    uint256 public callCount_delegateClaim;

    // ===== Emission schedule =====
    address public constant MERKLE = address(0x4E4B1E);
    bytes32 internal constant REWARD_SPLIT = keccak256("RewardSplit(address,uint32,uint256,uint256,uint256,uint256)");

    /// Mirror of `satori.emission().issued`: genesis, plus every `noteIssued`
    /// argument rewards sends, plus every positive write to
    /// `merkleReserveCumulative`, each grossed up by the dev fee separately.
    uint256 public ghostIssued;
    /// RewardSplit events with no matching `noteIssued(u + d·[W≠0])` call.
    uint256 public ghostSplitMismatch;
    uint256 public ghostSplitsMatched;
    uint256 public ghostSplitsWithDelegatorShare;
    uint256 public ghostNoteIssuedCalls;
    uint256 public ghostReserveBanks;

    uint256 public callCount_setEmissionRatio;
    uint256 public callCount_syncEmission;
    uint256 public callCount_bumpIssued;
    uint256 public callCount_setOffchainBudget;
    uint256 public callCount_merkleMint;

    bytes32 internal _reserveCumulativeSlot;
    uint256 internal _roundWeightSnapshotSlot;

    /// Wraps every action: `issued` can move on any path that reaches the hub
    /// (scoring, claims, dial changes, transfers' delegation sync), so an
    /// untracked action would show up as ghost drift.
    modifier trackIssued() {
        vm.recordLogs();
        vm.startStateDiffRecording();
        _;
        _ghostIssued(vm.stopAndReturnStateDiff(), vm.getRecordedLogs());
    }

    constructor() {
        deployer = address(this);

        // Warp past the genesis edge so getCurrentRound() > 0. The ERC20
        // lock check `transferLockedUntil[from] >= getCurrentRound()` is trivially
        // true when both sides are 0 — every transfer would revert.
        vm.warp(43200 * 10); // round 10

        // Fee recipients are constructor-set immutables on SatoriRewards now
        // (zero and the old 0xdEaD/0xbEEF placeholders are rejected). Fixed
        // non-actor, non-deployer addresses.
        address platformFeeRecipient = address(0xFEE1);
        address marketingFeeRecipient = address(0xFEE2);

        // --- Deploy the split stack (mirrors test/next/splitFixture.js) ---
        // children. SatoriVoting takes NO constructor args now: the eligible-cap
        // died with the dual heap. Under burn voting the eligible set is
        // unbounded — every enabled game with weight > 0 earns in proportion to
        // it — so there is no cap to size.
        voting = new SatoriVoting();
        rewards = new SatoriRewards(
            address(voting), deployer, marketingFeeRecipient
        );
        registry = new SatoriRegistry();
        games = new SatoriGames();
        bounties = new SatoriBounties();

        // Immutable token: mints INITIAL_MINT to the governor == deployer. The
        // 2nd ctor arg is the dev-fee recipient; point it at the deployer too so
        // the full 720 genesis supply stays on one touched address (the dev slice
        // 144 + governor 576 both land on the deployer) — conservation
        // invariants that sum voting power over touched addresses stay exact.
        satoriToken = new SatoriToken(deployer, deployer, block.chainid);

        // Engine impl + proxy (initialized WITHOUT the hub; setHub after). The
        // engine carries the prediction logic inline — no delegatecall module,
        // so the old PREDICT_LOGIC vm.etch is gone.
        SatoriEngine engineImpl = new SatoriEngine();
        bytes memory initData = abi.encodeWithSelector(
            SatoriEngine.initialize.selector,
            address(satoriToken), address(voting), address(rewards),
            address(registry), address(games), address(bounties)
        );
        SatoriProxy proxy = new SatoriProxy(address(engineImpl), initData);
        engine = SatoriEngine(address(proxy));

        // Hub: the ISatoriCore facade + fee sink (the split's "core").
        satori = new SatoriHub(
            address(satoriToken), address(engine), address(voting), address(rewards),
            address(registry), address(games), address(bounties)
        );
        ghostIssued = satoriToken.totalRewardsMinted();
        satori.setSatoriMerkle(MERKLE);
        _reserveCumulativeSlot = bytes32(_layoutSlot("SatoriHub", "merkleReserveCumulative"));
        _roundWeightSnapshotSlot = _layoutSlot("SatoriRewards", "_roundWeightSnapshot");
        require(
            uint256(vm.load(address(satori), bytes32(_layoutSlot("SatoriHub", "onChainMinted"))))
                == satori.onChainMinted(),
            "storage-layouts/SatoriHub.json is stale"
        );

        // --- wire (mirrors splitFixture.js) ---
        engine.setHub(address(satori));
        satoriToken.setController(address(satori));
        satoriToken.setHook(address(satori));

        voting.setSatoriCore(address(satori));
        voting.setSatoriEngine(address(engine));
        voting.setSatoriToken(address(satoriToken));

        rewards.setSatoriCore(address(satori));
        rewards.setSatoriEngine(address(engine));
        rewards.setSatoriBounties(address(bounties));
        require(
            address(uint160(uint256(vm.load(address(rewards), bytes32(_layoutSlot("SatoriRewards", "satoriCore"))))))
                == address(satori),
            "storage-layouts/SatoriRewards.json is stale"
        );

        // Enable ALL progressive-rollout capabilities so the fuzz actors can
        // actually exercise the CAP-gated paths — bounty fund/stake (CAP_BOUNTY),
        // the two surviving delegation types (CAP_DELEGATE_PREDICTION /
        // CAP_DELEGATE_CLAIM — bit 8, vote delegation, is retired), community
        // adapter registration, and off-chain game types. Note that voting
        // itself is NOT cap-gated: `SatoriHub.vote` burns rather than granting a
        // rollout-limited privilege. Every CAP bit defaults OFF, so
        // without this each such actor call silently reverts CapabilityDisabled
        // (swallowed by the handler try/catch) and its invariant coverage is
        // vacuous. deployer == admin, so this admin-only call succeeds here.
        rewards.setCapabilities(type(uint256).max);

        registry.setSatoriCore(address(satori));
        registry.setSatoriEngine(address(engine));

        games.setSatoriCore(address(satori));

        bounties.setSatoriCore(address(satori));
        bounties.setSatoriEngine(address(engine));
        bounties.setSatoriRewards(address(rewards));
        bounties.setSatoriToken(address(satoriToken));

        // The hub pulls creation/adapter/bounty-burn fees via transferFrom, and
        // `vote` now burns via `token.burnFrom` — which ALSO spends the hub's
        // allowance — so every voter must have approved the hub or every vote
        // reverts on allowance. (initializeDefaultStream no longer pulls
        // anything: the default game's weight is derived, not bought by a seed
        // vote.) Actors approve the hub in the actor-setup loop below.
        satoriToken.approve(address(satori), type(uint256).max);

        // Read-only computed-view lens (per-(game,round,direction) weight
        // getters live here post-EIP-170 split). Core arg == the hub.
        lens = new SatoriRewardsLens(address(satori), address(rewards));

        // Deploy + register Custom adapter (only one we need for invariants —
        // Custom is the simplest stream type and exercises the full adapter
        // path through the registry). The registry auto-assigns adapter
        // IDs starting at 1; this single registration lands at ID 1, which
        // is the ID we then reference when creating the adapter stream.
        customAdapter = new CustomAdapter();
        // Official (community = false): deployer is the admin (rewards was
        // deployed with admin = deployer), so it uses the admin-only path.
        uint16 customAdapterId = satori.registerAdapter(address(customAdapter), "Custom");

        // Default stream + a Custom stream that we can predict against.
        // initializeDefaultStream creates the DEFAULT game (id 1) on the
        // default stream. Game 1 is predictable but NOT votable — its weight is
        // derived from everyone else's burns and `voting.vote` rejects it with
        // CannotVoteDefault — so every vote action below picks from 2..gameCount.
        // We then create a second stream and a binary game on it, so the fuzz
        // surface has a votable binary game (2) alongside the default —
        // matching the Phase 4b test pattern where games and streams align 1:1
        // by creation order.
        mockStream = new MockDataStream();
        mockStream.setValue(100);
        satori.initializeDefaultStream();
        bytes memory cfg = "";
        // createAdapterDataStream(name, adapterId, provider, config,
        // minCadenceMinutes) — the 5-arg overload. Note there is no longer a
        // `valueProviderCutBps` parameter: the value-provider cut was removed
        // outright (providers are NOT paid), so stream creation lost that arg
        // and `accrueProviderCut` with it. This both creates the Adapter-type
        // stream (id 2) AND auto-creates its default binary game (id 2),
        // matching the 1:1 stream:game launch model. No separate createGame
        // call is needed — the previous explicit createGame(2, ...) would now
        // revert as a DuplicateBinaryGame.
        // Cadence 2880 minutes (two 24h rounds): adapter (gameTypeId > 0)
        // games require a two-round host cadence (GameCadenceTooShort gate), so the hostile
        // adapter games created below (yesNo/everyoneWins/reentrant) can attach.
        adapterStreamId = satori.createAdapterDataStream(
            "test-custom", customAdapterId, address(mockStream), cfg, uint24(2880)
        );

        // Games are opt-in (gameApproved): the auto-created binary game is
        // born unapproved and unvotable. Approve it here, as the admin would,
        // or every vote action is a swallowed revert and the weight-bearing
        // invariants prove nothing (the exact vacuity AdapterSanity pins).
        {
            uint32 bg = games.binaryGameByStream(adapterStreamId);
            vm.prank(rewards.admin());
            voting.setGameApproved(bg, true);
        }

        // Mark address(satori) as touched (it holds the slack mint).
        _touch(address(satori));

        // Set up 5 actors with starter tokens. Keyed off INITIAL_MINT so
        // this scales with any future change to the bootstrap amount;
        // 5 × INITIAL_MINT/10 = half the bootstrap distributed.
        uint256 perActor = satoriToken.INITIAL_MINT() / 10;
        for (uint256 i = 0; i < 5; i++) {
            actors[i] = address(uint160(0xA110CA7E + i));
            satoriToken.transfer(actors[i], perActor);
            // Actor approves the hub so its fuzzed fee-charging ops (community
            // adapter spam-fee, bounty-burn) can pull SATORI via transferFrom.
            vm.prank(actors[i]);
            satoriToken.approve(address(satori), type(uint256).max);
            _touch(actors[i]);
        }
        _touch(deployer);

        // Bounty tokens: two distinct ERC20s so the multi-token paths in
        // streamBountyTokens, _roundBountyTokens, and unclaimedBounty get
        // exercised. Pre-approved per actor so fundBounty doesn't need a
        // separate approve in the fuzz loop.
        bountyToken = new MockERC20("BountyMock", "BMK");
        bountyTokenB = new MockERC20("BountyMockB", "BMKB");
        for (uint256 i = 0; i < 5; i++) {
            bountyToken.mint(actors[i], 10_000 ether);
            bountyTokenB.mint(actors[i], 10_000 ether);
            vm.prank(actors[i]);
            bountyToken.approve(address(bounties), type(uint256).max);
            vm.prank(actors[i]);
            bountyTokenB.approve(address(bounties), type(uint256).max);
        }

        // ===== Adapter game wiring (Phase 2) =====
        // YesNoGame is the example (test-only, insecure — audit F4) score/total
        // accuracy adapter used to exercise the adapter code paths. Its
        // constructor wants (core, gamesReg, streamRegistry, rewards). The
        // adapter game's "core" is whatever calls its record()/score()
        // (_onlyCore) — in the split that is the ENGINE (SatoriEngine.settle
        // invokes IPredictionGame(impl).record/score), NOT the hub. Passing the
        // hub here makes every adapter record/score revert Unauthorized, so
        // adapter predictions never score and the adapter invariants go vacuous.
        yesNoGame = new YesNoGame(
            address(engine), address(games), address(registry)
        );
        // EveryoneWinsGame + ReentrantGameAdapter are hostile mocks that the
        // fuzzer is allowed to register because game-adapter registration is
        // PERMISSIONLESS — they probe the protocol's pin+cap / reentrancy rails.
        // Same core == engine rule as YesNoGame above.
        everyoneWinsGame = new EveryoneWinsGame(address(engine));
        reentrantGame = new ReentrantGameAdapter(address(engine));

        // Register all three as game adapters. YesNo via the admin (free,
        // official) path; the two hostiles via the permissionless community
        // path (deployer is admin AND holds SATORI so the streamBurn/gameBurn
        // fees are payable). registerGameAdapter / registerCommunityGameAdapter both
        // return the assigned gameTypeId.
        yesNoTypeId = satori.registerGameAdapter(address(yesNoGame), "YesNo");
        everyoneWinsTypeId =
            satori.registerCommunityGameAdapter(address(everyoneWinsGame), "EveryoneWins");
        reentrantTypeId =
            satori.registerCommunityGameAdapter(address(reentrantGame), "Reentrant");

        // Create one adapter game per type on the Adapter data stream (id 2,
        // backed by mockStream). YesNo needs a 32-byte int128-threshold config;
        // the two hostiles accept any config. createGame charges gameBurn
        // from the deployer. Resulting game IDs: 3 (YesNo), 4 (EveryoneWins),
        // 5 (Reentrant). Binary games on streams 1,2 already hold IDs 1,2.
        bytes memory yesNoCfg = abi.encode(int128(50)); // threshold 50 vs mock value 100 → YES
        uint32 g1 = satori.createGame(adapterStreamId, yesNoTypeId, yesNoCfg, "yesno-game");
        uint32 g2 = satori.createGame(adapterStreamId, everyoneWinsTypeId, "", "ew-game");
        uint32 g3 = satori.createGame(adapterStreamId, reentrantTypeId, "", "re-game");
        _registerAdapterGame(g1);
        _registerAdapterGame(g2);
        _registerAdapterGame(g3);

        // Seed the adapter stream with an initial registry value so the very
        // first adapter prediction's freshness check (streamLastUpdate ==
        // current round) can pass once advanceTime + updateAdapterValue run.
        // updateValue pulls mockStream.value() (100) into the history ring.
        try registry.updateValue(adapterStreamId) {} catch {}

        splitStreamId = satori.createSimpleDataStream("fuzz-2h", address(this), uint24(120));
        splitGameId = games.binaryGameByStream(splitStreamId);
        vm.prank(rewards.admin());
        voting.setGameApproved(splitGameId, true);
        bountyStreamId = satori.createSimpleDataStream("fuzz-2h-bounty", address(this), uint24(120));
        bountyGameId = games.binaryGameByStream(bountyStreamId);
        _roundBudgetSlot = _layoutSlot("SatoriRewards", "_roundBudget");
    }

    /// What Rewards may credit game `g` in round `r`: the round's frozen
    /// budget × the game's frozen votes ÷ all frozen votes.
    function gameSlice(uint32 g, uint256 r) public view returns (uint256) {
        uint256 denom = voting.roundDenominator(r);
        if (denom == 0) return 0;
        uint256 budget = uint256(vm.load(address(rewards), keccak256(abi.encode(r, _roundBudgetSlot))));
        return budget * voting.getGameVotesAtRound(g, r) / denom;
    }

    function roundBudget(uint256 r) external view returns (uint256) {
        return uint256(vm.load(address(rewards), keccak256(abi.encode(r, _roundBudgetSlot))));
    }

    function binaryCreditPairsLength() external view returns (uint256) {
        return _binaryCreditGames.length;
    }

    function binaryCreditPair(uint256 i) external view returns (uint32, uint256) {
        return (_binaryCreditGames[i], _binaryCreditRounds[i]);
    }

    function _registerAdapterGame(uint32 gameId) internal {
        adapterGameIds.push(gameId);
        isAdapterGame[gameId] = true;
    }

    function adapterGameCount() external view returns (uint256) {
        return adapterGameIds.length;
    }

    function creditedGameRoundCount() external view returns (uint256) {
        return creditedGameRoundGames.length;
    }

    function _noteCredited(uint32 gameId, uint256 round) internal {
        if (!_creditedSeen[gameId][round]) {
            _creditedSeen[gameId][round] = true;
            creditedGameRoundGames.push(gameId);
            creditedGameRoundRounds.push(round);
        }
    }

    function _pickBountyToken(uint256 seed) internal view returns (MockERC20) {
        return (seed & 1) == 0 ? bountyToken : bountyTokenB;
    }

    function _touch(address a) internal {
        if (a != address(0) && !addressTouched[a]) {
            addressTouched[a] = true;
            touchedAddresses.push(a);
        }
    }

    function _actor(uint256 seed) internal view returns (address) {
        return actors[seed % 5];
    }

    function touchedAddressesLength() external view returns (uint256) {
        return touchedAddresses.length;
    }

    function _layoutSlot(string memory c, string memory label) internal view returns (uint256 slot) {
        bytes memory json = bytes(vm.readFile(string.concat(vm.projectRoot(), "/storage-layouts/", c, ".json")));
        uint256 i = _indexOf(json, bytes(string.concat("\"label\": \"", label, "\"")), 0);
        require(i < json.length, string.concat("no ", label, " in ", c, " layout"));
        bytes memory slotKey = bytes("\"slot\": \"");
        uint256 j = _indexOf(json, slotKey, i);
        require(j < json.length, string.concat("no slot for ", label));
        for (j += slotKey.length; json[j] != "\""; j++) slot = slot * 10 + (uint8(json[j]) - 48);
    }

    function _indexOf(bytes memory hay, bytes memory needle, uint256 from) internal pure returns (uint256) {
        for (uint256 i = from; i + needle.length <= hay.length; i++) {
            uint256 k;
            while (k < needle.length && hay[i + k] == needle[k]) k++;
            if (k == needle.length) return i;
        }
        return type(uint256).max;
    }

    function _roundWeightSnapshot(address user, uint256 round) internal view returns (uint256) {
        bytes32 inner = keccak256(abi.encode(user, _roundWeightSnapshotSlot));
        return uint256(vm.load(address(rewards), keccak256(abi.encode(round, inner))));
    }

    function _ghostIssued(Vm.AccountAccess[] memory accesses, Vm.Log[] memory logs) internal {
        uint256 bps = satoriToken.devFeeBps();
        uint256[] memory notes = new uint256[](accesses.length);
        uint256 nNotes;
        for (uint256 i = 0; i < accesses.length; i++) {
            Vm.AccountAccess memory a = accesses[i];
            if (a.reverted) continue;
            if (a.kind == VmSafe.AccountAccessKind.Call && a.account == address(satori) && a.data.length == 36) {
                bytes memory data = a.data;
                bytes4 sel;
                uint256 general;
                assembly {
                    sel := mload(add(data, 32))
                    general := mload(add(data, 36))
                }
                if (sel == SatoriHub.noteIssued.selector) {
                    notes[nNotes++] = general;
                    ghostNoteIssuedCalls++;
                    ghostIssued += general * 10000 / (10000 - bps);
                }
            }
            for (uint256 k = 0; k < a.storageAccesses.length; k++) {
                Vm.StorageAccess memory s = a.storageAccesses[k];
                if (s.reverted || !s.isWrite || s.account != address(satori) || s.slot != _reserveCumulativeSlot) continue;
                uint256 prev = uint256(s.previousValue);
                uint256 next = uint256(s.newValue);
                if (next > prev) {
                    ghostReserveBanks++;
                    ghostIssued += (next - prev) * 10000 / (10000 - bps);
                }
            }
        }
        uint256 j;
        uint256 nowRound = satori.getCurrentRound();
        for (uint256 i = 0; i < logs.length; i++) {
            Vm.Log memory l = logs[i];
            if (l.emitter == address(engine) && l.topics.length == 4 && l.topics[0] == PREDICTION_SCORED
                && uint256(l.topics[3]) >= nowRound) ghostScoredInOwnRound++;
            if (l.emitter != address(rewards) || l.topics.length == 0 || l.topics[0] != REWARD_SPLIT) continue;
            address predictor = address(uint160(uint256(l.topics[1])));
            uint256 round = uint256(l.topics[3]);
            (uint256 u, uint256 d,) = abi.decode(l.data, (uint256, uint256, uint256));
            if (d != 0 && _roundWeightSnapshot(predictor, round) == 0) d = 0;
            _noteBinaryCredit(uint32(uint256(l.topics[2])), round, u + d);
            while (j < nNotes && notes[j] != u + d) j++;
            if (j == nNotes) {
                ghostSplitMismatch++;
            } else {
                j++;
                ghostSplitsMatched++;
                if (d != 0) ghostSplitsWithDelegatorShare++;
            }
        }
    }

    function _noteBinaryCredit(uint32 g, uint256 r, uint256 amount) internal {
        ghostBinaryCredited[g][r] += amount;
        ghostBinaryCreditCount[g][r]++;
        ghostRoundCredited[r] += amount;
        if (!_binaryCreditSeen[g][r]) {
            _binaryCreditSeen[g][r] = true;
            _binaryCreditGames.push(g);
            _binaryCreditRounds.push(r);
        }
    }

    /// The binary games predict/settle pick from: the default, the adapter
    /// stream's binary game, and the two 2-hour games.
    function _binaryGame(uint256 seed) internal view returns (uint32) {
        uint256 k = seed % 4;
        return k == 2 ? splitGameId : k == 3 ? bountyGameId : uint32(1 + k);
    }

    function _predictAs(address actor, uint32 gameId, uint8 direction) internal {
        SatoriTypes.PredictionRequestWithPayload[] memory reqs =
            new SatoriTypes.PredictionRequestWithPayload[](1);
        reqs[0] = SatoriTypes.PredictionRequestWithPayload({
            gameId: gameId,
            payload: abi.encodePacked(direction)
        });
        uint256 round = satori.getCurrentRound();
        vm.prank(actor);
        try engine.predictMultipleWithPayloads(reqs) {
            ghostPredicted[gameId][round] = true;
            callCount_predict++;
        } catch {}
    }

    function _splitWriteAt(uint32 streamId, uint256 ts, int232 value) internal {
        if (ts > block.timestamp) vm.warp(ts);
        try registry.setValue(streamId, value) { callCount_splitWrite++; } catch {}
    }

    // ===== Fuzz call surface =====

    function transferTokens(uint256 fromSeed, uint256 toSeed, uint256 amount) external trackIssued {
        address from = _actor(fromSeed);
        address to = _actor(toSeed);
        amount = bound(amount, 0, satoriToken.balanceOf(from));
        if (amount == 0 || from == to) return;
        vm.prank(from);
        try satoriToken.transfer(to, amount) {
            _touch(to);
            callCount_transfer++;
        } catch {}
    }

    /// Burn-backed vote. `satori.vote(gameId, amount)` DESTROYS `amount` SATORI
    /// off the actor and credits the game that much permanent, unmovable weight.
    /// The old one-arg `vote(gameId)` — which staked the caller's whole balance
    /// without spending it, and which the next vote silently moved — is gone, and
    /// with it the whole notion of a vote that can be re-pointed or revoked.
    ///
    /// Two bounds matter here, and both are about keeping the REST of the fuzz
    /// surface alive rather than about the vote itself:
    ///
    ///   - GAME 1 IS SKIPPED. It is the default game; its weight is derived from
    ///     everyone else's burns, so `voting.vote` rejects it outright
    ///     (CannotVoteDefault) rather than let a caller destroy tokens for
    ///     nothing. Picking it would make this action a guaranteed no-op.
    ///
    ///   - AT MOST HALF THE BALANCE. Prediction power is balance-derived, so a
    ///     fuzzer free to burn an actor down to nothing would quietly hollow out
    ///     the reward invariants: that actor's predictions would all carry zero
    ///     weight, earn nothing, and grow no streak, so every downstream settle
    ///     and claim would be vacuous. Halving can never reach zero, so each
    ///     actor stays a paying predictor no matter how many votes land.
    ///
    ///     (This used to say the predict path REVERTS at zero power. It did, and
    ///     that gate is gone — an empty wallet may now predict. The constraint
    ///     still stands, for the reason above: the invariants need actors who
    ///     actually earn, not merely actors who are admitted.)
    function vote(uint256 actorSeed, uint256 gameSeed, uint256 amountSeed) external trackIssued {
        address actor = _actor(actorSeed);
        uint256 gcount = games.gameCount();
        if (gcount < 2) return;                       // only the default exists
        uint32 gameId = uint32(2 + (gameSeed % (gcount - 1)));   // 2..gameCount

        uint256 spendable = satoriToken.balanceOf(actor) / 2;
        if (spendable == 0) return;
        uint256 amount = bound(amountSeed, 1, spendable);

        vm.prank(actor);
        try satori.vote(gameId, amount) {
            ghostBurned += amount;
            callCount_vote++;
        } catch {}
    }

    /// Switch a game off / back on. The ONLY thing that can ever remove weight
    /// from `totalBurnedWeight` — burns are irreversible, so disabling is the
    /// protocol's sole defence against a manipulated game and the sole exception
    /// to weight monotonicity. Without this action the two invariants that pin
    /// down that exception (Conservation INV-1c weight monotonicity and INV-1b
    /// `totalBurnedWeight == Σ enabled gameWeight`) would only ever see the
    /// trivial all-enabled state and prove nothing.
    ///
    /// Pranks whatever address currently holds the rewards-admin role, because
    /// `rotateAdmin` may have moved it off the deployer. Game 1 is skipped: the
    /// default's approval cannot be set (CannotSetDefaultApproval).
    function setGameApproved(uint256 gameSeed, bool approved) external trackIssued {
        uint256 gcount = games.gameCount();
        if (gcount < 2) return;
        uint32 gameId = uint32(2 + (gameSeed % (gcount - 1)));
        vm.prank(rewards.admin());
        try voting.setGameApproved(gameId, approved) {} catch {}
    }

    /// Cumulative weight legitimately moved OFF each game via `moveVotes`.
    /// Conservation INV-1c asserts monotonicity of `gameWeight[g] + this`,
    /// so a decrease is sanctioned exactly when a recorded move explains it.
    mapping(uint32 => uint256) public ghostMovedOut;

    /// Re-point an actor's own weight off a DISABLED game (the owner-decided
    /// exception to vote permanence, 2026-09-05). Most calls revert on the
    /// guards — source enabled, nothing held, frozen round, bad destination —
    /// which is the point: the fuzzer proves the guards hold while the rare
    /// success exercises the accounting (INV-1b total-vs-sum, INV-1c with the
    /// ghost, and the default game's derived share).
    function moveVotes(uint256 actorSeed, uint256 fromSeed, uint256 toSeed, uint256 amountSeed) external trackIssued {
        address actor = _actor(actorSeed);
        uint256 gcount = games.gameCount();
        if (gcount < 3) return;                        // need two non-default games
        uint32 fromGame = uint32(2 + (fromSeed % (gcount - 1)));
        uint32 toGame = uint32(2 + (toSeed % (gcount - 1)));
        uint256 held = voting.voterGameWeight(actor, fromGame);
        if (held == 0) return;
        uint256 amount = bound(amountSeed, 1, held);
        vm.prank(actor);
        try voting.moveVotes(fromGame, toGame, amount) {
            ghostMovedOut[fromGame] += amount;
        } catch {}
    }

    function delegatePrediction(uint256 fromSeed, uint256 toSeed) external trackIssued {
        address from = _actor(fromSeed);
        address to = _actor(toSeed);
        if (from == to) to = address(0);
        vm.prank(from);
        try satori.delegatePredictionPower(to) { callCount_delegate++; } catch {}
    }

    function undelegatePrediction(uint256 fromSeed) external trackIssued {
        address from = _actor(fromSeed);
        vm.prank(from);
        try satori.delegatePredictionPower(address(0)) { callCount_undelegate++; } catch {}
    }

    function predict(uint256 actorSeed, uint256 streamSeed, uint8 direction) external trackIssued {
        address actor = _actor(actorSeed);
        // Constrain direction to 1 or 2 (UP/DOWN); 0 is reserved.
        direction = uint8(1 + (uint256(direction) % 2));
        _predictAs(actor, _binaryGame(streamSeed), direction);
    }

    function settlePrediction(uint256 actorSeed, uint256 streamSeed) external trackIssued {
        address user = _actor(actorSeed);
        try engine.settlePrediction(user, _binaryGame(streamSeed)) {} catch {}
    }

    /// The provider writes the 2-hour stream. The registry refuses a write
    /// sooner than one cadence after the last, so most calls land only after
    /// advanceTime.
    function writeSplitStream(uint256 streamSeed, int232 value) external trackIssued {
        uint32 sid = streamSeed % 2 == 0 ? splitStreamId : bountyStreamId;
        try registry.setValue(sid, int232(bound(int256(value), 1, 1e18))) { callCount_splitWrite++; } catch {}
    }

    /// One round on a 2-hour game where an UP at 01:00 and a DOWN at 13:00
    /// both win, a DOWN at 01:00 loses, and settles are tried inside the
    /// round and again after midnight. A random walk is unlikely to find this
    /// ordering. An odd voteSeed plays splitGameId with vote weight (a SATORI
    /// slice; an in-round win then reverts on its own); an even one plays
    /// bountyGameId with a bounty the winners boost once they hold a streak,
    /// the case where an in-round settle could pay against a partial total.
    /// That variant always uses actors 0-2, so from its second run on the
    /// winners hold the streak a boost needs.
    function splitRoundScenario(uint256 actorSeed, uint256 voteSeed) external trackIssued {
        bool weighted = voteSeed % 2 == 1;
        if (!weighted) actorSeed = 0;
        address up = _actor(actorSeed % 5);
        address down = _actor(actorSeed % 5 + 1);
        address loser = _actor(actorSeed % 5 + 2);
        uint32 g = weighted ? splitGameId : bountyGameId;
        uint32 sid = weighted ? splitStreamId : bountyStreamId;
        uint256 day = block.timestamp / 1 days + 1;
        if (weighted) {
            // Weight on the game before the round's first predictor freezes it.
            uint256 spendable = satoriToken.balanceOf(down) / 4;
            if (spendable > 0) {
                uint256 amount = bound(voteSeed, 1, spendable);
                vm.prank(down);
                try satori.vote(g, amount) {
                    ghostBurned += amount;
                    callCount_vote++;
                } catch {}
            }
        } else {
            _splitBounty(loser, up, down);
        }
        lastSplitRound = day;
        _splitWriteAt(sid, day * 1 days + 1 hours, 1000);
        _predictAs(up, g, 1);
        _predictAs(loser, g, 2);
        _splitWriteAt(sid, day * 1 days + 3 hours, 1100);
        _splitWriteAt(sid, day * 1 days + 5 hours, 1200);
        try engine.settlePrediction(up, g) {} catch {}
        try engine.settlePrediction(loser, g) {} catch {}
        if (engine.predictions(up, g, day).scored) ghostScoredInOwnRound++;
        if (engine.predictions(loser, g, day).scored) ghostScoredInOwnRound++;
        _splitWriteAt(sid, day * 1 days + 13 hours, 1300);
        _predictAs(down, g, 2);
        _splitWriteAt(sid, day * 1 days + 15 hours, 1200);
        _splitWriteAt(sid, day * 1 days + 17 hours, 1100);
        vm.warp((day + 1) * 1 days + 5 minutes);
        try engine.settlePrediction(up, g) {} catch {}
        try engine.settlePrediction(down, g) {} catch {}
        try engine.settlePrediction(loser, g) {} catch {}
        callCount_splitScenario++;
    }

    function _splitBounty(address funder, address up, address down) internal {
        uint256 burn = lens.bountyBurn();
        if (satoriToken.balanceOf(funder) < burn && satoriToken.balanceOf(deployer) >= burn) {
            vm.prank(deployer);
            satoriToken.transfer(funder, burn);
        }
        if (bountyToken.balanceOf(funder) >= 150 ether) {
            vm.prank(funder);
            try bounties.fundBounty(bountyGameId, address(bountyToken), 150 ether, 100 ether) {
                ghostBountyFunded[bountyGameId][address(bountyToken)] += 150 ether;
                callCount_fundBounty++;
            } catch {}
        }
        address[2] memory stakers = [up, down];
        for (uint256 i = 0; i < 2; i++) {
            if (bountyToken.balanceOf(stakers[i]) < 100 ether) continue;
            uint256 before = bountyToken.balanceOf(address(bounties));
            vm.prank(stakers[i]);
            try bounties.stakeBountyToken(address(bountyToken), 100 ether) {
                ghostBountyStaked[address(bountyToken)] += bountyToken.balanceOf(address(bounties)) - before;
            } catch {}
        }
    }

    function claim(uint256 actorSeed) external trackIssued {
        address actor = _actor(actorSeed);
        vm.prank(actor);
        try satori.claim() { callCount_claim++; } catch {}
    }

    function advanceTime(uint256 seconds_) external trackIssued {
        seconds_ = bound(seconds_, 1, 86400 * 7); // 1s to 1 week
        vm.warp(block.timestamp + seconds_);
        // Update the mock value occasionally so settlements have B/C to score against
        if (seconds_ > 12 hours) {
            int128 cur = int128(int256(mockStream.value()));
            mockStream.setValue(cur + int256(uint256(seconds_) % 10));
        }
    }

    function setStreamValue(uint256 streamSeed, int128 newValue) external trackIssued {
        uint32 streamId = uint32(1 + (streamSeed % 1)); // only stream 1 (default) accepts setValue; stream 2 is Adapter
        // Actually the default stream is owned by `address(satori)`; we can't
        // setValue on it directly. So fuzz mockStream value instead.
        streamId; newValue;
        mockStream.setValue(int128(bound(int256(newValue), 1, 1e18)));
    }

    // ===== Bounty fuzz surface =====
    //
    // `fundBounty` and `withdrawBounty` exercise the bounty pool conservation
    // path: tokens flow in via fund, out via withdraw, and internally between
    // `pool`, `roundBountyPot`, and `unclaimedBounty` as predictions are
    // scored. The Bounty.invariant.t.sol suite checks the ghost totals here
    // against the contract's bookkeeping.

    /// @dev Pick a fundable GAME id. Bounty pool/pots/rate are all keyed by
    ///      gameId in SatoriBounties (`fundBounty(gameId,...)` gates on
    ///      gameExists), so funding spans the full game range — binary games
    ///      1,2 (== streams 1,2) AND adapter games 3,4,5. Funding adapter games
    ///      is what gives the adapter BOUNTY conservation invariant teeth:
    ///      snapshotAdapterStake then finds a live token and creditAdapterBounty
    ///      pays from the dripped roundBountyPot under the pin+cap.
    function _pickGameForBounty(uint256 seed) internal view returns (uint32) {
        uint256 gcount = games.gameCount();
        if (gcount == 0) return 1;
        return uint32(1 + (seed % gcount));
    }

    function fundBounty(uint256 actorSeed, uint256 gameSeed, uint256 tokenSeed, uint256 amount, uint256 proposedRate) external trackIssued {
        address actor = _actor(actorSeed);
        uint32 gameId = _pickGameForBounty(gameSeed);
        MockERC20 token = _pickBountyToken(tokenSeed);
        uint256 maxAmount = token.balanceOf(actor);
        if (maxAmount == 0) return;
        amount = bound(amount, 1, maxAmount > 1000 ether ? 1000 ether : maxAmount);
        proposedRate = bound(proposedRate, 1, amount);
        // Posting a bounty in a NON-SATORI token now charges an upfront SATORI
        // burn (bountyBurn) on the funder. Top the actor up from the deployer so
        // the fuzzed fund can pay it — otherwise every fundBounty would silently
        // revert as actor SATORI drains, turning the bounty invariants vacuous.
        // The fee views (streamBurn / gameBurn / bountyBurn) are `internal` on
        // the hub and are exposed publicly by the lens instead, so read it there.
        uint256 burn = lens.bountyBurn();
        if (satoriToken.balanceOf(actor) < burn && satoriToken.balanceOf(deployer) >= burn) {
            vm.prank(deployer);
            satoriToken.transfer(actor, burn);
        }
        vm.prank(actor);
        try bounties.fundBounty(gameId, address(token), amount, proposedRate) {
            ghostBountyFunded[gameId][address(token)] += amount;
            callCount_fundBounty++;
        } catch {}
    }

    // (withdrawBounty removed — the dead unclaimedBounty withdraw path is gone;
    // bounty winnings auto-compound into bountyStake and exit via unstake — A4.)

    /// @notice Sum of all funded bounty into (gameId, token) — ghost total
    ///         compared against on-chain pool/pots balances by the bounty
    ///         invariants. Keyed by GAME id (bounty state is per-game).
    function totalFundedForStreamToken(uint32 gameId, address token) external view returns (uint256) {
        return ghostBountyFunded[gameId][token];
    }

    /// @notice Total funded across all GAMES for a token (1..gameCount, so
    ///         adapter games are included).
    function totalFundedAllStreamsForToken(address token) external view returns (uint256) {
        uint256 total = 0;
        uint256 gcount = games.gameCount();
        for (uint32 g = 1; g <= gcount; g++) {
            total += ghostBountyFunded[g][token];
        }
        return total;
    }

    // ===== Additional fuzz surface =====

    /// Each address can set its referral exactly once. The handler-side
    /// try/catch absorbs the "already set" revert on retries.
    function setReferral(uint256 actorSeed, uint256 targetSeed) external trackIssued {
        address actor = _actor(actorSeed);
        // Allow targeting another actor OR self (self acts as opt-out, both
        // valid per the contract).
        address target = _actor(targetSeed);
        if (target == address(0)) return;
        vm.prank(actor);
        try rewards.setReferral(target) { callCount_setReferral++; } catch {}
    }

    /// Claim-delegate set/clear. Lets one actor authorize another to
    /// trigger their claim. Targeting `address(0)` clears.
    function delegateClaim(uint256 actorSeed, uint256 targetSeed) external trackIssued {
        address actor = _actor(actorSeed);
        address target = (targetSeed & 1) == 0 ? address(0) : _actor(targetSeed);
        vm.prank(actor);
        try satori.delegateClaimAbility(target) { callCount_delegateClaim++; } catch {}
    }

    /// Claim on behalf of an owner via the claim-delegate path. Requires
    /// `owner` to have delegated claim authority to `caller` first; otherwise
    /// the try/catch absorbs the revert.
    function claimFor(uint256 callerSeed, uint256 ownerSeed) external trackIssued {
        address caller = _actor(callerSeed);
        address owner = _actor(ownerSeed);
        // Route through the core's claimFor(owner, recipient): the underlying
        // SatoriRewards.claimFor is now `onlyCore`, so it can no longer be
        // called directly off the rewards contract. The core resolves
        // msg.sender (caller) as the claim-delegate authority and forwards;
        // the try/catch absorbs the revert when `owner` never delegated claim
        // authority to `caller`.
        vm.prank(caller);
        try satori.claimFor(owner, owner) {} catch {}
    }

    /// Bounty token stake — adds the actor's stake which (when the stream
    /// has a matching bounty active) auto-boosts their share at predict
    /// time. Exercises the userStakedTokens list + per-token pending
    /// counters.
    function stakeBountyToken(uint256 actorSeed, uint256 tokenSeed, uint256 amount) external trackIssued {
        address actor = _actor(actorSeed);
        MockERC20 token = _pickBountyToken(tokenSeed);
        uint256 maxAmount = token.balanceOf(actor);
        if (maxAmount == 0) return;
        amount = bound(amount, 1, maxAmount > 500 ether ? 500 ether : maxAmount);
        uint256 before = token.balanceOf(address(bounties));
        vm.prank(actor);
        try bounties.stakeBountyToken(address(token), amount) {
            ghostBountyStaked[address(token)] += token.balanceOf(address(bounties)) - before;
        } catch {}
    }

    function unstakeBountyToken(uint256 actorSeed, uint256 tokenSeed, uint256 amount) external trackIssued {
        address actor = _actor(actorSeed);
        MockERC20 token = _pickBountyToken(tokenSeed);
        amount = bound(amount, 1, 500 ether);
        uint256 before = token.balanceOf(address(bounties));
        vm.prank(actor);
        try bounties.unstakeBountyToken(address(token), amount, actor) {
            ghostBountyUnstaked[address(token)] += before - token.balanceOf(address(bounties));
        } catch {}
    }

    function totalStakedForToken(address token) external view returns (uint256) {
        return ghostBountyStaked[token];
    }

    function totalUnstakedForToken(address token) external view returns (uint256) {
        return ghostBountyUnstaked[token];
    }

    /// Manual cleanup of a fully drained bounty token. Permissionless;
    /// reverts NotDrained / TokenNotFunded when conditions aren't met.
    function cleanupBountyToken(uint256 gameSeed, uint256 tokenSeed) external trackIssued {
        uint32 gameId = _pickGameForBounty(gameSeed);
        MockERC20 token = _pickBountyToken(tokenSeed);
        try bounties.cleanupDrainedBountyToken(gameId, address(token)) {} catch {}
    }

    /// Admin rotation. The fee RECIPIENT is wired once at deploy and is
    /// immutable thereafter (no re-point path), so the only rotatable role
    /// is the admin. We drive it from the deployer (the admin in this
    /// Handler). Targets an actor so the post-rotation admin is a touched
    /// address tracked by invariants.
    function rotateAdmin(uint256 targetSeed) external trackIssued {
        address target = _actor(targetSeed);
        if (target == address(0)) return;
        vm.prank(deployer);
        try rewards.setAdmin(target) {} catch {}
    }

    // ===================================================================
    // ===== Adapter game fuzz surface (Phase 2) =====
    // ===================================================================

    /// Drive a fresh value into the Adapter data stream (stream 2) via the
    /// permissionless `registry.updateValue`. Adapter-game predictions require
    /// the stream's last-update round to equal the current round, and scoring
    /// requires a value AFTER the prediction round — so the fuzzer must be able
    /// to push values. Cadence/timestamp guards make most calls revert
    /// (absorbed); the ones that land make adapter games playable + scorable.
    function updateAdapterValue(int128 newValue) external trackIssued {
        // Keep the value in a sane range and occasionally flip it across the
        // YesNo threshold (50) so both YES and NO can be the winning outcome.
        mockStream.setValue(int256(bound(int256(newValue), 1, 1000)));
        try registry.updateValue(adapterStreamId) {
            callCount_updateAdapterValue++;
        } catch {}
    }

    /// Burn for a specific ADAPTER game id (3/4/5). The vote/eligibility/
    /// allocation model is keyed by votable GAME id (not stream id) — the hub's
    /// `vote` gates on `gameExists`, and the round allocation reads
    /// `gameVotesAtRound(gameId)`. So an adapter game only receives a SATORI
    /// pool once weight has been burned for it. This makes the adapter SATORI
    /// conservation invariant have teeth: a weighted adapter game (incl. the
    /// hostile EveryoneWinsGame) can actually be allocated a pool, which the
    /// pin+cap must hold to <= one budget. The Conservation and Rewards
    /// invariants iterate the full game-id range so this stays consistent with
    /// `roundVoteTotal`.
    ///
    /// Deliberately NOT amount-fuzzed — it burns a fixed quarter of the actor's
    /// balance. This is the TARGETED action (AdapterSanity uses it to
    /// concentrate weight on game 3 and prove the adapter rails are reachable);
    /// amount fuzzing over the same game ids is covered by `vote` above, which
    /// spans 2..gameCount. A quarter rather than a half so an actor can drive
    /// both actions repeatedly and still predict.
    /// Vote the ADAPTER STREAM's binary game — the one game on that stream that
    /// can actually be voted.
    ///
    /// This was `voteAdapterGame` and it could never succeed. It targeted an
    /// ADAPTER game (`gameTypeId != 0`), and `SatoriVoting.vote` rejects those
    /// with `GameNotMintEligible`, because only the built-in binary game earns
    /// from the mint. Measured before the fix: 69 fuzz calls, 0 successes. A fuzz
    /// action that cannot succeed is worse than no action, because it reads as
    /// coverage and burns budget providing none.
    ///
    /// Retargeted at the stream's auto-created binary game — its FIRST game,
    /// read from `gamesByStream` rather than assumed. That is the state worth
    /// reaching: an adapter-HOSTED stream carrying real vote weight, which the
    /// adapter games on the same stream then live alongside.
    function voteAdapterStreamGame(uint256 actorSeed, uint256 amountSeed) external trackIssued {
        if (games.gamesByStreamCount(adapterStreamId) == 0) return;
        uint32 gameId = games.gamesByStream(adapterStreamId)[0];
        address actor = _actor(actorSeed);
        // Same at-most-a-quarter cap as before, and for the reason the `vote`
        // action documents: an actor burnt down to nothing stops being a paying
        // predictor and hollows out the reward invariants.
        uint256 spendable = satoriToken.balanceOf(actor) / 4;
        if (spendable == 0) return;
        uint256 amount = bound(amountSeed, 1, spendable);
        vm.prank(actor);
        try satori.vote(gameId, amount) {
            ghostBurned += amount;
            callCount_vote++;
            callCount_voteAdapterStreamGame++;
        } catch {}
    }

    /// Permissionless community game-adapter registration during the fuzz run
    /// (re-registers a hostile mock). Each registration consumes spam fee and
    /// yields a new gameTypeId; we don't create a game off it (the constructor
    /// already wired playable adapter games) — this just exercises the
    /// permissionless registration path + spam-fee burn under fuzzing.
    function registerCommunityAdapter(uint256 actorSeed, uint256 which) external trackIssued {
        address actor = _actor(actorSeed);
        address impl = (which & 1) == 0 ? address(everyoneWinsGame) : address(reentrantGame);
        vm.prank(actor);
        try satori.registerCommunityGameAdapter(impl, "fuzz") {
            callCount_registerCommunityAdapter++;
        } catch {}
    }

    /// Arm/disarm the reentrant adapter so the H4 nonReentrant guard is probed
    /// during settle. Permissionless on the mock.
    function armReentrant(uint256 seed) external trackIssued {
        if ((seed & 1) == 0) {
            try reentrantGame.arm() {} catch {}
        }
    }

    /// Predict on an adapter game via predictMultipleWithPayloads with a
    /// non-zero adapter gameId + payload (first byte = direction for YesNo;
    /// opaque for the hostiles). Records the prediction round so settle can
    /// attribute credit to it. Reverts (stale stream, already-predicted,
    /// delegated, zero-balance) are absorbed as data.
    function predictAdapter(uint256 actorSeed, uint256 gameSeed, uint8 direction) external trackIssued {
        if (adapterGameIds.length == 0) return;
        address actor = _actor(actorSeed);
        uint32 gameId = adapterGameIds[gameSeed % adapterGameIds.length];
        direction = uint8(1 + (uint256(direction) % 2)); // YES(1) / NO(2)
        SatoriTypes.PredictionRequestWithPayload[] memory reqs =
            new SatoriTypes.PredictionRequestWithPayload[](1);
        reqs[0] = SatoriTypes.PredictionRequestWithPayload({
            gameId: gameId,
            payload: abi.encodePacked(direction)
        });
        uint256 round = satori.getCurrentRound();
        vm.prank(actor);
        try engine.predictMultipleWithPayloads(reqs) {
            adapterPendingRound[actor][gameId] = round;
            ghostPredicted[gameId][round] = true;
            callCount_adapterPredict++;
        } catch {}
    }

    /// Settle an adapter prediction. Measures the SATORI + bounty credit the
    /// score produced and attributes it to the round the prediction was MADE
    /// in (the round whose pool/pot the share is drawn from), populating the
    /// ghost the adapter conservation invariants check.
    function settleAdapter(uint256 callerSeed, uint256 ownerSeed, uint256 gameSeed) external trackIssued {
        if (adapterGameIds.length == 0) return;
        address caller = _actor(callerSeed);
        address owner = _actor(ownerSeed);
        uint32 gameId = adapterGameIds[gameSeed % adapterGameIds.length];
        uint256 predRound = adapterPendingRound[owner][gameId];
        if (predRound == 0) return; // nothing pending we can attribute

        uint256 satBefore = rewards.unclaimedRewards(owner);
        uint256 bountyBeforeA = _adapterBountyHeld(address(bountyToken));
        uint256 bountyBeforeB = _adapterBountyHeld(address(bountyTokenB));

        vm.prank(caller);
        try engine.settlePrediction(owner, gameId) {
            callCount_adapterSettle++;
            // Credit attributed to the prediction's round. Use unclaimedRewards
            // delta (adapter SATORI is eager-credited there at score time).
            uint256 satAfter = rewards.unclaimedRewards(owner);
            if (satAfter > satBefore) {
                ghostAdapterSatoriCredited[gameId][predRound] += (satAfter - satBefore);
                _noteCredited(gameId, predRound);
            }
            uint256 bAfterA = _adapterBountyHeld(address(bountyToken));
            uint256 bAfterB = _adapterBountyHeld(address(bountyTokenB));
            if (bAfterA > bountyBeforeA) {
                ghostAdapterBountyCredited[gameId][predRound][address(bountyToken)] +=
                    (bAfterA - bountyBeforeA);
                _noteCredited(gameId, predRound);
            }
            if (bAfterB > bountyBeforeB) {
                ghostAdapterBountyCredited[gameId][predRound][address(bountyTokenB)] +=
                    (bAfterB - bountyBeforeB);
                _noteCredited(gameId, predRound);
            }
            // Clear pending only if the prediction actually reached a terminal
            // state (pending flag consumed). We can't read _adapterPending, so
            // conservatively clear on any non-reverting settle — a still-pending
            // bet just re-arms on the next predict.
            adapterPendingRound[owner][gameId] = 0;
        } catch {}
    }

    /// Sum of bounty token `T` held on behalf of users by the bounty contract
    /// via the adapter payout sinks: every actor's auto-restaked bountyStake.
    /// The bounty payout fee was removed, so the fee recipient's unclaimedBounty
    /// is now always 0 for bounty tokens — it is still summed defensively. The
    /// adapter bounty credit flows entirely into bountyStake now (see
    /// _accrueAdapterBounty), so its growth across a score == the bounty paid out.
    function _adapterBountyHeld(address token) internal view returns (uint256 total) {
        for (uint256 i = 0; i < 5; i++) {
            total += bounties.bountyStake(actors[i], token);
        }
        // (fee-recipient unclaimedBounty term removed with the dead withdraw
        // path — the adapter bounty credit flows entirely into bountyStake — A4.)
    }

    /// View used by the adapter bounty conservation invariant: the dripped pot
    /// for a (game, round, token). roundBountyPot is the fixed denominator-feeder
    /// the adapter bounty shares are drawn from; Σ credited must be <= it.
    function roundPotFor(uint32 gameId, uint256 round, address token)
        external view returns (uint256)
    {
        return bounties.roundBountyPot(gameId, uint32(round), token);
    }

    // ===================================================================
    // ===== Emission schedule fuzz surface =====
    // ===================================================================

    function setEmissionRatio(uint256 seed) external trackIssued {
        uint256 pick = seed % 8;
        uint256 ratio = pick == 0 ? bound(seed, 1, 1e9) // dust: 0 reverts
            : pick <= 2 ? 1e18
            : pick == 3 ? satori.PHI_INV()
            : pick == 4 ? 2e18
            : pick == 5 ? bound(seed, 1e18 + 1, 3e18)
            : bound(seed, 1e17, 3e18);
        vm.prank(satori.emissionHolder());
        try satori.setEmissionRatio(ratio) { callCount_setEmissionRatio++; } catch {}
    }

    function syncEmission() external trackIssued {
        try satori.syncEmission() { callCount_syncEmission++; } catch {}
    }

    /// Stands in for issuance a fuzz sequence is too short to earn: real scoring
    /// adds at most about one round's rate per round, and the first threshold
    /// is FLAT_ROUNDS rounds away.
    function bumpIssued(uint256 amountSeed) external trackIssued {
        uint256 amount = (amountSeed % 6) * 500_000 ether + bound(amountSeed >> 8, 0, 500_000 ether);
        vm.prank(address(rewards));
        try satori.noteIssued(amount) { callCount_bumpIssued++; } catch {}
    }

    function setOffchainBudget(uint256 seed) external trackIssued {
        uint256 res = satori.residualNext();
        if (res == 0) return;
        address holder = rewards.emissionSplitAuthority();
        if (holder == address(0)) holder = rewards.admin();
        vm.prank(holder);
        try rewards.setOffchainBudget(res * (seed % 100) / 100) { callCount_setOffchainBudget++; } catch {}
    }

    function merkleMint(uint256 actorSeed, uint256 amountSeed) external trackIssued {
        uint256 ceiling = satori.merkleReserveCeiling();
        uint256 minted = satori.merkleMinted();
        uint256 room = ceiling > minted ? ceiling - minted : 0;
        uint256 amount = amountSeed % 4 == 0 || room == 0 ? room + 1 : room * (1 + (amountSeed >> 2) % 100) / 100;
        vm.prank(MERKLE);
        try satori.rewardMint(_actor(actorSeed), amount) { callCount_merkleMint++; } catch {}
    }
}
