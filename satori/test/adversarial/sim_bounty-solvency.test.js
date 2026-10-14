/**
 * CONSERVATION SIMULATION — cluster: bounty-solvency
 *
 * Hunts the DANGEROUS OVER-distribution / double-credit direction of the
 * SatoriBounties accounting. Over many rounds with multiple funders and
 * stakers churning fund / stake / predict / settle(score) / unstake /
 * withdraw / cleanup, for every bounty token T we enforce TWO solvency
 * invariants in the SAFE direction:
 *
 *   (I1) SOLVENCY OF THE CONTRACT BALANCE.
 *        The SatoriBounties contract must hold at least what it currently
 *        OWES out:
 *            balanceOf(T) >= Σ_users bountyStake[u][T]
 *                          + Σ_users unclaimedBounty[u][T]
 *        i.e. it can never promise more bounty (live stake + accrued fee
 *        buckets) than the tokens it actually holds. A violation means the
 *        contract has credited owed-out balances it cannot pay — the classic
 *        over-distribution / double-credit failure.
 *
 *   (I2) GLOBAL CONSERVATION (no token created from nothing).
 *        Every base unit the contract holds or has ever paid out must trace
 *        back to a base unit that was funded or staked IN. Concretely, for
 *        each T (using the actual fee-on-transfer-safe RECEIVED deltas):
 *            everFunded[T] + everStaked[T]
 *                == balanceOf(T) + everUnstaked[T] + everWithdrawn[T]
 *        The left side is everything that came IN. The right side is
 *        everything that is still held plus everything that went OUT.
 *
 *        We assert the strict EQUALITY, not the `<=` inequality. The three
 *        ledgers are each accumulated from the contract's OWN token-balance
 *        delta measured around the only three calls that move tokens
 *        (fundBounty in, stakeBountyToken in, unstakeBountyToken out), so
 *        `balanceOf(T) === everFunded + everStaked - everUnstaked` is a numeric
 *        IDENTITY, and the `<=` form could never fail for ANY division
 *        behaviour whatsoever - self-referential conservation (P1). The
 *        equality is what has teeth: a leak through any path we do NOT
 *        instrument (a re-introduced payout skim transferred to a fee
 *        recipient, an outflow added to cleanupDrainedBountyToken /
 *        creditBountyForWin) drops the balance without moving everUnstaked and
 *        shows up here and nowhere else. The non-fee MockERC20 transfers
 *        exactly, so there is no legitimate slack in either direction.
 *
 *   (I2b) INDEPENDENT LEAK ANCHOR. I1 and I2 are both measured from inside the
 *        contract's own balance. I2b is measured from the OUTSIDE: the contract
 *        plus every account that can legitimately hold T (the participants, the
 *        owner, the platform fee recipient) must sum to totalSupply(T). A base
 *        unit that reaches ANY other address - precisely what a fee-recipient
 *        skim would do - fails here even where the contract-side ledgers are
 *        blind.
 *
 *   (I3) OWED-OUT NEVER EXCEEDS NET-IN.
 *        Σ owed-out (live stake + fee buckets) + already-withdrawn-or-
 *        unstaked <= everFunded + everStaked. The credit machinery cannot
 *        manufacture more owed balance than the realized inflow.
 *
 * Determinism: a fixed-seed LCG (no Math.random) drives all choices so the
 * run is fully reproducible.
 *
 * RULES compliance: assertions are written the SAFE direction (<= cap /
 * exact-conservation equality). If they all hold the file is GREEN and joins
 * the default suite. If any fails, a real over-distribution bug was found.
 */

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time, loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { deploySatoriFixture, pack1, voteFor } = require("../fixtures");

const UP = 1;
const DOWN = 2;
const ROUND = 86400;

// ---- deterministic LCG (Numerical Recipes constants), fixed seed ----
function makeRng(seed) {
  let state = BigInt(seed) & 0xffffffffn;
  const a = 1664525n;
  const c = 1013904223n;
  const m = 1n << 32n;
  return {
    next() {
      state = (a * state + c) % m;
      return Number(state);
    },
    int(n) {
      return this.next() % n;
    },
    bool(pctTrue) {
      return this.next() % 100 < pctTrue;
    },
    pick(arr) {
      return arr[this.next() % arr.length];
    },
  };
}

