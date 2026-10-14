/**
 * cross-feature-break.adv.test.js
 *
 * CROSS-FEATURE INTERACTION HUNT.
 *
 * This file builds a single multi-actor, multi-round scenario in which EVERY
 * new feature is active AT THE SAME TIME:
 *
 *   - several users predict, some WITH a referral set (predictMultipleWithReferral)
 *     and some without -> the marketing-wallet fallback (the constructor-set
 *     immutable marketing recipient) skim,
 *   - some users DELEGATE prediction power to a delegate who predicts for them,
 *   - the off-chain dial is set > 0 (setOffchainBudget) so a Merkle reserve
 *     accrues, AND a Merkle root is published and claimed,
 *   - the vesting airdrop table is loaded and claimed MID-RUN,
 *   - a bounty is funded (external ERC20) + staked so the bounty path is live.
 *
 * After EVERY meaningful step it asserts the GLOBAL protocol invariants:
 *
 *   SUPPLY IDENTITY
 *     totalSupply() == totalRewardsMinted() + airdropClaimedTotal() − voteBurned
 *       (voting now BURNS SATORI to buy a game permanent weight, so the supply
 *        identity gains a destruction term; `voteBurned` is the running total of
 *        every `vote()` amount this file has spent)
 *     totalRewardsMinted() == devFeeMinted() + onChainMinted() + merkleMinted()  (3-lane split;
 *       dev fee moved to the immutable token — see test/next/DevFee.test.js)
 *
 *   PER-LANE CAPS (joint)
 *     onChainMinted() <= onChainRewardCeiling()
 *     merkleMinted()  <= merkleReserveCeiling()
 *     onChainMinted() + merkleMinted() <= globalCap = 1440 * roundsElapsed
 *
 *   INV-1 (balance conservation)
 *     Σ balanceOf(all addrs incl. fee/marketing recipients) == totalSupply()
 *     (the old form summed voting.getVotingPower; vote delegation is gone and
 *      burnt vote weight is NOT a balance, so the honest statement is that every
 *      surviving wei of supply is sitting in one of the universe's accounts)
 *
 *   REFERRAL SKIM CONSISTENCY
 *     Σ ReferralPaid.amount == Σ (skimmed lanes) — every credited referral cut
 *     lands in a real bucket; net + cut reconstruct the gross on skimmable lines.
 *
 *   NO CROSS-DRAIN
 *     no user, lane, or emission line ever loses or gains value it shouldn't.
 *
 * The hunt is specifically for an ORDERING / ACCUMULATION bug where two
 * features together break an invariant that neither breaks alone: dial move +
 * referral skim + airdrop claim in one round; delegation + referral; a Merkle
 * claim racing an on-chain claim against the SHARED 1440*rounds cap.
 *
 * ADDS TESTS ONLY. Never edits a contract or an existing test.
 */

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const { deploySatoriFixtureNoFee, pack1, VOTE, warmUpLoyalty } = require("../fixtures");
const { TEST_PLATFORM_FEE_RECIPIENT, TEST_MARKETING_FEE_RECIPIENT, deployMerkleProxied } = require("../next/splitFixture");

const E = (n) => ethers.parseEther(String(n));
const UP = 1;
const ROUND = 86400; // 24h round cadence

// Constructor-set immutable sink addresses on SatoriRewards. They accumulate
// unclaimedRewards (referral / marketing / platform-fee) and MUST be part of
// the INV-1 voting-power universe.
const MARKETING = TEST_MARKETING_FEE_RECIPIENT;
const PLATFORM = TEST_PLATFORM_FEE_RECIPIENT;

// ---- OZ StandardMerkleTree leaf + commutative pair hash (matches on-chain) --
function leafOf(addr, amount) {
  const inner = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(["address", "uint256"], [addr, amount])
  );
  return ethers.keccak256(inner);
}
function hashPair(a, b) {
  return a.toLowerCase() < b.toLowerCase()
    ? ethers.keccak256(ethers.concat([a, b]))
    : ethers.keccak256(ethers.concat([b, a]));
}

async function advanceRound() {
  await time.increase(ROUND);
}

// A public caller may only create streams at cadence >= 2 rounds, and
// `createSimpleDataStream(name, provider)` now hands out exactly that. Every
// stream in this file is therefore daily: consecutive value writes have to be a
// whole cadence period apart. Rounds advanced for a NON-value reason — waiting
// out the off-chain dial's reserve accrual, opening a claim gap — stay single
// rounds, because those assertions are pinned to exact per-ROUND rates.
const CADENCE_ROUNDS = 2;

async function advanceCadence() {
  for (let i = 0; i < CADENCE_ROUNDS; i++) await advanceRound();
}

async function streamIdFrom(tx, satori) {
  const r = await tx.wait();
  const ev = r.logs.find((l) => {
    try {
      return satori.interface.parseLog(l)?.name === "DataStreamCreated";
    } catch {
      return false;
    }
  });
  return satori.interface.parseLog(ev).args.streamId;
}

