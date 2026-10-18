// Gap: SatoriHub.onTokenTransfer per-sync try/catch resilience (ChildSyncFailed).
//
// PHASE-CLOSE IMPORTANT gap. The transfer hook wraps EACH child sync in its OWN
// try/catch so a faulty child cannot brick transfers:
//
//   try satoriRewards.syncPredictionDelegation(from,to,value) {}
//   catch { emit ChildSyncFailed(address(satoriRewards), from, to, value); }
//
// The load-bearing promise on this IMMUTABLE token: when a sync REVERTS WITH A
// REASON, (a) the transfer still lands, and (b) a ChildSyncFailed(child, from,
// to, value) event records the soft desync. A failure with no revert data (out of
// gas) is not swallowed: it reverts the transfer, so no sender can skip a sync by
// picking the gas. That side is tested in test/next/DelegationSyncGas.test.js.
//
// BURN VOTING SHRANK THE HOOK. There used to be a second arm here —
// `satoriVoting.syncVoteDelegation(from,to,value)` — because vote weight
// tracked the voter's BALANCE and had to be re-synced on every transfer. Weight
// is now bought by BURNING tokens, so it can never follow a balance and the
// voting arm was removed outright: the hook touches rewards and nothing else.
// The tests that proved "breaking one arm leaves the sibling running" therefore
// have no sibling left to prove it with. What survives — and is tested below —
// is the resilience promise itself, plus the new fact that a catastrophically
// broken VOTING child is not even reachable from a transfer any more.
//
// HOW WE FORCE A SYNC TO REVERT:
// upgrade the target child's OWN proxy (upgradeTo) to RevertingUUPSChild, whose
// sync hooks revert in-body (ChildBroken). This is the realistic failure mode
// now that the wholesale-swap lever (setChild) is gone (audit F3): a child that
// was patched to a buggy implementation. The proxy ADDRESS is unchanged, so the
// ChildSyncFailed event names the child's canonical address.
//
// OBSERVABLE TRANSFER. `recipient` has DELEGATED prediction power to `delegate`,
// so a healthy rewards child bumps predictionDelegateInfo[delegate].power by
// `value` on every inbound transfer — the mutation we watch for.

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { deploySatoriFixture, VOTE, voteFor } = require("./fixtures");

async function getStreamIdFromTx(tx, satori) {
  const r = await tx.wait();
  for (const log of r.logs) {
    try {
      const p = satori.interface.parseLog(log);
      if (p && p.name === "DataStreamCreated") return p.args.streamId;
    } catch (e) {}
  }
  throw new Error("DataStreamCreated event missing");
}

function childSyncFailures(rcpt, satori) {
  return rcpt.logs
    .map((log) => {
      try {
        return satori.interface.parseLog(log);
      } catch {
        return null;
      }
    })
    .filter((p) => p && p.name === "ChildSyncFailed");
}

