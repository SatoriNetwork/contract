const { expect } = require("chai");
const { deploySatoriFixture, VOTE, voteFor, makeEligible, voteRatio } = require("./fixtures");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

// Helper function to extract streamId from DataStreamCreated event
async function getStreamIdFromTx(tx, satoriContract) {
  const receipt = await tx.wait();
  const event = receipt.logs.find(log => {
    try {
      const parsed = satoriContract.interface.parseLog(log);
      return parsed && parsed.name === 'DataStreamCreated';
    } catch {
      return false;
    }
  });

  if (!event) throw new Error("DataStreamCreated event not found");
  const parsed = satoriContract.interface.parseLog(event);
  return parsed.args.streamId;
}

// BURN VOTING. `vote(gameId, amount)` destroys `amount` SATORI and credits the
// game that much PERMANENT weight. Nothing is escrowed, weight never follows a
// balance, and no vote can be moved, reduced or revoked. Every assertion in this
// file is written against that model — the old "weight == your balance, kept in
// your wallet, re-synced by the transfer hook" machinery is gone, and with it
// the vote lock, delegation, clearVote, the eligible heap and its top-N cap.
describe("Voting System", function () {
  let satori, token, voting, rewards, bounties, games;
  let owner;
  let alice;
  let bob;
  let carol;

  // Game ids. The fixture now calls initializeDefaultStream(), so id 1 is the
  // DEFAULT game and the first stream a test creates is id 2. Each stream
  // auto-creates exactly one binary game, so gameId == streamId throughout.
  const DEFAULT_GAME = 1n;
  let stream1, stream2, stream3, stream4;

  beforeEach(async function () {
    [owner, alice, bob, carol] = await ethers.getSigners();

    const fix = await deploySatoriFixture();
    ({ satori, token, voting, rewards, bounties, games } = fix);
    owner = fix.owner;

    // Create 4 test streams
    let tx;

    tx = await satori.createSimpleDataStream("Stream 1", alice.address);
    stream1 = await getStreamIdFromTx(tx, satori);

    tx = await satori.createSimpleDataStream("Stream 2", bob.address);
    stream2 = await getStreamIdFromTx(tx, satori);

    tx = await satori.createSimpleDataStream("Stream 3", carol.address);
    stream3 = await getStreamIdFromTx(tx, satori);

    tx = await satori.createSimpleDataStream("Stream 4", owner.address);
    stream4 = await getStreamIdFromTx(tx, satori);

    // Mint tokens for testing - transfer from owner who has initial supply
    await satori.transfer(alice.address, ethers.parseEther("100"));
    await satori.transfer(bob.address, ethers.parseEther("200"));
    await satori.transfer(carol.address, ethers.parseEther("50"));
  });

  describe("Basic Voting", function () {
    it("Should burn the voter's SATORI and credit the game that much weight", async function () {
      const balBefore = await satori.balanceOf(alice.address);
      const supplyBefore = await satori.totalSupply();

      await voteFor(satori, alice, stream1);   // burns VOTE (10 ether)

      expect(await voting.weightOf(stream1)).to.equal(VOTE);
      expect(await voting.gameWeight(stream1)).to.equal(VOTE);
      expect(await voting.totalBurnedWeight()).to.equal(VOTE);

      // The tokens are DESTROYED, not escrowed: balance and supply both drop.
      expect(await satori.balanceOf(alice.address)).to.equal(balBefore - VOTE);
      expect(await satori.totalSupply()).to.equal(supplyBefore - VOTE);
    });

    it("Should emit Voted with the burn, the weight bought, and the new total", async function () {
      const round = await satori.getCurrentRound();
      await expect(satori.connect(alice).vote(stream1, VOTE))
        .to.emit(voting, "Voted")
        .withArgs(alice.address, stream1, round, VOTE, VOTE, VOTE);
    });

    it("Should prevent voting for non-existent stream", async function () {
      const fakeStreamId = 9999;

      await expect(
        satori.connect(alice).vote(fakeStreamId, VOTE)
      ).to.be.revertedWithCustomError(satori, "UnknownStream");
    });

    it("Should reject a zero-amount vote", async function () {
      await expect(
        satori.connect(alice).vote(stream1, 0)
      ).to.be.revertedWithCustomError(voting, "ZeroVote");
    });

    it("Should reject a vote on the default game — its weight is derived, not bought", async function () {
      await expect(
        satori.connect(alice).vote(DEFAULT_GAME, VOTE)
      ).to.be.revertedWithCustomError(voting, "CannotVoteDefault");
    });

    it("Should allow multiple users to vote for same stream", async function () {
      await voteFor(satori, alice, stream1);
      await voteFor(satori, bob, stream1);

      expect(await voting.weightOf(stream1)).to.equal(VOTE * 2n);
    });

    it("Should allow users to vote for different streams", async function () {
      await voteRatio(satori, alice, [[stream1, 2]]);   // 2 ether
      await voteRatio(satori, bob,   [[stream2, 4]]);   // 4 ether
      await voteRatio(satori, carol, [[stream3, 1]]);   // 1 ether

      expect(await voting.weightOf(stream1)).to.equal(ethers.parseEther("2"));
      expect(await voting.weightOf(stream2)).to.equal(ethers.parseEther("4"));
      expect(await voting.weightOf(stream3)).to.equal(ethers.parseEther("1"));
      expect(await voting.totalBurnedWeight()).to.equal(ethers.parseEther("7"));
    });

    it("Should record the per-round burn deltas", async function () {
      const round = await satori.getCurrentRound();
      await voteFor(satori, alice, stream1);
      await voteFor(satori, bob, stream2);

      expect(await voting.gameBurnAtRound(stream1, round)).to.equal(VOTE);
      expect(await voting.gameBurnAtRound(stream2, round)).to.equal(VOTE);
      expect(await voting.totalBurnAtRound(round)).to.equal(VOTE * 2n);
    });
  });

  // Was "Changing Votes". A vote can no longer be changed: the tokens that
  // bought the weight no longer exist, so there is nothing to move back. A voter
  // who changes their mind burns AGAIN — the first game keeps what it was given.
  describe("Weight is permanent", function () {
    it("Voting for a second game does not take weight off the first", async function () {
      const balBefore = await satori.balanceOf(alice.address);

      await voteFor(satori, alice, stream1);
      expect(await voting.weightOf(stream1)).to.equal(VOTE);

      await voteFor(satori, alice, stream2);

      expect(await voting.weightOf(stream1)).to.equal(VOTE);      // untouched
      expect(await voting.weightOf(stream2)).to.equal(VOTE);
      // She paid twice — both burns are real.
      expect(await satori.balanceOf(alice.address)).to.equal(balBefore - VOTE * 2n);
    });

    it("A second voter leaving for another game cannot drain the first", async function () {
      await voteFor(satori, alice, stream1);
      await voteFor(satori, bob, stream1);
      expect(await voting.weightOf(stream1)).to.equal(VOTE * 2n);

      await voteFor(satori, alice, stream2);

      expect(await voting.weightOf(stream1)).to.equal(VOTE * 2n);
      expect(await voting.weightOf(stream2)).to.equal(VOTE);
    });

    it("There is no way to revoke a burn", async function () {
      expect(satori.clearVote, "clearVote must not exist").to.equal(undefined);
    });
  });

  // Was "Automatic Vote Weight Updates on Token Transfers", which proved weight
  // FOLLOWED the voter's balance. That is exactly what burn voting deletes: the
  // weight came from tokens that were destroyed, so moving the tokens that are
  // left cannot touch it. The token's transfer hook no longer calls voting at all.
  describe("Token transfers cannot move vote weight", function () {
    it("Receiving tokens does not raise the game's weight", async function () {
      await voteFor(satori, alice, stream1);
      expect(await voting.weightOf(stream1)).to.equal(VOTE);

      await satori.connect(bob).transfer(alice.address, ethers.parseEther("50"));

      expect(await voting.weightOf(stream1)).to.equal(VOTE);
      expect(await voting.totalBurnedWeight()).to.equal(VOTE);
    });

    it("Sending tokens does not lower the game's weight", async function () {
      await voteFor(satori, alice, stream1);

      // Alice sends away everything she has left.
      const left = await satori.balanceOf(alice.address);
      await satori.connect(alice).transfer(carol.address, left);
      expect(await satori.balanceOf(alice.address)).to.equal(0);

      expect(await voting.weightOf(stream1)).to.equal(VOTE);
    });

    it("Transfers between two voters leave both games untouched", async function () {
      await voteFor(satori, alice, stream1);
      await voteFor(satori, bob, stream2);

      await satori.connect(alice).transfer(bob.address, ethers.parseEther("30"));

      expect(await voting.weightOf(stream1)).to.equal(VOTE);
      expect(await voting.weightOf(stream2)).to.equal(VOTE);
    });

    it("Should not affect non-voters during transfers", async function () {
      await voteFor(satori, alice, stream1);

      await satori.connect(bob).transfer(carol.address, ethers.parseEther("50"));

      expect(await voting.weightOf(stream1)).to.equal(VOTE);
      expect(await voting.weightOf(stream2)).to.equal(0);
    });
  });

  // The top-N cap, the threshold and the eligible heap are all gone. Eligibility
  // is now the whole of `weightOf(g) > 0`: every enabled game that anyone burned
  // for earns, in proportion. A long tail of tiny games is expected and harmless.
  describe("Eligibility", function () {
    it("Every game with burnt weight is eligible — no cap, no ranking", async function () {
      await voteRatio(satori, alice, [[stream1, 1]]);    // 1 ether — the weakest
      await voteRatio(satori, bob,   [[stream2, 20]]);   // 20 ether — the strongest
      await voteRatio(satori, carol, [[stream3, 5]]);    // 5 ether

      expect(await voting.isEligible(stream1)).to.be.true;
      expect(await voting.isEligible(stream2)).to.be.true;
      expect(await voting.isEligible(stream3)).to.be.true;
    });

    it("A game nobody burned for is not eligible", async function () {
      await voteFor(satori, alice, stream1);

      expect(await voting.isEligible(stream1)).to.be.true;
      expect(await voting.isEligible(stream4)).to.be.false;
      expect(await voting.weightOf(stream4)).to.equal(0);
    });

    it("A bigger burn elsewhere cannot displace a game that already has weight", async function () {
      await voteRatio(satori, alice, [[stream1, 1]]);
      expect(await voting.isEligible(stream1)).to.be.true;

      // Under the old top-N heap this would have knocked stream1 out. It cannot
      // now: eligibility is not a contest for a limited number of slots.
      await voteRatio(satori, bob, [[stream2, 100]]);

      expect(await voting.isEligible(stream1)).to.be.true;
      expect(await voting.isEligible(stream2)).to.be.true;
      expect(await voting.weightOf(stream1)).to.equal(ethers.parseEther("1"));
    });

    it("The default game is always eligible, even before anyone burns", async function () {
      expect(await voting.isEligible(DEFAULT_GAME)).to.be.true;
    });
  });

  // The default game's weight is DERIVED, never bought: d = totalBurnedWeight *
  // 100 / 9900, floored at DEFAULT_WEIGHT_FLOOR so genesis has a non-zero
  // denominator. That gives it exactly 1% of a denominator it is itself part of
  // (was 20%; reduced to bound manipulation of the self-referential default
  // metric, adversary finding 2026-09-07).
  describe("The default game's derived weight", function () {
    it("Sits at the 1e18 floor while nothing else has been burned", async function () {
      expect(await voting.totalBurnedWeight()).to.equal(0);
      expect(await voting.defaultDerivedWeight()).to.equal(ethers.parseEther("1"));
      expect(await voting.weightOf(DEFAULT_GAME)).to.equal(ethers.parseEther("1"));
    });

    it("Is 1/99 of every other game's burnt weight — i.e. 1% of the whole (above the floor)", async function () {
      // Enough burn to clear the 1e18 floor: 100 ether -> d = 100*100/9900 =
      // 1.0101..e18 > floor (alice holds 100).
      await voteRatio(satori, alice, [[stream1, 100]]);   // 100 ether burnt

      const d = (ethers.parseEther("100") * 100n) / 9900n;
      expect(await voting.defaultDerivedWeight()).to.equal(d);
      expect(await voting.weightOf(DEFAULT_GAME)).to.equal(d);
    });

    it("Grows with every other burn (once above the floor)", async function () {
      await voteRatio(satori, alice, [[stream1, 100]]);
      await voteRatio(satori, bob, [[stream2, 100]]);   // 200 ether burnt in total

      expect(await voting.totalBurnedWeight()).to.equal(ethers.parseEther("200"));
      expect(await voting.defaultDerivedWeight()).to.equal((ethers.parseEther("200") * 100n) / 9900n);
    });
  });

  // Was "Get Eligible Streams". getEligibleGames()/getRankedGames() were heap
  // reads and went with the heap. `getGameWeights` is the replacement: a
  // paginated, GAME-ID-ordered sweep of every game carrying weight, with the
  // disabled flag and the round's burn delta alongside.
  describe("getGameWeights", function () {
    it("Lists every game carrying weight, in game-id order", async function () {
      const round = await satori.getCurrentRound();
      await voteRatio(satori, alice, [[stream1, 3]]);
      await voteRatio(satori, carol, [[stream3, 1]]);

      const [ids, weights, disabled, burnedInRound] =
        await voting.getGameWeights(1, 100, round);

      // Game 1 (the default) always carries its derived weight; then the two
      // games that were actually burned for, ascending. stream2/stream4 have no
      // weight and are skipped.
      expect(ids).to.deep.equal([DEFAULT_GAME, stream1, stream3]);
      expect(weights[0]).to.equal(await voting.defaultDerivedWeight());
      expect(weights[1]).to.equal(ethers.parseEther("3"));
      expect(weights[2]).to.equal(ethers.parseEther("1"));
      // The flag is now "live" (approved, or the default) rather than
      // "disabled" — all three are live here.
      expect(disabled).to.deep.equal([true, true, true]);
      expect(burnedInRound[1]).to.equal(ethers.parseEther("3"));
      expect(burnedInRound[2]).to.equal(ethers.parseEther("1"));
    });

    it("Shows only the default game before anyone burns", async function () {
      const round = await satori.getCurrentRound();
      const [ids, weights] = await voting.getGameWeights(1, 100, round);

      expect(ids).to.deep.equal([DEFAULT_GAME]);
      expect(weights[0]).to.equal(ethers.parseEther("1"));   // the floor
    });

    it("Pages: a partial scan returns a partial page and nextOffset resumes it", async function () {
      const round = await satori.getCurrentRound();
      await voteFor(satori, alice, stream1);

      // `limit` bounds the ids SCANNED, not the entries returned. Scan just
      // the default game's id: the page holds it alone, and nextOffset points
      // at the first unscanned id.
      const [firstIds, , , , nextOffset] = await voting.getGameWeights(1, 1, round);
      expect(firstIds).to.deep.equal([DEFAULT_GAME]);
      expect(nextOffset).to.equal(2n);

      // Resuming at nextOffset picks up the game that was actually burned for.
      const [secondIds] = await voting.getGameWeights(Number(nextOffset), 100, round);
      expect(secondIds).to.deep.equal([stream1]);

      const gameCount = await games.gameCount();
      const [tailIds] = await voting.getGameWeights(Number(gameCount) + 1, 100, round);
      expect(tailIds.length).to.equal(0);
    });
  });

  describe("Gas Efficiency", function () {
    it("Should maintain O(1) for transfers between non-voters", async function () {
      // Create many streams with votes
      for (let i = 0; i < 10; i++) {
        await satori.createSimpleDataStream(
          `Stream ${i}`,
          owner.address
        );
      }

      // Two users with no votes
      const user1 = bob;
      const user2 = carol;

      const tx1 = await satori.connect(user1).transfer(user2.address, ethers.parseEther("100"));
      const receipt1 = await tx1.wait();

      console.log("Gas for transfer between non-voters:", receipt1.gasUsed.toString());

      // Gas should be minimal (no vote updates)
      expect(Number(receipt1.gasUsed)).to.be.lessThan(100000);
    });

    it("A voter's transfers cost no more than anyone else's", async function () {
      // Under the old model a voter's transfer paid for a vote-weight re-sync.
      // Burn voting removed that hook entirely, so the two are now identical
      // work — a voter is not a more expensive account to hold tokens in.
      const plain = await (await satori.connect(bob).transfer(carol.address, ethers.parseEther("1"))).wait();

      await voteFor(satori, alice, stream1);
      const voter = await (await satori.connect(alice).transfer(carol.address, ethers.parseEther("1"))).wait();

      console.log("Gas for transfer from non-voter / voter:",
        plain.gasUsed.toString(), "/", voter.gasUsed.toString());

      expect(Number(voter.gasUsed)).to.equal(Number(plain.gasUsed));
    });
  });

  describe("Edge Cases", function () {
    it("Should reject a burn larger than the voter's balance", async function () {
      const balance = await satori.balanceOf(alice.address);
      await expect(
        satori.connect(alice).vote(stream1, balance + 1n)
      ).to.be.revertedWithCustomError(token, "ERC20InsufficientBalance");

      expect(await voting.weightOf(stream1)).to.equal(0);
    });

    it("Weight only ever accumulates — nothing subtracts from a game", async function () {
      const total = await makeEligible(satori, alice, [stream1, stream2]);
      expect(total).to.equal(VOTE * 2n);

      await voteFor(satori, bob, stream1);
      await voteFor(satori, carol, stream1, ethers.parseEther("5"));

      expect(await voting.weightOf(stream1)).to.equal(VOTE * 2n + ethers.parseEther("5"));
      expect(await voting.weightOf(stream2)).to.equal(VOTE);
    });

    it("Voting twice for the same game is NOT idempotent — it buys more weight", async function () {
      await voteFor(satori, alice, stream1);
      const first = await voting.weightOf(stream1);

      await voteFor(satori, alice, stream1);

      expect(await voting.weightOf(stream1)).to.equal(first * 2n);
    });
  });

  // The round denominator is ACCUMULATED as games join, not snapshotted in one
  // pass, so reading it before the round closes would return a partial total and
  // over-pay every share computed against it.
  describe("Round denominator", function () {
    it("Reverts RoundNotFinal while the round is still open", async function () {
      const round = await satori.getCurrentRound();
      await expect(voting.roundDenominator(round))
        .to.be.revertedWithCustomError(voting, "RoundNotFinal");
    });

    it("Reads back once the round has closed", async function () {
      const round = await satori.getCurrentRound();
      await time.increase(86400);
      expect(await voting.roundDenominator(round)).to.equal(0);   // nobody predicted
    });
  });

  // The admin lever is DISABLE-A-GAME. It is targeted (per-game, so it cannot
  // punish the other games on a stream), it leaves values flowing so in-flight
  // predictions still settle, and — unlike the old moveVotesToDefault — it never
  // touches anyone's property: the burnt weight is recorded untouched, it simply
  // stops counting while the game is off.
  describe("Admin approval (setGameApproved)", function () {
    it("disabling drops the game out of the eligible set and stops it earning", async function () {
      await voteFor(satori, alice, stream2);
      await voteFor(satori, bob, stream2);
      expect(await voting.weightOf(stream2)).to.equal(VOTE * 2n);
      expect(await voting.isEligible(stream2)).to.equal(true);
      const totalBefore = await voting.totalBurnedWeight();

      await expect(voting.connect(owner).setGameApproved(stream2, false))
        .to.emit(voting, "GameApprovedSet").withArgs(stream2, false);

      expect(await voting.isEligible(stream2)).to.equal(false);
      expect(await voting.weightOf(stream2)).to.equal(0);
      // Its weight also leaves the burnt total, so a disabled game stops
      // propping up the default game's derived share while it is off.
      expect(await voting.totalBurnedWeight()).to.equal(totalBefore - VOTE * 2n);
    });

    it("the burn record survives — nobody's tokens are written out of history", async function () {
      const round = await satori.getCurrentRound();
      await voteFor(satori, alice, stream2);
      await voting.connect(owner).setGameApproved(stream2, false);

      // `weightOf` is zeroed (it is the EARNING weight), but the raw figure that
      // was actually burned is untouched and still reported to explorers.
      expect(await voting.gameWeight(stream2)).to.equal(VOTE);
      const [ids, weights, disabled] = await voting.getGameWeights(1, 100, round);
      const i = ids.findIndex((g) => g === stream2);
      expect(i).to.be.greaterThan(-1);
      expect(weights[i]).to.equal(VOTE);
      expect(disabled[i]).to.equal(false); // the flag now reads "live", and it is not
    });

    it("re-enabling restores the game's weight exactly", async function () {
      await voteFor(satori, alice, stream2);
      await voteFor(satori, bob, stream2);
      const weight = await voting.weightOf(stream2);
      const total = await voting.totalBurnedWeight();

      await voting.connect(owner).setGameApproved(stream2, false);
      await voting.connect(owner).setGameApproved(stream2, true);

      expect(await voting.weightOf(stream2)).to.equal(weight);
      expect(await voting.totalBurnedWeight()).to.equal(total);
      expect(await voting.isEligible(stream2)).to.equal(true);
    });

    it("a vote on a disabled game is rejected outright, not accepted and ignored", async function () {
      await voting.connect(owner).setGameApproved(stream2, false);

      // Burning for a game that cannot earn would destroy the caller's tokens
      // for nothing, so the whole transaction reverts and nothing is burned.
      const balBefore = await satori.balanceOf(alice.address);
      await expect(satori.connect(alice).vote(stream2, VOTE))
        .to.be.revertedWithCustomError(voting, "GameNotApproved");
      expect(await satori.balanceOf(alice.address)).to.equal(balBefore);

      await voting.connect(owner).setGameApproved(stream2, true);
      await voteFor(satori, alice, stream2);
      expect(await voting.isEligible(stream2)).to.equal(true);
      expect(await voting.weightOf(stream2)).to.equal(VOTE);
    });

    it("is admin-only and idempotent", async function () {
      await expect(voting.connect(alice).setGameApproved(stream2, false))
        .to.be.revertedWithCustomError(voting, "NotAdmin");
      await voting.connect(owner).setGameApproved(stream2, false);
      // Re-setting the same value is a no-op rather than a revert or a re-emit.
      await voting.connect(owner).setGameApproved(stream2, false);
      expect(await voting.gameApproved(stream2)).to.equal(false);
    });

    it("the default game cannot be disabled", async function () {
      await expect(voting.connect(owner).setGameApproved(DEFAULT_GAME, false))
        .to.be.revertedWithCustomError(voting, "CannotSetDefaultApproval");
      expect(await voting.gameLive(DEFAULT_GAME)).to.equal(true);
    });

    it("the old vote-moving lever is gone", async function () {
      expect(voting.moveVotesToDefault, "moveVotesToDefault must not exist").to.equal(undefined);
    });
  });

  describe("Per-voter weight ledger", function () {
    // Write-only bookkeeping (added 2026-09-05): voterGameWeight[voter][gameId]
    // records each burner's cumulative weight per game. NOTHING on-chain reads
    // it — it changes no voting semantics (weight stays permanent and
    // unmovable) — it exists so a future upgrade can open doors like
    // reassigning weight off a disapproved game without an event crawl.
    const { parseEther } = ethers;

    it("records the burner's cumulative weight per game", async function () {
      await voteFor(satori, alice, stream1, parseEther("10"));
      expect(await voting.voterGameWeight(alice.address, stream1)).to.equal(parseEther("10"));
      await voteFor(satori, alice, stream1, parseEther("5"));
      expect(await voting.voterGameWeight(alice.address, stream1)).to.equal(parseEther("15"));
    });

    it("keeps voters and games independent", async function () {
      await voteFor(satori, alice, stream1, parseEther("10"));
      await voteFor(satori, bob, stream1, parseEther("7"));
      await voteFor(satori, alice, stream2, parseEther("3"));
      expect(await voting.voterGameWeight(alice.address, stream1)).to.equal(parseEther("10"));
      expect(await voting.voterGameWeight(bob.address, stream1)).to.equal(parseEther("7"));
      expect(await voting.voterGameWeight(alice.address, stream2)).to.equal(parseEther("3"));
      expect(await voting.voterGameWeight(bob.address, stream2)).to.equal(0n);
      expect(await voting.voterGameWeight(carol.address, stream1)).to.equal(0n);
    });

    it("matches the game's total when summed, and survives a disable cycle untouched", async function () {
      await voteFor(satori, alice, stream1, parseEther("10"));
      await voteFor(satori, bob, stream1, parseEther("7"));
      const a = await voting.voterGameWeight(alice.address, stream1);
      const b = await voting.voterGameWeight(bob.address, stream1);
      expect(a + b).to.equal(await voting.gameWeight(stream1));
      await voting.connect(owner).setGameApproved(stream1, false);
      await voting.connect(owner).setGameApproved(stream1, true);
      expect(await voting.voterGameWeight(alice.address, stream1)).to.equal(a);
      expect(await voting.voterGameWeight(bob.address, stream1)).to.equal(b);
    });
  });
});