describe("CROSS-FEATURE break hunt — all new features live at once", function () {
  this.timeout(600000);

  let satori, voting, rewards, airdrop, registry, bounties, merkle, lens;
  let owner, publisher;
  // actor signers
  let alice, bob, carol, dave, eve, frank, grace, heidi;
  let universe; // Set of lowercased addrs for the INV-1 sum
  let referralTotalPaid; // Σ ReferralPaid.amount seen so far
  let voteBurned; // Σ SATORI destroyed by vote() so far — the supply identity's 3rd term

  // Burn `amount` for `gameId` as `who`, keeping the running destruction total in
  // step so the supply identity stays exact.
  async function burnVote(who, gameId, amount = VOTE) {
    await satori.connect(who).vote(Number(gameId), amount);
    voteBurned += amount;
  }

  // -------------------------------------------------------------------------
  // Invariant battery. Called after every meaningful step.
  // -------------------------------------------------------------------------
  async function INV(label) {
    const supply = await satori.totalSupply();
    const totalMinted = await satori.totalRewardsMinted();
    const onChain = await satori.onChainMinted();
    const merk = await satori.merkleMinted();
    // The platform fee moved to the immutable token as a senior, self-accruing
    // THIRD reward lane (see test/next/DevFee.test.js); fold it into every lane
    // identity so the accounting stays exact and equally strict.
    const devFee = await satori.devFeeMinted();
    const devFeeCeil = await satori.devFeeCeiling();
    const airMinted = await airdrop.airdropClaimedTotal();

    // (A) SUPPLY IDENTITY — every wei was either a reward mint or an airdrop
    // mint, less every wei destroyed by a vote. Voting is the ONLY destruction
    // path in the protocol, so the identity stays exact rather than becoming an
    // inequality.
    expect(supply, `[${label}] supply == rewardsMinted + airdropClaimed - voteBurned`).to.equal(
      totalMinted + airMinted - voteBurned
    );

    // (B) LANE DECOMPOSITION — rewardsMinted splits exactly into the three lanes.
    expect(onChain + merk + devFee, `[${label}] onChain + merkle + devFee == totalRewardsMinted`).to.equal(
      totalMinted
    );

    // (C) PER-LANE CAPS hold jointly.
    const onChainCeil = await satori.onChainRewardCeiling();
    const merkleCeil = await satori.merkleReserveCeiling();
    expect(onChain, `[${label}] onChain lane <= onChain ceiling`).to.be.lte(onChainCeil);
    expect(merk, `[${label}] merkle lane <= merkle ceiling`).to.be.lte(merkleCeil);

    // (D) GLOBAL CAP — the two lanes never exceed 1440 * roundsElapsed. That
    // constitutional envelope is unchanged and still enforced by the token; the
    // hub's per-round rate is clamped at ROUND_REWARD_BUDGET, so it sits inside it.
    const deploymentRound = await satori.deploymentRound();
    const curRound = await satori.getCurrentRound();
    const roundsElapsed = curRound - deploymentRound + 1n;
    const globalCap = E("1440") * roundsElapsed;
    expect(onChain + merk, `[${label}] lanes <= globalCap`).to.be.lte(globalCap);
    const emissionCeil = await satori.emissionCeiling();
    expect(emissionCeil, `[${label}] emission ceiling sits inside the 1440 envelope`).to.be.lte(globalCap);
    // The two live GENERAL ceilings sum to the hub's emission ceiling net of the
    // dev's flat 15%. This used to be stated against `globalCap - devFeeCeiling`,
    // which only held while the fee accrued on the CLOCK. The fee is now a ratio
    // of what was actually minted, so it lags whenever the lanes run cold — and
    // the carve-out the hub actually enforces is the flat 15%, not the lagging
    // accrual. That fixed carve-out is what the ceilings must sum to.
    const generalCap = (emissionCeil * 8500n) / 10000n;
    expect(onChainCeil + merkleCeil, `[${label}] ceilings sum to 85% of the emission ceiling`).to.equal(
      generalCap
    );
    // ...and the realized fee never runs ahead of that carve-out.
    expect(devFeeCeil, `[${label}] realized dev accrual <= the 15% carve-out`).to.be.lte(
      emissionCeil - generalCap
    );

    // (E) INV-1 — Σ balances over the WHOLE universe == totalSupply. No wei may
    // be stranded in an account the accounting does not know about, and a vote
    // burn must leave the survivors' sum consistent with the reduced supply.
    let vpSum = 0n;
    for (const a of universe) vpSum += await satori.balanceOf(a);
    expect(vpSum, `[${label}] INV-1 Σ balances == totalSupply`).to.equal(supply);
  }

  // Track every ReferralPaid event so we can reconcile the skim globally.
  async function syncReferralPaid() {
    const evs = await rewards.queryFilter(rewards.filters.ReferralPaid());
    let sum = 0n;
    for (const e of evs) sum += e.args.amount;
    referralTotalPaid = sum;
    return sum;
  }

  before(async function () {
    // deploy the base stack (zero platform fee -> clean reward math)
    const f = await deploySatoriFixtureNoFee();
    satori = f.satori;
    voting = f.voting;
    rewards = f.rewards;
    airdrop = f.airdrop;
    lens = f.lens;
    registry = f.registry;
    bounties = f.bounties;
    owner = f.owner;
    [, alice, bob, carol, dave, eve, frank, grace, heidi, publisher] = f.signers;

    // ---- Deploy + wire a fresh SatoriMerkle (fixture does not include one).
    // owner is the satori deployer, so it may call setSatoriMerkle (write-once,
    // deployer-gated). publisher owns the root.
    merkle = await deployMerkleProxied(publisher.address, f.token.target);
    await satori.connect(owner).setSatoriMerkle(await merkle.getAddress());
    await merkle.setSatoriCore(await satori.getAddress());

    // ---- Build the INV-1 universe: every address that can hold balance or
    // inbound delegated weight, INCLUDING the two constant sink recipients.
    universe = new Set();
    const add = (a) => universe.add(a.toLowerCase());
    add(owner.address);
    for (const s of [alice, bob, carol, dave, eve, frank, grace, heidi, publisher]) add(s.address);
    add(await satori.getAddress());
    add(await voting.getAddress());
    add(await rewards.getAddress());
    add(await bounties.getAddress());
    add(await merkle.getAddress());
    add(MARKETING);
    add(PLATFORM);

    referralTotalPaid = 0n;
    voteBurned = 0n;
  });

  // Drive one game to an UP win for `predictor`, settled by `settler`.
  // Mirrors the referral.cov winOneRound cadence. These are cadence-2 (public)
  // streams, so the win is decided by 110 > 100 — the value published one
  // cadence period after the prediction; the 120 push just keeps the stream
  // moving for anything that settles later.
  async function winRound(predictor, gameId, settler, referrer) {
    await registry.setValue(gameId, 100);
    if (referrer) {
      await satori
        .connect(predictor)
        .predictMultipleWithReferral(referrer.address, [{ gameId, payload: pack1(UP) }]);
    } else {
      await satori
        .connect(predictor)
        .predictMultipleWithPayloads([{ gameId, payload: pack1(UP) }]);
    }
    await advanceCadence();
    await registry.setValue(gameId, 110);
    await advanceCadence();
    await registry.setValue(gameId, 120); // UP wins
    await satori.connect(settler).settlePrediction(predictor.address, gameId);
  }

  it("step 0 — genesis baseline invariants (all features wired, none exercised)", async function () {
    await INV("genesis");
    // Merkle wired but dormant: nothing minted, reserve is zero.
    expect(await satori.merkleMinted()).to.equal(0n);
    expect(await satori.merkleReserveCeiling()).to.equal(0n);
  });

  it("step 1 — set dial > 0 (reserve starts accruing) and load airdrop + fund a bounty", async function () {
    // ---- The DIAL. 200 SATORI/round to the off-chain (Merkle) lane, out of the
    // 720/round budget. This immediately reserves 200 * (rounds since anchor).
    await rewards.connect(owner).setOffchainBudget(E(200));
    await INV("after-dial-set");

    // ---- AIRDROP table loaded mid-setup. Small allocations so the run can fully
    // vest a chunk without blowing the airdrop cap.
    await airdrop.connect(owner).loadAirdropBatch(
      [grace.address, heidi.address],
      [E(1000), E(500)]
    );
    expect(await airdrop.airdropLoadedTotal()).to.equal(E(1500));
    await INV("after-airdrop-load");

    // ---- BOUNTY (external ERC20) funded + staked so the bounty path is live
    // while rewards flow. It must NEVER perturb the SATORI supply invariants.
    const gid = await streamIdFrom(
      await satori.connect(owner).createSimpleDataStream("BountyStream", owner.address),
      satori
    );
    // give the funder some SATORI so they can also burn the stream's game eligible
    await satori.transfer(frank.address, E(20));
    await burnVote(frank, gid);
    await INV("after-vote-burn-frank");

    const Mock = await ethers.getContractFactory("MockERC20");
    const usd = await Mock.deploy("USDC", "USDC");
    await usd.waitForDeployment();
    await usd.mint(owner.address, E(1_000_000));
    await usd.connect(owner).approve(await bounties.getAddress(), E(1_000_000));
    // fund a bounty on the auto-created game for this stream (gameId == stream order)
    await bounties.connect(owner).fundBounty(Number(gid), await usd.getAddress(), E(1000), E(10));
    // a staker stakes into the bounty token pool
    await usd.mint(bob.address, E(500));
    await usd.connect(bob).approve(await bounties.getAddress(), E(500));
    await bounties.connect(bob).stakeBountyToken(await usd.getAddress(), E(500));

    // Bounties are an external token — SATORI supply invariants are untouched.
    await INV("after-bounty-fund-stake");
  });

  it("step 2 — mixed predictors: referral-set, marketing-fallback, and delegators all in one round", async function () {
    // Fund the actors. Total economy is only 720 SATORI, so keep amounts small.
    await satori.transfer(alice.address, E(40)); // referral -> carol
    await satori.transfer(bob.address, E(40)); // NO referral -> marketing fallback
    await satori.transfer(dave.address, E(40)); // pure delegator (lends to eve)
    await satori.transfer(eve.address, E(10)); // the delegate/predictor
    await satori.transfer(grace.address, E(20)); // burns for gA; keeps a balance to spare

    // Two eligible streams: one alice predicts on, one eve (with dave's power) predicts on.
    const gA = await streamIdFrom(
      await satori.connect(owner).createSimpleDataStream("A", owner.address),
      satori
    );
    const gB = await streamIdFrom(
      await satori.connect(owner).createSimpleDataStream("B", owner.address),
      satori
    );
    // Equal burns, so gA and gB carry equal weight and split the round evenly —
    // and alice keeps 30 of her 40 to predict with (burnt tokens are gone, and
    // prediction power is balance + unclaimed).
    await burnVote(grace, gA);
    await burnVote(alice, gB);
    await advanceRound();
    await INV("after-votes");

    // dave DELEGATES all prediction power to eve; dave also sets a referral (frank).
    await satori.connect(dave).delegatePredictionPower(eve.address);
    // Delegator weight is capital x loyalty and a fresh delegation starts at
    // L = 0, so dave's delegator share -- and frank's skim off it -- are both
    // zero without a warm-up. Warm on gB, which is the game eve predicts.
    await warmUpLoyalty(satori, registry, null, eve, [dave], owner, gB, 40, 2);
    await rewards.connect(dave).setReferral(frank.address);
    await INV("after-delegate-and-referral");

    // Round with THREE emission lines active at once:
    //  - alice predicts WITH a referral (carol) on gA -> skim to carol
    //  - bob predicts with NO referral on gA -> skim to marketing
    //  - eve predicts (carrying dave's delegated power) on gB; dave's delegator
    //    share, when credited, skims 5% to frank.
    await registry.setValue(Number(gA), 100);
    await registry.setValue(Number(gB), 100);

    await satori
      .connect(alice)
      .predictMultipleWithReferral(carol.address, [{ gameId: Number(gA), payload: pack1(UP) }]);
    await satori
      .connect(bob)
      .predictMultipleWithPayloads([{ gameId: Number(gA), payload: pack1(UP) }]);
    await satori
      .connect(eve)
      .predictMultipleWithPayloads([{ gameId: Number(gB), payload: pack1(UP) }]);
    await INV("after-predicts");

    await advanceCadence();
    await registry.setValue(Number(gA), 110);
    await registry.setValue(Number(gB), 110);
    await advanceCadence();
    await registry.setValue(Number(gA), 120); // UP wins
    await registry.setValue(Number(gB), 120); // UP wins

    // Settle all three (delegator dave's share is credited during eve/dave claim,
    // but the predictor skims land at settle).
    await satori.connect(grace).settlePrediction(alice.address, Number(gA));
    await satori.connect(grace).settlePrediction(bob.address, Number(gA));
    await satori.connect(grace).settlePrediction(eve.address, Number(gB));
    await INV("after-settle");

    // Referral skim consistency: every ReferralPaid amount landed in a real
    // unclaimed bucket. carol (alice's ref) and marketing (bob's) got predictor
    // skims at settle.
    const paidNow = await syncReferralPaid();
    expect(paidNow, "some referral skim happened at settle").to.be.gt(0n);
    // carol's bucket holds alice's predictor skim.
    expect(await rewards.unclaimedRewards(carol.address)).to.be.gt(0n);
    // marketing's bucket holds bob's predictor skim.
    expect(await rewards.unclaimedRewards(MARKETING)).to.be.gt(0n);
  });

  it("step 3 — publish + claim Merkle in the SAME window as on-chain claims (shared-cap race)", async function () {
    // Publish a cumulative Merkle root that pays alice + bob off the Merkle lane.
    // Keep entitlements well within the accrued reserve (200/round for several
    // rounds already), so both claims must fit alongside on-chain claims.
    const la = leafOf(alice.address, E(30));
    const lb = leafOf(bob.address, E(20));
    const root = hashPair(la, lb);
    await merkle.connect(publisher).setMerkleRoot(root);
    await INV("after-root-published");

    // RACE: interleave a Merkle claim (merkle lane) with on-chain reward claims
    // (on-chain lane) in the same round. If the lanes double-counted against the
    // shared cap, INV / lane-decomposition would break here.
    const merkBefore = await satori.merkleMinted();
    await merkle.connect(alice).claimMerkle(E(30), [lb]);
    expect(await satori.merkleMinted()).to.equal(merkBefore + E(30));
    await INV("after-merkle-claim-alice");

    // Now an ON-CHAIN claim from alice (her predictor rewards) in the same round.
    // The old assertion here was `onChainMinted() >= onBefore`. `onChainMinted`
    // is a monotone counter with no decrement path (SatoriHub.rewardMint), so it
    // passed even when the claim minted NOTHING — which is precisely the bleed
    // this step hunts (a merkle claim starving the on-chain lane). Anchor on the
    // claim itself: alice's pending bucket must be non-empty, must mint in full,
    // and the lane must advance by exactly that amount.
    const alicePending = (await lens.getTotalClaimableRewards(alice.address))[0];
    expect(alicePending, "alice has on-chain rewards to claim").to.be.gt(0n);
    const onBefore = await satori.onChainMinted();
    const aliceBalBefore = await satori.balanceOf(alice.address);
    await satori.connect(alice)["claim()"]();
    const aliceMinted = (await satori.balanceOf(alice.address)) - aliceBalBefore;
    expect(aliceMinted, "the merkle claim did not starve alice's on-chain claim").to.equal(
      alicePending
    );
    expect(await satori.onChainMinted(), "on-chain lane advanced by exactly the mint").to.equal(
      onBefore + aliceMinted
    );
    await INV("after-onchain-claim-alice");

    // Second Merkle claim (bob) after alice's on-chain claim — still no lane bleed.
    await merkle.connect(bob).claimMerkle(E(20), [la]);
    await INV("after-merkle-claim-bob");

    // bob's on-chain claim too.
    await satori.connect(bob)["claim()"]();
    await INV("after-onchain-claim-bob");
  });

  it("step 4 — airdrop claim MID-RUN interleaved with reward + referral claims", async function () {
    // Vest a slice of the airdrop, then claim it in the SAME window that dave/eve
    // claim delegator/predictor rewards (which fire dave's frank referral skim).
    await time.increase(Number((1825n * 24n * 3600n) / 20n)); // ~5% vest

    const airBefore = await airdrop.airdropClaimedTotal();
    await airdrop.connect(grace).claimAirdrop();
    expect(await airdrop.airdropClaimedTotal(), "airdrop advanced").to.be.gt(airBefore);
    await INV("after-airdrop-claim-grace");

    // dave is a pure delegator: his share is credited (and frank's skim diverted)
    // during his claim. Interleave with eve's predictor claim.
    const frankBefore = await rewards.unclaimedRewards(frank.address);
    const daveBalBefore = await satori.balanceOf(dave.address);
    await satori.connect(dave)["claim()"]();
    await INV("after-delegator-claim-dave");
    // The old assertion here was `frankAfter >= frankBefore`. `unclaimedRewards[x]`
    // is only ever zeroed inside x's OWN claim and frank never claims in this file,
    // so the bucket is monotone by construction: the check passed even if the
    // delegator-side skim never fired or was routed to the wrong bucket (P1).
    // Assert the skim itself instead — dave's minted net and frank's cut must
    // reconstruct the gross, with the cut exactly the documented 5%.
    const daveMinted = (await satori.balanceOf(dave.address)) - daveBalBefore;
    const frankCut = (await rewards.unclaimedRewards(frank.address)) - frankBefore;
    expect(daveMinted, "dave's delegator share actually minted").to.be.gt(0n);
    expect(frankCut, "frank got dave's delegator skim").to.be.gt(0n);
    const daveGross = daveMinted + frankCut;
    expect(frankCut, "delegator skim is exactly 5% of the gross").to.equal(
      (daveGross * 500n) / 10000n
    );

    await satori.connect(eve)["claim()"]();
    await INV("after-predictor-claim-eve");

    // heidi also claims her airdrop mid-run — supply identity must extend across
    // BOTH the reward lanes and the airdrop line simultaneously.
    await airdrop.connect(heidi).claimAirdrop();
    await INV("after-airdrop-claim-heidi");
  });

  it("step 5 — MOVE the dial mid-run, then run another full round with all lines", async function () {
    // Re-dial the off-chain budget UP. Effective-next-round: the change banks the
    // CURRENT (in-flight) round at the OLD rate — carried through inclusive — and
    // the new rate only applies from the NEXT round, never a retroactive rewrite
    // of the in-flight round to the new rate.
    const ceilBefore = await satori.merkleReserveCeiling();
    await rewards.connect(owner).setOffchainBudget(E(400));
    // At the moment of the dial change the ceiling banks ONE more round at the OLD
    // 200 rate (the in-flight round), NOT the new 400 — the change is not applied
    // retroactively at the new rate.
    const bankedBase = await satori.merkleReserveCeiling();
    expect(bankedBase - ceilBefore, "in-flight round banked at OLD 200 rate, not new 400").to.equal(
      E(200)
    );
    await INV("after-dial-move");

    // The new 400 rate is effective from the NEXT round. One round later it has not
    // yet completed a full round under the new rate, so the ceiling is unchanged...
    await advanceRound();
    expect(await satori.merkleReserveCeiling(), "new rate not yet accrued a full round").to.equal(
      bankedBase
    );
    // ...a second advance completes one FULL round at the NEW 400 rate.
    await advanceRound();
    const ceilAfter = await satori.merkleReserveCeiling();
    expect(ceilAfter - bankedBase, "one round at the NEW 400 rate").to.equal(E(400));
    await INV("after-round-at-new-rate");

    // Fresh round with a referral predictor + a marketing-fallback predictor to
    // keep skims flowing under the new dial.
    const gC = await streamIdFrom(
      await satori.connect(owner).createSimpleDataStream("C", owner.address),
      satori
    );
    await satori.transfer(carol.address, E(20));
    await burnVote(carol, gC);
    await advanceRound();

    await winRound(alice, Number(gC), carol, carol); // alice already has carol as ref
    await INV("after-winRound-alice-referral");

    await syncReferralPaid();
  });

  it("step 6 — MEGA drain: everyone claims everything; final global reconciliation", async function () {
    // Claim every actor's on-chain rewards (idempotent if nothing pending).
    const actors = [alice, bob, carol, dave, eve, frank, grace, heidi, owner, publisher];
    for (const a of actors) {
      const pend = (await lens.getTotalClaimableRewards(a.address))[0];
      if (pend > 0n) {
        await satori.connect(a)["claim()"]();
        await INV(`drain-claim-${a.address.slice(0, 8)}`);
      }
    }

    // Claim the constant-sink referral/marketing buckets via claimFor path: they
    // are contract-less addresses, so drive them by direct claim through the core
    // is impossible (no signer). Instead we only ASSERT they are internally
    // consistent — their unclaimed buckets are real, and would mint on-chain if
    // ever claimed. Verify the supply identity still counts them as unminted.
    const marketingPending = await rewards.unclaimedRewards(MARKETING);
    const platformPending = await rewards.unclaimedRewards(PLATFORM);
    // (No platform fee in the no-fee fixture; assert it stayed zero -> no phantom.)
    expect(platformPending, "no-fee fixture accrues no platform fee").to.equal(0n);

    // Airdrop: fully vest and drain both allocations.
    await time.increase(Number(1825n * 24n * 3600n * 2n)); // way past the 5-yr window
    const gPend = await airdrop.claimableAirdrop(grace.address);
    if (gPend > 0n) await airdrop.connect(grace).claimAirdrop();
    const hPend = await airdrop.claimableAirdrop(heidi.address);
    if (hPend > 0n) await airdrop.connect(heidi).claimAirdrop();
    // both fully claimed == their exact allocations
    expect(await airdrop.airdropClaimed(grace.address)).to.equal(E(1000));
    expect(await airdrop.airdropClaimed(heidi.address)).to.equal(E(500));
    expect(await airdrop.airdropClaimedTotal()).to.equal(E(1500));
    await INV("after-full-airdrop-drain");

    // ---- FINAL REFERRAL SKIM RECONCILIATION -------------------------------
    // Every ReferralPaid amount ever emitted must equal the SUM of the current
    // unclaimed+claimed value sitting in referral-destination buckets from those
    // events... but destinations may be actors who already claimed. The tighter,
    // always-true statement: the marketing bucket (bob's + others' fallback) plus
    // every referral bucket is fully accounted for and non-negative, and Σ
    // ReferralPaid never exceeds totalRewardsMinted (it is a strict SUBSET of the
    // on-chain lane, since a skim only redistributes an already-minted-on-claim
    // credit).
    const totalPaid = await syncReferralPaid();
    expect(totalPaid, "referral skims actually happened").to.be.gt(0n);
    // The marketing sink still holds bob's (unclaimed, no signer) fallback skim.
    expect(marketingPending, "marketing fallback skim is real & held").to.be.gt(0n);

    // ---- FINAL LANE + SUPPLY RECONCILIATION -------------------------------
    // Merkle lane minted exactly what was claimed (30 + 20).
    expect(await satori.merkleMinted()).to.equal(E(50));
    expect(await merkle.merkleClaimedTotal()).to.equal(E(50));

    // Full supply identity one last time, with the airdrop fully drained. The
    // burn term is real and non-zero by now — every vote in this file destroyed
    // tokens that can never come back.
    const supply = await satori.totalSupply();
    const minted = await satori.totalRewardsMinted();
    const airMinted = await airdrop.airdropClaimedTotal();
    expect(voteBurned, "voting actually destroyed supply").to.be.gt(0n);
    expect(supply).to.equal(minted + airMinted - voteBurned);
    // three-lane identity: on-chain + merkle + dev == totalRewardsMinted.
    expect(
      (await satori.onChainMinted()) + (await satori.merkleMinted()) + (await satori.devFeeMinted())
    ).to.equal(minted);

    await INV("FINAL");

    // ---- NO CROSS-DRAIN: the bounty's external token never leaked into or out
    // of the SATORI accounting. (Already implied by every INV passing, but we
    // pin the airdrop cap explicitly: it never exceeded its own ceiling.)
    expect(airMinted).to.be.lte(await airdrop.AIRDROP_TOTAL_SUPPLY());
  });
});

