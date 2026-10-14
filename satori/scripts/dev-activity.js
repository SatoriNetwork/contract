// Generates local on-chain activity for satori-indexer development/testing:
// a fresh stream + game, votes, 2 rounds of predictions by 2 users, settles
// (=> PredictionMade/PredictionScored + ReferralPaid via alice's referral),
// and a token bounty (=> BountyFunded).
const hre = require("hardhat");
const fs = require("fs");
const { ethers } = hre;

const ROUND = 86400;
async function nextRound() {
  const b = await ethers.provider.getBlock("latest");
  const t = b.timestamp;
  await ethers.provider.send("evm_setNextBlockTimestamp", [t - (t % ROUND) + ROUND + 5]);
  await ethers.provider.send("evm_mine", []);
}

async function main() {
  const book = JSON.parse(fs.readFileSync(__dirname + "/../deployments/localhost.json", "utf8")).addresses;
  const [deployer, alice, bob] = await ethers.getSigners();

  const hub = await ethers.getContractAt("SatoriHub", book.hub);
  const engine = await ethers.getContractAt("SatoriEngine", book.engine);
  const token = await ethers.getContractAt("SatoriToken", book.token);
  const registry = await ethers.getContractAt("SatoriRegistry", book.registry);
  const games = await ethers.getContractAt("SatoriGames", book.games);
  const rewards = await ethers.getContractAt("SatoriRewards", book.rewards);
  const bounties = await ethers.getContractAt("SatoriBounties", book.bounties);
  const voting = await ethers.getContractAt("SatoriVoting", book.voting);

  // Voting (CAP_VOTE, id 7) and bounty staking (CAP_BOUNTY, id 4) ship off.
  // Turn both on without clearing whatever deploy.js enabled: there is no
  // getter for the raw bitmap, so rebuild it by probing a non-admin address,
  // as set-capabilities.js does. The deployer is the rewards admin locally.
  let caps = 0n;
  for (let id = 0; id < 16; id++) {
    if (await rewards.capabilityAllowed(id, "0x000000000000000000000000000000000000dEaD")) caps |= 1n << BigInt(id);
  }
  await (await rewards.setCapabilities(caps | (1n << 4n) | (1n << 7n))).wait();

  // Fund + approvals.
  await (await token.transfer(alice.address, ethers.parseEther("100"))).wait();
  await (await token.transfer(bob.address, ethers.parseEther("50"))).wait();
  for (const s of [alice, bob]) {
    await (await token.connect(s).approve(book.hub, ethers.MaxUint256)).wait();
  }

  // Referral: alice's future wins skim 1% to bob => ReferralPaid.
  // (set-once; tolerate re-runs against the same chain)
  try { await (await rewards.connect(alice).setReferral(bob.address)).wait(); }
  catch { console.log("referral already set (re-run)"); }

  // Fresh stream (deployer = provider) + its 1:1 binary game.
  const tx = await hub["createSimpleDataStream(string,address)"]("E2E", deployer.address);
  const rc = await tx.wait();
  let streamId = 0;
  for (const log of rc.logs) {
    try {
      const p = registry.interface.parseLog(log);
      if (p && p.name === "DataStreamCreated") { streamId = Number(p.args.streamId); break; }
    } catch {}
  }
  if (!streamId) throw new Error("no DataStreamCreated");
  const gameId = Number(await games.binaryGameByStream(streamId));
  console.log("streamId", streamId, "gameId", gameId);

  // Games are born unapproved: approve it first (deployer is the rewards
  // admin), or both votes below revert GameNotApproved.
  await (await voting.connect(deployer).setGameApproved(gameId, true)).wait();

  // Make the game reward-eligible. Voting BURNS SATORI to buy the game
  // permanent weight, so it takes an amount — the old one-arg `vote(gameId)`
  // has not existed since the burn-voting migration (2026-08-08) and this
  // script has been dead at this line ever since.
  await (await hub.connect(alice).vote(gameId, ethers.parseEther("10"))).wait();
  await (await hub.connect(bob).vote(gameId, ethers.parseEther("5"))).wait();

  // Round-align, then two predict->settle cycles (rising values => UP wins).
  let v = 100;
  const UP = "0x01";
  for (let r = 0; r < 2; r++) {
    // Fresh round each cycle: the previous iteration's last setValue was in
    // the current round, and cadence forbids two updates in one round.
    await nextRound();
    await (await registry.setValue(streamId, v)).wait();
    await (await engine.connect(alice).predictMultipleWithPayloads([{ gameId, payload: UP }])).wait();
    await (await engine.connect(bob).predictMultipleWithPayloads([{ gameId, payload: UP }])).wait();
    await nextRound();
    v += 10; await (await registry.setValue(streamId, v)).wait();
    await nextRound();
    v += 10; await (await registry.setValue(streamId, v)).wait();
    await (await engine.settlePrediction(alice.address, gameId)).wait();
    await (await engine.settlePrediction(bob.address, gameId)).wait();
  }

  // Token bounty on the game => BountyFunded.
  const Mock = await ethers.getContractFactory("MockERC20");
  const usd = await Mock.deploy("USDC", "USDC");
  await usd.waitForDeployment();
  await (await usd.mint(deployer.address, ethers.parseEther("1000"))).wait();
  await (await usd.approve(book.bounties, ethers.MaxUint256)).wait();
  await (await token.approve(book.bounties, ethers.MaxUint256)).wait(); // bountyBurn pull if needed
  await (await bounties.fundBounty(gameId, await usd.getAddress(), ethers.parseEther("500"), ethers.parseEther("100"))).wait();

  // A bounty WIN, so the pool-state and stake events all fire: alice stakes
  // the bounty token, wins a round (=> BountyDripped + BountyPaid), then takes
  // some out (=> BountyTokenUnstaked).
  await (await usd.mint(alice.address, ethers.parseEther("50"))).wait();
  await (await usd.connect(alice).approve(book.bounties, ethers.MaxUint256)).wait();
  await (await bounties.connect(alice).stakeBountyToken(await usd.getAddress(), ethers.parseEther("50"))).wait();
  await nextRound();
  await (await registry.setValue(streamId, v)).wait();
  await (await engine.connect(alice).predictMultipleWithPayloads([{ gameId, payload: UP }])).wait();
  await nextRound();
  v += 10; await (await registry.setValue(streamId, v)).wait();
  await nextRound();
  v += 10; await (await registry.setValue(streamId, v)).wait();
  await (await engine.settlePrediction(alice.address, gameId)).wait();
  await nextRound();
  await (await bounties.connect(alice).unstakeBountyToken(await usd.getAddress(), ethers.parseEther("10"), alice.address)).wait();
  console.log("alice bounty stake:", ethers.formatEther(await bounties.bountyStake(alice.address, await usd.getAddress())));

  console.log("activity done. alice streak:", Number(await engine.streaks(alice.address, gameId)),
    "bob streak:", Number(await engine.streaks(bob.address, gameId)),
    "bob refEarnings>0:", (await rewards.unclaimedRewards(bob.address)) > 0n);
}

main().catch((e) => { console.error(e); process.exit(1); });