describe("Gap: onTokenTransfer child-sync try/catch resilience (ChildSyncFailed)", function () {
  // Build a fixture where `recipient`:
  //   - burned a vote on `stream`'s default binary game (so the game carries
  //     permanent weight the transfer must be shown NOT to touch)
  //   - delegated prediction power to `delegate` (the rewards side-effect on receive)
  // and `payer` is a plain, unlocked holder who can send into `recipient`.
  async function setup() {
    const fix = await loadFixture(deploySatoriFixture);
    const { satori, voting, rewards, owner } = fix;
    const [, payer, recipient, delegate, authority] = fix.signers;

    // Fund the players from the bootstrap mint.
    await satori.transfer(payer.address, ethers.parseEther("100"));
    await satori.transfer(recipient.address, ethers.parseEther("100"));
    await satori.transfer(authority.address, ethers.parseEther("100"));

    // A stream (auto-creates its default binary game, gameId == streamId 1:1).
    // The fixture initializes the default stream at id 1, so this one is id 2.
    const tx = await satori.connect(authority).createSimpleDataStream("S", authority.address);
    const stream = await getStreamIdFromTx(tx, satori);
    const game = Number(stream);

    // recipient BURNS for the game. Its weight is permanent from here on — no
    // later balance movement of theirs can raise or lower it.
    await voteFor(satori, recipient, stream);

    // recipient DELEGATES prediction power to `delegate`. This:
    //   - marks recipient + delegate participants (which is what arms the
    //     token's transfer hook at all — `vote` deliberately does not),
    //   - sets predictionDelegateInfo[recipient].delegate = delegate,
    //   - send-locks recipient (lockUntilUndelegation) — but recipient only
    //     RECEIVES here, and the lock blocks `from`, not `to`.
    await satori.connect(recipient).delegatePredictionPower(delegate.address);

    // A reverting child IMPLEMENTATION: upgradeTo installs it on a child's proxy
    // so that child's sync hooks revert (ChildBroken). It used to need the live
    // MARKETING_FEE_RECIPIENT to pass the rewards proxy's upgrade pin; that pin
    // is gone now the recipient lives in proxy storage, so it takes no args.
    const revVoting = await (await ethers.getContractFactory("RevertingVotingImpl")).deploy();
    await revVoting.waitForDeployment();
    const revRewards = await (await ethers.getContractFactory("RevertingRewardsImpl")).deploy();
    await revRewards.waitForDeployment();
    const revVotingAddr = await revVoting.getAddress();
    const revRewardsAddr = await revRewards.getAddress();

    return { satori, voting, rewards, owner, payer, recipient, delegate, authority, stream, game, revVotingAddr, revRewardsAddr };
  }

  it("rewards sync revert: transfer lands and emits ChildSyncFailed(rewards,...)", async function () {
    const { satori, rewards, owner, payer, recipient, revRewardsAddr } = await setup();
    const REWARDS_ADDR = await rewards.getAddress();

    const value = ethers.parseEther("9");
    const payerBefore = await satori.balanceOf(payer.address);
    const recipBefore = await satori.balanceOf(recipient.address);

    // BREAK the rewards child by upgrading ITS proxy to a reverting impl.
    await rewards.connect(owner).upgradeTo(revRewardsAddr);

    const tx = await satori.connect(payer).transfer(recipient.address, value);

    // (a) ChildSyncFailed names the rewards child (its unchanged proxy address).
    await expect(tx)
      .to.emit(satori, "ChildSyncFailed")
      .withArgs(REWARDS_ADDR, payer.address, recipient.address, value);

    // (b) The transfer LANDED despite the failing sync.
    expect(await satori.balanceOf(payer.address)).to.equal(payerBefore - value);
    expect(await satori.balanceOf(recipient.address)).to.equal(recipBefore + value);
  });

  it("exactly one ChildSyncFailed fires, naming the broken child", async function () {
    // Sanity that breaking the rewards child emits EXACTLY ONE ChildSyncFailed
    // (not two, not zero) — the arm is neither skipped nor double-counted.
    const { satori, rewards, owner, payer, recipient, revRewardsAddr } = await setup();
    const REWARDS_ADDR = await rewards.getAddress();
    const value = ethers.parseEther("3");

    await rewards.connect(owner).upgradeTo(revRewardsAddr);

    const rcpt = await (await satori.connect(payer).transfer(recipient.address, value)).wait();
    const failures = childSyncFailures(rcpt, satori);
    expect(failures.length).to.equal(1);
    expect(failures[0].args.child).to.equal(REWARDS_ADDR);
  });

  it("a catastrophically broken VOTING child is not reachable from a transfer at all", async function () {
    // The voting arm is gone: burn-bought weight cannot follow a balance, so the
    // hook never calls voting. Installing an implementation whose every sync hook
    // reverts therefore changes nothing — no ChildSyncFailed, and the rewards arm
    // still runs. This is the strongest form of the old "one broken child cannot
    // brick transfers" promise: the child is not consulted in the first place.
    const { satori, voting, rewards, owner, payer, recipient, delegate, game, revVotingAddr } = await setup();

    const value = ethers.parseEther("7");
    const payerBefore = await satori.balanceOf(payer.address);
    const recipBefore = await satori.balanceOf(recipient.address);
    const gameWeightBefore = await voting.gameWeight(game);
    expect(gameWeightBefore).to.equal(VOTE);
    const [, delegatePowerBefore] = await rewards.predictionDelegateInfo(delegate.address);

    // BREAK the voting child by upgrading ITS proxy to a reverting impl.
    await voting.connect(owner).upgradeTo(revVotingAddr);

    const rcpt = await (await satori.connect(payer).transfer(recipient.address, value)).wait();

    // (a) NOTHING failed — the broken child was never called.
    expect(childSyncFailures(rcpt, satori).length).to.equal(0);

    // (b) The transfer LANDED.
    expect(await satori.balanceOf(payer.address)).to.equal(payerBefore - value);
    expect(await satori.balanceOf(recipient.address)).to.equal(recipBefore + value);

    // (c) The rewards sync STILL ran: delegate.power grew by `value`.
    const [, delegatePowerAfter] = await rewards.predictionDelegateInfo(delegate.address);
    expect(delegatePowerAfter - delegatePowerBefore).to.equal(value);
  });

  it("healthy children under multi-actor churn: ChildSyncFailed never fires and the delegate bucket stays exact", async function () {
    // Restores the canary from the deleted child-sync PoC. That file's other
    // five cases were vote-delegation and vote-bounty and died with those
    // features; this one did not. The two tests above prove the try/catch at
    // SatoriHub.onTokenTransfer FIRES when a child is deliberately broken.
    // Nothing otherwise proved it stays SILENT in normal operation — and a
    // swallow that trips unnoticed is precisely how a delegate's power bucket
    // drifts away from the balances backing it, with every transfer still
    // succeeding and no test the wiser.
    const { satori, voting, rewards, payer, recipient, delegate, authority, game } = await setup();
    const signers = await ethers.getSigners();
    const second = signers[5];

    // A SECOND delegator onto the same delegate, so the bucket aggregates two
    // independent balances and a per-actor sign error cannot cancel itself out.
    await satori.transfer(second.address, ethers.parseEther("50"));
    await satori.connect(second).delegatePredictionPower(delegate.address);

    const delegators = [recipient, second];
    const senders = [payer, authority]; // unlocked; delegators are send-locked

    // The invariant: the delegate's bucket is exactly the sum of the balances
    // delegating into it. Anchor it before churning so a wrong premise fails
    // here rather than masquerading as a churn bug.
    const bucketVsBalances = async () => {
      const [, power] = await rewards.predictionDelegateInfo(delegate.address);
      let sum = 0n;
      for (const d of delegators) sum += await satori.balanceOf(d.address);
      return { power, sum };
    };
    const start = await bucketVsBalances();
    expect(start.power).to.equal(start.sum);

    // Deterministic LCG — reproducible across runs, no Math.random.
    let seed = 20260808;
    const next = (n) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };

    const weightBefore = await voting.gameWeight(game);

    for (let i = 0; i < 12; i++) {
      const to = delegators[next(delegators.length)];
      const from = senders[next(senders.length)];
      const amount = ethers.parseEther(String(1 + next(4)));
      if ((await satori.balanceOf(from.address)) < amount) continue;

      const rcpt = await (await satori.connect(from).transfer(to.address, amount)).wait();

      // (a) the swallow stayed silent.
      expect(childSyncFailures(rcpt, satori).length, `iteration ${i}`).to.equal(0);

      // (b) the bucket still equals the sum of its delegators' balances.
      const { power, sum } = await bucketVsBalances();
      expect(power, `iteration ${i}`).to.equal(sum);
    }

    // (c) burnt weight is permanent: 12 balance movements never touched it.
    expect(await voting.gameWeight(game)).to.equal(weightBefore);
  });
});