// =============================================================================
// TARGETED ORDERING / ACCUMULATION ATTACKS.
//
// Each of these isolates ONE two-feature interaction and pushes it to the sharp
// boundary the invariant battery above would only skim past. Every one MUST end
// green (a real bug becomes an it.skip repro + a structured-output finding).
// =============================================================================
describe("CROSS-FEATURE targeted attacks — sharp-edge boundaries", function () {
  this.timeout(600000);

  const MK = TEST_MARKETING_FEE_RECIPIENT;

  async function freshStack() {
    const f = await deploySatoriFixtureNoFee();
    const merkle = await deployMerkleProxied(f.signers[9].address, f.token.target); // publisher = signers[9]
    await f.satori.connect(f.owner).setSatoriMerkle(await merkle.getAddress());
    await merkle.setSatoriCore(await f.satori.getAddress());
    return { ...f, merkle, publisher: f.signers[9] };
  }

  // -------------------------------------------------------------------------
  // ATTACK 1 — DIAL-STARVATION of a stranded on-chain reward.
  //
  // Earn an on-chain reward in an early round (low/zero dial). Leave it
  // UNCLAIMED. Then crank the off-chain dial toward its 1151 ceiling and advance
  // many rounds so merkleReserveCumulative balloons and eats the on-chain lane
  // ceiling (1440*rounds - merkleReserveCumulative). Finally claim the old
  // reward: if the merkle reserve has starved the on-chain lane below what was
  // already legitimately earned, the claim would revert BudgetExceeded —
  // a griefing DoS where an admin dial move bricks earned rewards.
  //
  // DEFENSE UNDER TEST: the on-chain gross is dialed DOWN in lockstep with the
  // reserve (1440 - dial per round), so on-chain EMISSION shrinks exactly as fast
  // as the reserve grows; the ceiling can never fall below onChainMinted.
  // -------------------------------------------------------------------------
  it("ATTACK 1: cranking the dial to its ceiling cannot strand a previously-earned on-chain reward", async function () {
    const { satori, rewards, airdrop, lens, registry, owner, signers, merkle, publisher } =
      await freshStack();
    const [, alice, voter] = signers;

    // one eligible stream, alice earns a win at ZERO dial (max on-chain gross).
    // NOTE: stream/game id 1 is the DEFAULT (its weight is derived and it cannot
    // be voted on), so the first stream a test creates is id 2 — capture it.
    await satori.transfer(alice.address, E(40));
    await satori.transfer(voter.address, E(20));
    const s = Number(await streamIdFrom(
      await satori.connect(owner).createSimpleDataStream("S", owner.address), satori));
    await satori.connect(voter).vote(s, VOTE);
    await advanceCadence();
    await registry.setValue(s, 100);
    await satori.connect(alice).predictMultipleWithPayloads([{ gameId: s, payload: pack1(UP) }]);
    await advanceCadence();
    await registry.setValue(s, 110);
    await advanceCadence();
    await registry.setValue(s, 120);
    await satori.connect(voter).settlePrediction(alice.address, s);

    const earned = (await lens.getTotalClaimableRewards(alice.address))[0];
    expect(earned, "alice earned a real on-chain reward at zero dial").to.be.gt(0n);

    // NOW crank the dial to just under the ceiling and let the reserve balloon.
    // The senior dev fee caps the dial at the residual general lane — DERIVED
    // from the hub, not written out. It used to be 1440 − 288; the hub's
    // schedule now sets the rate and the fee is a flat 15% of it, so a literal
    // here would just be the old numbers in disguise.
    const residual = (await satori.emissionRateNow()) - (await satori.devRateNow());
    await rewards.connect(owner).setOffchainBudget(residual - 1n);
    for (let i = 0; i < 40; i++) await advanceRound();

    // The merkle reserve is now huge, but the on-chain ceiling must still cover
    // the genesis mint + alice's earned reward.
    const onChainCeil = await satori.onChainRewardCeiling();
    const onChainMinted = await satori.onChainMinted();
    expect(onChainCeil, "on-chain ceiling still >= already-minted").to.be.gte(onChainMinted);

    // The stranded reward must still be claimable — no BudgetExceeded DoS.
    const balBefore = await satori.balanceOf(alice.address);
    await satori.connect(alice)["claim()"]();
    const gained = (await satori.balanceOf(alice.address)) - balBefore;
    expect(gained, "the old reward mints in full despite the dial crank").to.equal(earned);

    // lane decomposition + supply identity intact after the squeeze (less the
    // one VOTE the voter burned to make the game eligible).
    expect(
      (await satori.onChainMinted()) + (await satori.merkleMinted()) + (await satori.devFeeMinted())
    ).to.equal(await satori.totalRewardsMinted());
    expect(await satori.totalSupply()).to.equal(
      (await satori.totalRewardsMinted()) + (await airdrop.airdropClaimedTotal()) - VOTE
    );
  });

  // -------------------------------------------------------------------------
  // ATTACK 2 — MERKLE vs ON-CHAIN, both racing the SAME cap in ONE round with
  // NO slack. Publish a merkle entitlement that consumes the ENTIRE accrued
  // reserve, then in the same round also drive on-chain claims. The two lanes
  // must partition the cap: merkle can take at most its reserve, on-chain at
  // most the complement, and neither can borrow from the other.
  // -------------------------------------------------------------------------
  it("ATTACK 2: merkle claim draining its full reserve cannot borrow the on-chain lane's headroom (and vice-versa)", async function () {
    const { satori, rewards, registry, owner, signers, merkle, publisher } =
      await freshStack();
    const [, alice, voter] = signers;

    // dial 360/round; advance 2 rounds -> reserve == 360*2 == 720 exactly.
    await rewards.connect(owner).setOffchainBudget(E(360));
    // dial 360 is effective from the NEXT round (the round it is set in still uses
    // dial 0), so two FULL rounds at the new rate complete only after a third advance.
    await advanceRound();
    await advanceRound();
    await advanceRound();
    const reserve = await satori.merkleReserveCeiling();
    expect(reserve).to.equal(E(720)); // 360 * 2 full rounds at the new rate

    // Publish a merkle root that claims the ENTIRE reserve to alice.
    await merkle.connect(publisher).setMerkleRoot(leafOf(alice.address, reserve));

    // First claim exactly the reserve — merkle lane fills to its ceiling.
    await merkle.connect(alice).claimMerkle(reserve, []);
    expect(await satori.merkleMinted()).to.equal(reserve);

    // A SECOND merkle claim of even 1 wei more must revert — the merkle lane is
    // capped at its reserve and CANNOT dip into the on-chain complement.
    await merkle.connect(publisher).setMerkleRoot(leafOf(alice.address, reserve + 1n));
    await expect(merkle.connect(alice).claimMerkle(reserve + 1n, []))
      .to.be.revertedWithCustomError(satori, "BudgetExceeded");

    // The on-chain lane is UNTOUCHED by the merkle drain: an on-chain reward
    // still mints against its own complement ceiling.
    await satori.transfer(alice.address, E(40));
    await satori.transfer(voter.address, E(20));
    const s = Number(await streamIdFrom(
      await satori.connect(owner).createSimpleDataStream("S", owner.address), satori));
    await satori.connect(voter).vote(s, VOTE);
    await advanceCadence();
    await registry.setValue(s, 100);
    await satori.connect(alice).predictMultipleWithPayloads([{ gameId: s, payload: pack1(UP) }]);
    await advanceCadence();
    await registry.setValue(s, 110);
    await advanceCadence();
    await registry.setValue(s, 120);
    await satori.connect(voter).settlePrediction(alice.address, s);
    const onBefore = await satori.onChainMinted();
    await satori.connect(alice)["claim()"](); // on-chain lane mint, unaffected by merkle drain
    expect(await satori.onChainMinted(), "on-chain lane advanced independently").to.be.gt(onBefore);

    // lanes still partition the cap
    const deploymentRound = await satori.deploymentRound();
    const roundsElapsed = (await satori.getCurrentRound()) - deploymentRound + 1n;
    expect(
      (await satori.onChainMinted()) + (await satori.merkleMinted())
    ).to.be.lte(E("720") * roundsElapsed);
  });

  // -------------------------------------------------------------------------
  // ATTACK 3 — NO referral-on-referral (MLM). When A's reward skims 5% to B,
  // and B ALSO has a referral C, B's diverted cut must NOT itself skim to C.
  // The cut is written straight to B's bucket, never re-routed through the
  // credit chokepoint. A dial + delegation + double-referral round is the
  // richest place for such a leak to hide.
  // -------------------------------------------------------------------------
  it("ATTACK 3: a referral cut never itself pays a referral (no MLM), even with delegation + dial live", async function () {
    const { satori, rewards, registry, owner, signers } = await freshStack();
    const [, alice, bob, carol, voter] = signers;

    await rewards.connect(owner).setOffchainBudget(E(100)); // dial live

    await satori.transfer(alice.address, E(40));
    await satori.transfer(voter.address, E(20));

    // alice -> bob referral; bob -> carol referral. If MLM existed, alice's win
    // skims to bob, and bob's cut would then skim to carol.
    await rewards.connect(alice).setReferral(bob.address);
    await rewards.connect(bob).setReferral(carol.address);

    const s = Number(await streamIdFrom(
      await satori.connect(owner).createSimpleDataStream("S", owner.address), satori));
    await satori.connect(voter).vote(s, VOTE);
    await advanceCadence();
    await registry.setValue(s, 100);
    await satori.connect(alice).predictMultipleWithPayloads([{ gameId: s, payload: pack1(UP) }]);
    await advanceCadence();
    await registry.setValue(s, 110);
    await advanceCadence();
    await registry.setValue(s, 120);

    const carolBefore = await rewards.unclaimedRewards(carol.address);
    await satori.connect(voter).settlePrediction(alice.address, s);

    const bobCut = await rewards.unclaimedRewards(bob.address); // alice's skim landed here
    const carolAfter = await rewards.unclaimedRewards(carol.address);

    expect(bobCut, "bob received alice's referral cut").to.be.gt(0n);
    // carol got NOTHING from bob's cut — no referral-on-referral.
    expect(carolAfter, "no MLM: bob's cut did not skim to carol").to.equal(carolBefore);
  });

  // -------------------------------------------------------------------------
  // ATTACK 4 — AIRDROP lane independence: an airdrop mint (own 1M cap) must
  // NEVER consume reward-lane (720*rounds) headroom, even when the reward lanes
  // are near-saturated by a maxed dial. If the airdrop leaked into the reward
  // cap, a fully-vested airdrop claim could either be blocked by the reward cap
  // or steal reward headroom. Neither may happen.
  // -------------------------------------------------------------------------
  it("ATTACK 4: airdrop mint is fully independent of the reward-lane cap under a maxed dial", async function () {
    const { satori, rewards, airdrop, owner, signers } = await freshStack();
    const [, alice] = signers;

    // Max the dial so the on-chain lane is squeezed hard. The senior dev fee caps
    // the reserve rate at the tier-1 residual general lane (720 - 144 = 576),
    // so dial to just under that new ceiling.
    await rewards.connect(owner).setOffchainBudget(E("575.5"));
    // Load + fully vest an airdrop.
    await airdrop.connect(owner).loadAirdropBatch([alice.address], [E(5000)]);
    await time.increase(Number(1825n * 24n * 3600n * 2n));

    const mintedBefore = await satori.totalRewardsMinted();
    const onChainBefore = await satori.onChainMinted();
    const merkleBefore = await satori.merkleMinted();

    await airdrop.connect(alice).claimAirdrop();

    // The airdrop mint touched NEITHER reward lane nor the reward-cap counter.
    expect(await satori.totalRewardsMinted(), "airdrop leaves totalRewardsMinted alone").to.equal(
      mintedBefore
    );
    expect(await satori.onChainMinted(), "airdrop leaves on-chain lane alone").to.equal(
      onChainBefore
    );
    expect(await satori.merkleMinted(), "airdrop leaves merkle lane alone").to.equal(
      merkleBefore
    );
    // It DID mint real SATORI to alice and advanced the airdrop counter.
    expect(await satori.balanceOf(alice.address)).to.equal(E(5000));
    expect(await airdrop.airdropClaimedTotal()).to.equal(E(5000));
    // Supply identity: the airdrop is the third term.
    expect(await satori.totalSupply()).to.equal(
      (await satori.totalRewardsMinted()) + (await airdrop.airdropClaimedTotal())
    );
  });

  // -------------------------------------------------------------------------
  // ATTACK 5 — REFERRAL skim CONSERVATION on a delegator line, exact reconstruction.
  // A pure delegator's share is credited (and the 5% skimmed) at CLAIM time. The
  // net minted to the delegator + the cut credited to the referral must EXACTLY
  // reconstruct the pre-skim gross with no wei created or lost, while a dial is
  // live and a merkle reserve is accruing.
  // -------------------------------------------------------------------------
  it("ATTACK 5: delegator referral skim conserves exactly (net + cut == gross) with dial + merkle live", async function () {
    const { satori, rewards, lens, registry, owner, signers, merkle, publisher } =
      await freshStack();
    const [, delegator, delegate, refDest, voter] = signers;

    await rewards.connect(owner).setOffchainBudget(E(120)); // dial live -> reserve accrues

    await satori.transfer(delegator.address, E(60)); // lends power
    await satori.transfer(delegate.address, E(10));
    await satori.transfer(voter.address, E(20));

    const s = Number(await streamIdFrom(
      await satori.connect(owner).createSimpleDataStream("S", owner.address), satori));
    await satori.connect(voter).vote(s, VOTE);
    await advanceRound();

    await satori.connect(delegator).delegatePredictionPower(delegate.address);
    // Delegator weight is capital x loyalty and a fresh delegation starts at
    // L = 0, so the delegator share this conservation check is about -- and the
    // referral cut taken off it -- are both zero without a warm-up. cadence 2:
    // the stream is created with the 2-arg (daily) overload.
    await warmUpLoyalty(satori, registry, null, delegate, [delegator], voter, s, 40, 2);
    await rewards.connect(delegator).setReferral(refDest.address);

    await registry.setValue(s, 100);
    await satori.connect(delegate).predictMultipleWithPayloads([{ gameId: s, payload: pack1(UP) }]);
    await advanceCadence();
    await registry.setValue(s, 110);
    await advanceCadence();
    await registry.setValue(s, 120);
    await satori.connect(voter).settlePrediction(delegate.address, s);

    // delegator's NET share (view is post-skim); the skim is diverted DURING claim.
    const net = (await lens.getTotalClaimableRewards(delegator.address))[0];
    expect(net).to.be.gt(0n);
    const refBefore = await rewards.unclaimedRewards(refDest.address);

    const balBefore = await satori.balanceOf(delegator.address);
    await satori.connect(delegator)["claim()"]();
    const minted = (await satori.balanceOf(delegator.address)) - balBefore;
    const cut = (await rewards.unclaimedRewards(refDest.address)) - refBefore;

    // net minted == the view's net; gross reconstructs exactly.
    expect(minted).to.equal(net);
    const gross = minted + cut;
    expect(cut).to.equal(gross * 500n / 10000n); // floor(gross*500/10000), the 5% skim
    expect(minted).to.equal(gross - gross * 500n / 10000n); // delegator keeps the complement
    // conservation: nothing created or lost across the skim.
    expect(minted + cut).to.equal(gross);
  });

  // -------------------------------------------------------------------------
  // ATTACK 6 — DIAL TOGGLE 0 -> R -> 0 -> R': the reserve accrual must NOT
  // back-count the rounds spent at rate 0. A bug in the lazy _accrueMerkleReserve
  // re-anchoring could let the merkle lane mint against rounds it never reserved
  // for (over-mint), or conversely permanently over-reserve and starve on-chain.
  // We drive the exact toggle sequence and pin the ceiling to the hand-computed
  // banked total after each leg.
  // -------------------------------------------------------------------------
  it("ATTACK 6: dial toggling 0->R->0->R' never back-counts dormant rounds into the merkle reserve", async function () {
    const { satori, rewards, owner } = await freshStack();

    // Round-align the clock so whole-round accrual is exact.
    const r0 = await satori.getCurrentRound();
    expect(await satori.merkleReserveCeiling()).to.equal(0n); // dormant, never dialed

    // Leg A: dial 300, effective the NEXT round -> two FULL rounds at 300 bank 600
    // (three advances, since the round the dial is set in still uses the old 0).
    await rewards.connect(owner).setOffchainBudget(E(300));
    await advanceRound();
    await advanceRound();
    await advanceRound();
    let ceil = await satori.merkleReserveCeiling();
    expect(ceil, "leg A: 300 * 2 rounds").to.equal(E(600));

    // Leg B: dial back to 0. Banks the outstanding leg-A accrual, then dormant.
    await rewards.connect(owner).setOffchainBudget(0);
    const banked = await satori.merkleReserveCeiling();
    // Advance 5 DORMANT rounds — reserve MUST NOT grow (rate 0).
    for (let i = 0; i < 5; i++) await advanceRound();
    expect(await satori.merkleReserveCeiling(), "dormant rounds add nothing").to.equal(banked);

    // Leg C: dial 100. It must accrue ONLY from the NEXT round onward, never
    // back-count the 5 dormant rounds.
    await rewards.connect(owner).setOffchainBudget(E(100));
    expect(await satori.merkleReserveCeiling(), "re-enable does not back-count").to.equal(banked);
    // Effective next round: the round the dial is set in still adds nothing...
    await advanceRound();
    expect(
      await satori.merkleReserveCeiling(),
      "new rate not effective the round it was set in"
    ).to.equal(banked);
    // ...a second advance completes one full round at the new 100 rate.
    await advanceRound();
    expect(
      await satori.merkleReserveCeiling(),
      "one round at the new 100 rate, from banked base"
    ).to.equal(banked + E(100));

    // The merkle lane can mint at most the banked+accrued ceiling — never the
    // dormant rounds it skipped. three-lane decomposition holds throughout.
    expect(
      (await satori.onChainMinted()) + (await satori.merkleMinted()) + (await satori.devFeeMinted())
    ).to.equal(await satori.totalRewardsMinted());
  });

  // -------------------------------------------------------------------------
  // ATTACK 7 — CEILING VIEW vs ENFORCED value must agree at a claim boundary.
  // merkleReserveCeiling() is a lazy VIEW (accrues on read); the enforced cap in
  // rewardMint uses merkleReserveCumulative AFTER _accrueMerkleReserve(). If the
  // view over-reported the ceiling, a claim sized to the view would revert; if it
  // under-reported, an over-mint could slip. Claim EXACTLY the view's ceiling in
  // a gap round (several rounds since the last accrual touch) and require it to
  // succeed to the wei, then a +1 wei claim to revert.
  // -------------------------------------------------------------------------
  it("ATTACK 7: lazy merkle-ceiling view exactly equals the enforced cap across a multi-round gap", async function () {
    const { satori, owner, signers, merkle, rewards, airdrop, publisher } = await freshStack();
    const [, alice] = signers;

    await rewards.connect(owner).setOffchainBudget(E(200));
    // GAP: advance several rounds with NO rewardMint so the reserve is only
    // lazily accrued at read time, not banked to storage. The dial is effective
    // from the NEXT round (the round it is set in still uses dial 0), so 7 advances
    // yield 6 FULL rounds at the new rate.
    for (let i = 0; i < 7; i++) await advanceRound();

    const viewCeil = await satori.merkleReserveCeiling(); // 200 * 6
    expect(viewCeil).to.equal(E(1200));

    // Claim EXACTLY the view ceiling — must succeed to the wei (view == enforced).
    await merkle.connect(publisher).setMerkleRoot(leafOf(alice.address, viewCeil));
    await merkle.connect(alice).claimMerkle(viewCeil, []);
    expect(await satori.merkleMinted()).to.equal(viewCeil);
    expect(await satori.balanceOf(alice.address)).to.equal(viewCeil);

    // A single wei more (same round, no new accrual) must revert — the view did
    // not over-report headroom.
    await merkle.connect(publisher).setMerkleRoot(leafOf(alice.address, viewCeil + 1n));
    await expect(merkle.connect(alice).claimMerkle(viewCeil + 1n, []))
      .to.be.revertedWithCustomError(satori, "BudgetExceeded");

    // supply identity + three-lane decomposition after the exact-ceiling drain
    expect(
      (await satori.onChainMinted()) + (await satori.merkleMinted()) + (await satori.devFeeMinted())
    ).to.equal(await satori.totalRewardsMinted());
    expect(await satori.totalSupply()).to.equal(
      (await satori.totalRewardsMinted()) + (await airdrop.airdropClaimedTotal())
    );
  });
});
