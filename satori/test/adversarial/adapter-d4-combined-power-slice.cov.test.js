// COVERAGE — GAP D4: a DELEGATE predicts with COMBINED own+delegated power,
// SLICED per stream count. In predictMultipleWithPayloads the protocol commits
// `perStreamPower = getPredictionPower(user) / streamCount` to EACH game in the
// batch (Satori.sol L1457-1458), where getPredictionPower = own + delegated.
//
// This proves the divide-by-streamCount slice is real and applied to the
// combined (own + delegated) power:
//   - a two-game batch records (Po + Pd) / 2 to each game;
//   - a single-game predict by an equivalent delegate records the FULL
//     (Po + Pd) (no halving) — the contrast makes the slice visible.
//
// Mutant this KILLS: removing the `/ streamCount` slice in Satori.sol would
// record the FULL combined power on the two-game batch, failing the
// `== (Po + Pd) / 2` assertion (it would equal the single-game full-power case).

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");
const {
  deploySatoriFixture,
  pack1,
  voteFor,
  RAW_TOLERANCE,
} = require("../fixtures");

const YES = 1;

async function streamIdFrom(tx, satori) {
  const r = await tx.wait();
  const ev = r.logs.find((l) => {
    try { return satori.interface.parseLog(l)?.name === "DataStreamCreated"; } catch { return false; }
  });
  return Number(satori.interface.parseLog(ev).args.streamId);
}

describe("COV adapter D4 — combined own+delegated power sliced per stream count", function () {
  this.timeout(300000);

  it("two-game batch records (Po+Pd)/2 per game; single-game predict records the FULL (Po+Pd)", async function () {
    const fix = await loadFixture(deploySatoriFixture);
    const { satori, registry, rewards, owner, signers } = fix;
    const [, delegate, delegator, delegate2, delegator2, provider] = signers;

    // Three streams and their built-in BINARY games. Stream 2 hosts game A (the
    // two-game batch's first leg), stream 3 hosts game B (its second leg),
    // stream 4 hosts game C (the single-game contrast). Stream 1 is the
    // protocol's DEFAULT stream, created by the fixture.
    //
    // These are type-0 games, and they have to be: power splits across the
    // batch's ELIGIBLE games, eligibility IS carrying burnt weight, and only
    // the built-in binary game can be voted for at all (an adapter game reverts
    // GameNotMintEligible and is handed a per-game power of 0). So the slice
    // under test is only ever observable on binary games — which is where the
    // engine computes it, adapter or not. Each stream's binary game is
    // auto-created with it and its gameId IS the stream id.
    const streamIds = [];
    for (const name of ["A", "B", "C"]) {
      const tx = await satori.connect(owner)["createSimpleDataStream(string,address,uint24)"](name, provider.address, 1440);
      streamIds.push(await streamIdFrom(tx, satori));
    }
    const [sA, sB, sC] = streamIds;
    await registry.connect(provider).setValue(sA, 100);
    await registry.connect(provider).setValue(sB, 100);
    await registry.connect(provider).setValue(sC, 100);
    const gameA = sA, gameB = sB, gameC = sC;
    // Every batched game must carry burnt weight to be eligible — power splits
    // across ELIGIBLE games only, so all three need a burn for the per-game
    // slice to be (Po+Pd)/2. Under burn voting a single address could fund all
    // three, but we keep one voter per game so no voter's burn touches the
    // delegation balances under test.
    const voters = [signers[6], signers[7], signers[8]];
    const allGames = [gameA, gameB, gameC];
    for (let i = 0; i < 3; i++) {
      await satori.transfer(voters[i].address, ethers.parseEther("10"));
      await voteFor(satori, voters[i], allGames[i]); // burns the full 10
    }

    // Two independent delegate/delegator pairs with IDENTICAL balances, so the
    // combined power (Po + Pd) is the same for both delegates — the ONLY
    // difference is the batch size (2 vs 1), isolating the slice.
    const OWN = ethers.parseEther("7");
    const DEL = ethers.parseEther("5");
    await satori.transfer(delegate.address, OWN);
    await satori.transfer(delegator.address, DEL);
    await satori.transfer(delegate2.address, OWN);
    await satori.transfer(delegator2.address, DEL);
    await satori.connect(delegator).delegatePredictionPower(delegate.address);
    await satori.connect(delegator2).delegatePredictionPower(delegate2.address);

    const round = Number(await satori.getCurrentRound());

    // Combined power read at predict time (own + delegated-in).
    const combined1 = await rewards.getPredictionPower(delegate.address);
    const combined2 = await rewards.getPredictionPower(delegate2.address);
    expect(combined1).to.be.gt(0n);
    expect(combined1).to.equal(combined2); // identical balances → identical combined power

    // --- Two-game batch: delegate predicts YES on game A AND game B. ---
    await satori.connect(delegate).predictMultipleWithPayloads([
      { gameId: gameA, payload: pack1(YES) },
      { gameId: gameB, payload: pack1(YES) },
    ]);

    // --- Single-game predict: equivalent delegate predicts YES on game C only. ---
    await satori.connect(delegate2).predictMultipleWithPayloads([
      { gameId: gameC, payload: pack1(YES) },
    ]);

    // The power committed to each batched game == combined / 2. (rawPower is
    // stored right-shifted by PR_RAW_SHIFT, so compare within RAW_TOLERANCE.)
    const wA = (await satori.predictions(delegate.address, gameA, round)).rawPredictionPower;
    const wB = (await satori.predictions(delegate.address, gameB, round)).rawPredictionPower;
    expect(wA).to.be.closeTo(combined1 / 2n, RAW_TOLERANCE);
    expect(wB).to.be.closeTo(combined1 / 2n, RAW_TOLERANCE);
    expect(wA).to.equal(wB); // the two legs are sliced identically

    // The single-game predict records the FULL combined power (no halving) — the
    // contrast that makes the divide-by-streamCount slice visible.
    const wC = (await satori.predictions(delegate2.address, gameC, round)).rawPredictionPower;
    expect(wC).to.be.closeTo(combined2, RAW_TOLERANCE);
    expect(wC).to.be.closeTo(wA * 2n, RAW_TOLERANCE * 2n); // full == twice the sliced weight
  });
});
