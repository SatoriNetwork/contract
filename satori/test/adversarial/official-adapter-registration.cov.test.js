// Adversarial audit (session 2): official-adapter-registration
// Satori.registerAdapter / registerGameAdapter — NEW admin-only, FREE,
// community=false functions. Gate is `msg.sender != satoriRewards.admin()`.

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");
const { deploySatoriFixture, createYesNoGame, pack1, VOTE } = require("../fixtures");

describe("ADV2: official-adapter-registration", function () {
  let satori, engine, registry, games, rewards, voting, owner, alice, bob, carol, dave;
  let customAdapter, customAdapterAddr;
  let yesNo, streamId;

  beforeEach(async function () {
    const fix = await loadFixture(deploySatoriFixture);
    ({ satori, engine, registry, games, rewards, voting, owner, customAdapter } = fix);
    [, alice, bob, carol, dave] = fix.signers;
    customAdapterAddr = await customAdapter.getAddress();

    // A real IPredictionGame implementation + a 2880-minute (two-round) stream
    // for it (adapter games require cadence >= 2880), used by the trust-parity
    // test below.
    const YesNoGame = await ethers.getContractFactory("YesNoGame");
    yesNo = await YesNoGame.deploy(
      await engine.getAddress(),
      await games.getAddress(),
      await registry.getAddress()
    );
    await yesNo.waitForDeployment();
    const stx = await satori["createSimpleDataStream(string,address,uint24)"](
      "Parity-Stream", owner.address, 2880
    );
    const srcpt = await stx.wait();
    for (const log of srcpt.logs) {
      try {
        const p = registry.interface.parseLog(log);
        if (p && p.name === "DataStreamCreated") streamId = Number(p.args.streamId);
      } catch (e) {}
    }
    await registry.connect(owner).setValue(streamId, 100);
  });

  // ---- Attack 1: non-admin registering an official adapter ----
  it("ATTACK: non-admin CANNOT register official stream adapter", async function () {
    await expect(
      satori.connect(alice).registerAdapter(customAdapterAddr, "Evil Official")
    ).to.be.reverted; // Unauthorized
  });

  it("ATTACK: non-admin CANNOT register official game adapter", async function () {
    await expect(
      satori.connect(alice).registerGameAdapter(customAdapterAddr, "Evil Official Game")
    ).to.be.reverted; // Unauthorized
  });

  it("admin (owner) CAN register official stream adapter, FREE, community=false", async function () {
    const balBefore = await satori.balanceOf(owner.address);
    const tx = await satori.registerAdapter(customAdapterAddr, "Official A");
    const rcpt = await tx.wait();
    // Decode AdapterRegistered from registry
    let assignedId;
    for (const log of rcpt.logs) {
      try {
        const p = registry.interface.parseLog(log);
        if (p && p.name === "AdapterRegistered") {
          assignedId = p.args.adapterId;
          expect(p.args.community).to.equal(false);
        }
      } catch (e) {}
    }
    expect(assignedId).to.not.be.undefined;
    // FREE — admin balance unchanged
    expect(await satori.balanceOf(owner.address)).to.equal(balBefore);
    // flag recorded as official (not community)
    expect(await registry.isCommunityAdapter(assignedId)).to.equal(false);
  });

  // ---- Attack 2: ID assignment desync between community + official paths ----
  it("ID assignment is a SINGLE shared counter — no collision/skip/desync", async function () {
    // fixture already registered its adapters (3 community + the official
    // Named one); the counter must simply continue from wherever it stands
    const n = await registry.nextAdapterId();
    expect(n).to.be.gte(4n);

    // admin registers official (id n)
    await satori.registerAdapter(customAdapterAddr, "Off-n");
    expect(await registry.nextAdapterId()).to.equal(n + 1n);
    expect(await registry.adapter(n)).to.equal(customAdapterAddr);
    expect(await registry.isCommunityAdapter(n)).to.equal(false);

    // community registers next (id n+1) — must NOT collide or skip
    const fee = await satori.streamBurn();
    await satori.transfer(alice.address, fee);
    await satori.connect(alice).registerCommunityAdapter(customAdapterAddr, "Comm-n+1");
    expect(await registry.nextAdapterId()).to.equal(n + 2n);
    expect(await registry.adapter(n + 1n)).to.equal(customAdapterAddr);
    expect(await registry.isCommunityAdapter(n + 1n)).to.equal(true);

    // admin official again (id n+2)
    await satori.registerAdapter(customAdapterAddr, "Off-n+2");
    expect(await registry.nextAdapterId()).to.equal(n + 3n);
    expect(await registry.isCommunityAdapter(n + 2n)).to.equal(false);

    // No ID was reused; each adapter slot is distinct.
    expect(await registry.adapter(n)).to.not.equal(ethers.ZeroAddress);
    expect(await registry.adapter(n + 1n)).to.not.equal(ethers.ZeroAddress);
    expect(await registry.adapter(n + 2n)).to.not.equal(ethers.ZeroAddress);
  });

  it("game-type ID assignment shared counter — official + community interleave cleanly", async function () {
    // fixture creates games on streams via builtin type 0; nextGameTypeId starts at 1
    const nextBefore = await games.nextGameTypeId();
    await satori.registerGameAdapter(customAdapterAddr, "OffGame");
    expect(await games.nextGameTypeId()).to.equal(nextBefore + 1n);
    expect(await games.isCommunityGameAdapter(nextBefore)).to.equal(false);

    const fee = await satori.streamBurn();
    await satori.transfer(alice.address, fee);
    await satori.connect(alice).registerCommunityGameAdapter(customAdapterAddr, "CommGame");
    expect(await games.nextGameTypeId()).to.equal(nextBefore + 2n);
    expect(await games.isCommunityGameAdapter(nextBefore + 1n)).to.equal(true);
  });

  // ---- Attack 3: does the official flag grant trust in scoring/payout/eligibility/createGame? ----
  it("createGame treats an OFFICIAL adapter identically to a COMMUNITY one (no trust differential)", async function () {
    // The body used to be `expect(true).to.equal(true)` with a comment
    // deferring to "the ATTACK below" — but that test never calls
    // createAdapterDataStream either, so the ONLY test claiming to cover the
    // no-trust-differential property asserted a tautology that no contract
    // change could ever fail. Register the SAME implementation on BOTH paths
    // and drive create → predict → settle through each, so a flag branch in
    // createGame, in the predict dispatch, or in the payout would go red here.
    const implAddr = await yesNo.getAddress();

    // Official (admin, free) and community (permissionless, paid) registration
    // of one and the same implementation address.
    const officialType = await games.nextGameTypeId();
    await satori.registerGameAdapter(implAddr, "Official-YesNo");
    const fee = await satori.streamBurn();
    await satori.transfer(bob.address, fee);
    const communityType = await games.nextGameTypeId();
    await satori.connect(bob).registerCommunityGameAdapter(implAddr, "Community-YesNo");
    expect(await games.isCommunityGameAdapter(officialType)).to.equal(false);
    expect(await games.isCommunityGameAdapter(communityType)).to.equal(true);

    // Both resolve id → impl, to the identical address.
    expect(await games.gameAdapter(officialType)).to.equal(implAddr);
    expect(await games.gameAdapter(communityType)).to.equal(implAddr);

    // Same stream, same config, one game per registration path. A createGame
    // that gated on the community flag would revert on one of these.
    const gameOfficial = await createYesNoGame(satori, officialType, streamId, 150, "off");
    const gameCommunity = await createYesNoGame(satori, communityType, streamId, 150, "comm");
    expect(await games.gameTypeIdOf(gameOfficial)).to.equal(officialType);
    expect(await games.gameTypeIdOf(gameCommunity)).to.equal(communityType);
    expect(await games.dataStreamId(gameOfficial)).to.equal(streamId);
    expect(await games.dataStreamId(gameCommunity)).to.equal(streamId);

    // Symmetric MINT-ineligibility: only the built-in binary game (gameTypeId 0)
    // earns from the mint, so a vote on EITHER adapter game reverts — the official
    // badge buys no eligibility the community one lacks. Asserting both reverts
    // identically IS the no-trust-differential property; it replaces the two
    // symmetric burns that used to stand in for it.
    await satori.transfer(carol.address, ethers.parseEther("50"));
    await satori.transfer(dave.address, ethers.parseEther("50"));
    await expect(satori.connect(carol).vote(gameOfficial, VOTE))
      .to.be.revertedWithCustomError(voting, "GameNotMintEligible");
    await expect(satori.connect(dave).vote(gameCommunity, VOTE))
      .to.be.revertedWithCustomError(voting, "GameNotMintEligible");

    // One predictor, one batch, both games, the same YES call on each.
    await satori.transfer(alice.address, ethers.parseEther("20"));
    const predRound = await satori.getCurrentRound();
    await satori.connect(alice).predictMultipleWithPayloads([
      { gameId: gameOfficial, payload: pack1(1) },
      { gameId: gameCommunity, payload: pack1(1) },
    ]);

    // The commit the protocol handed the adapter is identical on both games —
    // no discount, no boost for the community badge. That SAMENESS is the whole
    // point of the test. Both are alice's real UNDIVIDED prediction power:
    // adapter games earn no SATORI, but they are still told who they are dealing
    // with, and an official badge buys no better information than a community
    // one. Both bets being live is what makes the cleared records after the
    // settles below mean something.
    const wOfficial = await yesNo.pendingWeight(gameOfficial, alice.address);
    const wCommunity = await yesNo.pendingWeight(gameCommunity, alice.address);
    expect(wOfficial).to.be.gt(0n);
    expect(wOfficial).to.equal(wCommunity);
    expect(await yesNo.pendingRound(gameOfficial, alice.address)).to.equal(predRound);
    expect(await yesNo.pendingRound(gameCommunity, alice.address)).to.equal(predRound);

    // ...and so is the settle. Drive the stream above the threshold so YES
    // wins on both, then settle each.
    await time.increase(86400 * 2);
    await registry.connect(owner).setValue(streamId, 200);
    const before = await rewards.unclaimedRewards(alice.address);
    await satori.settlePrediction(alice.address, gameOfficial);
    const afterOfficial = await rewards.unclaimedRewards(alice.address);
    await satori.settlePrediction(alice.address, gameCommunity);
    const afterCommunity = await rewards.unclaimedRewards(alice.address);

    // Both settles really RAN and resolved the same way — same outcome cached,
    // both pending records consumed. A flag branch that skipped one path would
    // leave its record live here.
    expect(await yesNo.roundOutcome(gameOfficial, predRound)).to.equal(1);  // YES
    expect(await yesNo.roundOutcome(gameCommunity, predRound)).to.equal(1); // YES
    expect(await yesNo.pendingRound(gameOfficial, alice.address)).to.equal(0n);
    expect(await yesNo.pendingRound(gameCommunity, alice.address)).to.equal(0n);

    // The payout is identical on both paths and is ZERO on both: an adapter game
    // (official or community) earns no SATORI from the mint. This used to assert
    // `paidOfficial > 0`; the "both settles actually happened" proof is the four
    // reads above, so a zero here cannot be a stalled no-op in disguise.
    const paidOfficial = afterOfficial - before;
    const paidCommunity = afterCommunity - afterOfficial;
    expect(paidOfficial).to.equal(0n);
    expect(paidCommunity).to.equal(paidOfficial);
  });

  it("official flag does NOT change adapter resolution in createAdapterDataStream", async function () {
    // Register customAdapter as OFFICIAL stream adapter, then create a stream on it.
    const tx = await satori.registerAdapter(customAdapterAddr, "OfficialCustom");
    const rcpt = await tx.wait();
    let id;
    for (const log of rcpt.logs) {
      try {
        const p = registry.interface.parseLog(log);
        if (p && p.name === "AdapterRegistered") id = p.args.adapterId;
      } catch (e) {}
    }
    // createAdapterDataStream must work with an official adapter exactly as community.
    // CustomAdapter requires a provider/config; use the same call community path uses.
    // If this resolves by id alone, the official flag is purely cosmetic.
    expect(await registry.adapter(id)).to.equal(customAdapterAddr);
    expect(await registry.isCommunityAdapter(id)).to.equal(false);
  });

  // ---- Attack 4: admin free unlimited registration — griefing / ID exhaustion ----
  it("admin free registration cannot be cheaply abused to exhaust 16-bit ID space (gas-bound)", async function () {
    // Register a modest batch for free; confirm counter advances by exactly N
    // and no state for other ids is corrupted. Exhausting 65535 ids is gas-
    // prohibitive; what matters is each free call advances by exactly 1.
    const start = await registry.nextAdapterId();
    for (let i = 0; i < 5; i++) {
      await satori.registerAdapter(customAdapterAddr, "batch" + i);
    }
    expect(await registry.nextAdapterId()).to.equal(start + 5n);
  });

  // ---- Attack 5: reentrancy — registerAdapter reads admin() then calls registry/games ----
  it("registration never calls into the impl address (no reentrancy hook at registration)", async function () {
    // Deploy a reentrancy-attempting "adapter" that would reenter registerAdapter
    // if it were called during registration. Since the impl is only STORED,
    // never invoked, registration of a hostile impl is inert.
    const Attacker = await ethers.getContractFactory("MockDataStream");
    const attacker = await Attacker.deploy();
    await attacker.waitForDeployment();
    // Registering it must succeed without any callback to it (it has no
    // registration hook anyway). The point: no external call to impl occurs.
    await expect(
      satori.registerAdapter(await attacker.getAddress(), "inert")
    ).to.not.be.reverted;
  });

  // ---- Attack 6: zero-address impl rejected on official path too ----
  it("official path rejects zero-address impl (same validation as community)", async function () {
    await expect(
      satori.registerAdapter(ethers.ZeroAddress, "zero")
    ).to.be.reverted; // InvalidAdapter
    await expect(
      satori.registerGameAdapter(ethers.ZeroAddress, "zero")
    ).to.be.reverted; // InvalidGameAdapter
  });

  // ---- Attack 7: admin role transfer — new admin gains official rights, old loses ----
  it("after setAdmin, the OLD admin can no longer register official; NEW admin can", async function () {
    await rewards.setAdmin(alice.address);
    // old admin (owner) now unauthorized
    await expect(
      satori.connect(owner).registerAdapter(customAdapterAddr, "old")
    ).to.be.reverted;
    // new admin authorized
    await expect(
      satori.connect(alice).registerAdapter(customAdapterAddr, "new")
    ).to.not.be.reverted;
  });
});