async function deployMockToken(sym) {
  const M = await ethers.getContractFactory("MockERC20");
  const t = await M.deploy(sym, sym);
  await t.waitForDeployment();
  return t;
}

// This test's subject is bounty pool/drip/stake mechanics, not stream rhythm,
// so every stream keeps the every-round beat (cadence 1440 minutes = one 24h
// round). `authority` stays the stream's PROVIDER, so it is still the account
// that writes values.
async function createStream(satori, signer, name, authority) {
  const tx = await satori.connect(signer)["createSimpleDataStream(string,address,uint24)"](name, authority, 1440);
  const rcpt = await tx.wait();
  for (const log of rcpt.logs) {
    try {
      const p = satori.interface.parseLog(log);
      if (p && p.name === "DataStreamCreated") return p.args.streamId;
    } catch (e) {}
  }
  throw new Error("DataStreamCreated event missing");
}

describe("SIM bounty-solvency — multi-round conservation / no over-distribution", function () {
  this.timeout(600000);

  it("never over-distributes any bounty token across churned fund/stake/predict/score/withdraw/cleanup rounds", async function () {
    const rng = makeRng(0xB0017501); // fixed seed (deterministic)
    const fix = await loadFixture(deploySatoriFixture);
    const { satori, token, bounties, registry, owner, signers } = fix;

    const bountiesAddr = await bounties.getAddress();
    // The platform fee moved to the immutable SatoriToken (its dev fee); the
    // bounties contract has no fee bucket of its own — winnings auto-compound
    // into bountyStake. We still fold the token's immutable PLATFORM_FEE_RECIPIENT
    // into the owed-out scan (a non-signer that never withdraws) so any stake it
    // could ever hold is counted against contract solvency, keeping the scan a
    // strict superset. (platform fee moved to immutable token, see test/next/DevFee.test.js)
    const feeRecipient = await token.PLATFORM_FEE_RECIPIENT();

    // ~9 users with varied SATORI balances (in ether units).
    const users = signers.slice(1, 10);
    // (Trimmed from [200,150,...] when the bounty burn doubled with the 24h
    // round budget: the owner must keep enough bootstrap SATORI to pay the
    // pre-seed doFund burns — ~10.7 SATORI each at genesis.)
    const satoriAmts = [120n, 90n, 70n, 60n, 45n, 30n, 22n, 15n, 8n];
    for (let i = 0; i < users.length; i++) {
      await satori.transfer(users[i].address, ethers.parseEther(satoriAmts[i].toString()));
    }

    // Authorities / funders reuse the same pool of signers but the owner is a
    // distinct funder with the bootstrap mint.
    const authority = users[0];

    // Streams. Multiple streams so cross-stream pools are exercised.
    const streams = [];
    for (let s = 0; s < 3; s++) {
      streams.push(await createStream(satori, owner, "S" + s, authority.address));
    }

    // All users BURN a little SATORI across the streams so every game carries
    // weight and therefore earns. 5 ether is small enough that the poorest user
    // (8 SATORI) can afford it and still keeps prediction power afterwards.
    const SIM_VOTE = ethers.parseEther("5");
    for (let i = 0; i < users.length; i++) {
      const s = streams[i % streams.length];
      try { await voteFor(satori, users[i], s, SIM_VOTE); } catch (e) {}
    }
    // Scenario detector: the burns must actually have landed, otherwise every
    // game has zero weight, nothing is scored, and the conservation invariants
    // below would hold vacuously.
    for (const s of streams) {
      expect(await fix.voting.weightOf(s)).to.be.gt(0n, "stream must carry burnt weight");
    }

    // Bounty tokens.
    const tokenSyms = ["USDC", "WBTC", "DAI"];
    const tokens = [];
    for (const sym of tokenSyms) tokens.push(await deployMockToken(sym));
    const tokenAddrs = await Promise.all(tokens.map((t) => t.getAddress()));

    // Mint generous balances to every user for every token + approve bounties.
    const BIG = ethers.parseEther("100000000");
    for (const u of [...users, owner]) {
      for (const t of tokens) {
        await t.mint(u.address, BIG);
        await t.connect(u).approve(bountiesAddr, BIG);
      }
    }

    // ---- conservation ledgers, per token address ----
    const everFunded = {};   // Σ received in fundBounty
    const everStaked = {};    // Σ received in stakeBountyToken
    const everUnstaked = {};  // Σ amount out via unstakeBountyToken
    for (const a of tokenAddrs) {
      everFunded[a] = 0n; everStaked[a] = 0n; everUnstaked[a] = 0n;
    }

    // Track in-flight predictions to settle later: list of {user, stream, predictRound}.
    let inflight = [];
    // Track which (user,stream) already predicted this round to avoid double-predict reverts.
    const predictedThisRound = new Set();

    // helper: read contract token balance
    const balOf = async (tAddr) => {
      const t = tokens[tokenAddrs.indexOf(tAddr)];
      return await t.balanceOf(bountiesAddr);
    };

    // helper: sum live stake + fee buckets owed out for token, over all
    // accounts we ever touch (users + owner + feeRecipient).
    const accountsToScan = () => {
      const set = new Set([...users.map((u) => u.address), owner.address, feeRecipient]);
      return [...set];
    };

    const sumOwedOut = async (tAddr) => {
      let owed = 0n;
      for (const acct of accountsToScan()) {
        owed += await bounties.bountyStake(acct, tAddr);
      }
      return owed;
    };

    // Fund instrumented: returns received via pool delta.
    const doFund = async (funder, streamId, tIdx, amount, rate) => {
      const tAddr = tokenAddrs[tIdx];
      const before = await balOf(tAddr);
      await bounties.connect(funder).fundBounty(streamId, tAddr, amount, rate);
      const after = await balOf(tAddr);
      everFunded[tAddr] += (after - before);
    };

    const doStake = async (u, tIdx, amount) => {
      const tAddr = tokenAddrs[tIdx];
      const before = await balOf(tAddr);
      await bounties.connect(u).stakeBountyToken(tAddr, amount);
      const after = await balOf(tAddr);
      everStaked[tAddr] += (after - before);
    };

    const doUnstake = async (u, tIdx, amount) => {
      const tAddr = tokenAddrs[tIdx];
      const before = await balOf(tAddr);
      await bounties.connect(u).unstakeBountyToken(tAddr, amount, u.address);
      const after = await balOf(tAddr);
      everUnstaked[tAddr] += (before - after);
    };

    // bounded value walk per stream so direction prediction is meaningful.
    const streamVal = {};
    for (const s of streams) streamVal[s] = 100;

    // Pre-seed: fund every (stream, token) once and have a few users stake so
    // the first rounds already have live pots.
    for (const s of streams) {
      for (let ti = 0; ti < tokens.length; ti++) {
        const amount = ethers.parseEther(((rng.int(900) + 100)).toString());
        const rate = ethers.parseEther(((rng.int(40) + 10)).toString());
        await doFund(owner, s, ti, amount, rate);
      }
    }
    for (let i = 0; i < users.length; i++) {
      const ti = i % tokens.length;
      await doStake(users[i], ti, ethers.parseEther(((rng.int(500) + 50)).toString()));
    }

    const ROUNDS = 28;
    let roundsSimulated = 0;
    // P5 scenario-detector: count the (round, token) checkpoints that actually
    // executed the invariant block, so a refactor that silently stops running it
    // fails loudly instead of passing vacuously.
    let conservationCheckpoints = 0;
    // Every address that may legitimately hold a bounty token: the participants,
    // the owner (a funder) and the platform fee recipient. Anything reaching an
    // address outside this set is a leak (I2b).
    const knownHolders = accountsToScan();

    for (let round = 0; round < ROUNDS; round++) {
      roundsSimulated++;
      predictedThisRound.clear();

      // --- occasionally inject new funding (multiple funders) ---
      if (rng.bool(70)) {
        const funder = rng.pick([...users, owner]);
        const s = rng.pick(streams);
        const ti = rng.int(tokens.length);
        const amount = ethers.parseEther(((rng.int(2000) + 50)).toString());
        // rate must be <= received and >= floor. Keep it modest.
        const rate = ethers.parseEther(((rng.int(60) + 5)).toString());
        try { await doFund(funder, s, ti, amount, rate); } catch (e) {}
      }

      // --- staking churn ---
      const nStakeOps = rng.int(5);
      for (let k = 0; k < nStakeOps; k++) {
        const u = rng.pick(users);
        const ti = rng.int(tokens.length);
        if (rng.bool(60)) {
          // stake (sometimes very large to stress proportions)
          const big = rng.bool(20);
          const amt = big
            ? ethers.parseEther(((rng.int(5000) + 1000)).toString())
            : ethers.parseEther(((rng.int(300) + 1)).toString());
          try { await doStake(u, ti, amt); } catch (e) {}
        } else {
          // attempt unstake (may revert StakeLocked / InsufficientStake — fine)
          const cur = await bounties.bountyStake(u.address, tokenAddrs[ti]);
          if (cur > 0n) {
            const amt = rng.bool(50) ? cur : (cur / BigInt(rng.int(3) + 1));
            if (amt > 0n) { try { await doUnstake(u, ti, amt); } catch (e) {} }
          }
        }
      }

      // --- set fresh stream values then predict ---
      for (const s of streams) {
        // value walks UP most of the time so UP predictions tend to score,
        // but occasionally DOWN to create losers (no drip credit for them).
        const up = rng.bool(70);
        streamVal[s] += up ? (rng.int(20) + 1) : -(rng.int(15) + 1);
        if (streamVal[s] < 10) streamVal[s] = 10 + rng.int(20);
        try { await registry.connect(authority).setValue(s, streamVal[s]); } catch (e) {}
      }

      const curRound = Number(await satori.getCurrentRound());
      const nPredOps = rng.int(users.length) + 3;
      for (let k = 0; k < nPredOps; k++) {
        const u = rng.pick(users);
        const s = rng.pick(streams);
        const key = u.address + ":" + s;
        if (predictedThisRound.has(key)) continue;
        const dir = rng.bool(75) ? UP : DOWN; // bias toward the walk
        try {
          await satori.connect(u).predictMultipleWithPayloads([{ gameId: s, payload: pack1(dir) }]);
          predictedThisRound.add(key);
          inflight.push({ user: u, stream: s, predictRound: curRound });
        } catch (e) { /* not eligible / already predicted / etc. */ }
      }

      // --- advance one round (24h) ---
      await time.increase(ROUND);
      // mid-round: push another value so the settle window has movement.
      for (const s of streams) {
        const up = rng.bool(70);
        streamVal[s] += up ? (rng.int(20) + 1) : -(rng.int(15) + 1);
        if (streamVal[s] < 10) streamVal[s] = 10 + rng.int(20);
        try { await registry.connect(authority).setValue(s, streamVal[s]); } catch (e) {}
      }
      await time.increase(ROUND);
      for (const s of streams) {
        try { await registry.connect(authority).setValue(s, streamVal[s] + rng.int(10)); } catch (e) {}
      }

      // --- settle matured in-flight predictions (this triggers drips + credit) ---
      const stillInflight = [];
      const nowRound = Number(await satori.getCurrentRound());
      for (const p of inflight) {
        if (nowRound > p.predictRound + 1) {
          try { await satori.settlePrediction(p.user.address, p.stream); } catch (e) {}
        } else {
          stillInflight.push(p);
        }
      }
      inflight = stillInflight;

      // --- occasional cleanup of drained tokens ---
      if (rng.bool(40)) {
        const s = rng.pick(streams);
        const ti = rng.int(tokens.length);
        try { await bounties.cleanupDrainedBountyToken(s, tokenAddrs[ti]); } catch (e) {}
      }

      // ================= INVARIANT CHECKS (SAFE direction) =================
      for (const tAddr of tokenAddrs) {
        const bal = await balOf(tAddr);
        const owed = await sumOwedOut(tAddr);

        // (I1) contract can pay everyone it currently owes.
        expect(bal).to.be.gte(
          owed,
          `OVER-DISTRIBUTION (I1): token ${tAddr} round ${round}: balance ${bal} < owed-out ${owed}`
        );

        // (I2) global conservation, asserted as the strict EQUALITY the header
        // bills. This used to be `expect(outAndHeld).to.be.lte(inSum)`, which is a
        // numeric identity (P1): the three ledgers are the contract's own balance
        // delta around the only three token-moving calls, so
        // bal === funded + staked - unstaked always, no reachable state could push
        // the LHS above the RHS, and the stranding branch under it was dead code.
        // An UNDER drift is exactly what an uninstrumented leak looks like, so it
        // is a hard fail here, not a note.
        const inSum = everFunded[tAddr] + everStaked[tAddr];
        const outAndHeld = bal + everUnstaked[tAddr];
        expect(outAndHeld).to.equal(
          inSum,
          `CONSERVATION BREAK (I2): token ${tAddr} round ${round}: held+out ${outAndHeld} != in ${inSum}`
        );

        // (I2b) independent leak anchor, measured from OUTSIDE the contract: the
        // contract plus every legitimate holder must account for the whole supply.
        // Catches a base unit routed to any address the contract-side ledgers
        // cannot see (a fee-recipient skim, a burn, a misdirected payout).
        const tok = tokens[tokenAddrs.indexOf(tAddr)];
        let heldByKnown = bal;
        for (const acct of knownHolders) heldByKnown += await tok.balanceOf(acct);
        expect(heldByKnown).to.equal(
          await tok.totalSupply(),
          `LEAK (I2b): token ${tAddr} round ${round}: known holders hold ${heldByKnown} of the supply`
        );
        conservationCheckpoints++;

        // (I3) owed-out + already-egressed never exceeds realized inflow.
        const owedPlusEgressed = owed + everUnstaked[tAddr];
        expect(owedPlusEgressed).to.be.lte(
          inSum,
          `OVER-DISTRIBUTION (I3): token ${tAddr} round ${round}: owed+egressed ${owedPlusEgressed} > in ${inSum}`
        );
      }
    }

    // Final settle of any remaining in-flight predictions, then re-check.
    await time.increase(ROUND);
    await time.increase(ROUND);
    for (const p of inflight) {
      try { await satori.settlePrediction(p.user.address, p.stream); } catch (e) {}
    }

    for (const tAddr of tokenAddrs) {
      const bal = await balOf(tAddr);
      const owed = await sumOwedOut(tAddr);
      expect(bal).to.be.gte(owed, `FINAL OVER-DISTRIBUTION (I1): token ${tAddr}`);
      const inSum = everFunded[tAddr] + everStaked[tAddr];
      const outAndHeld = bal + everUnstaked[tAddr];
      // Strict equality here too, for the same reason as the in-loop check.
      expect(outAndHeld).to.equal(inSum, `FINAL CONSERVATION BREAK (I2): token ${tAddr}`);
      const tok = tokens[tokenAddrs.indexOf(tAddr)];
      let heldByKnown = bal;
      for (const acct of knownHolders) heldByKnown += await tok.balanceOf(acct);
      expect(heldByKnown).to.equal(await tok.totalSupply(), `FINAL LEAK (I2b): token ${tAddr}`);
    }

    // Sanity: the sim actually exercised funding + crediting (not a no-op run).
    let totalFunded = 0n, totalStaked = 0n;
    for (const a of tokenAddrs) { totalFunded += everFunded[a]; totalStaked += everStaked[a]; }
    expect(totalFunded).to.be.gt(0n);
    expect(totalStaked).to.be.gt(0n);
    // ...and that the conservation block ran at every (round, token) checkpoint.
    expect(conservationCheckpoints).to.equal(ROUNDS * tokenAddrs.length);

    // eslint-disable-next-line no-console
    console.log(`[sim_bounty-solvency] rounds=${roundsSimulated} checkpoints=${conservationCheckpoints} ` +
      `funded=${ethers.formatEther(totalFunded)} staked=${ethers.formatEther(totalStaked)}`);
  });
});
