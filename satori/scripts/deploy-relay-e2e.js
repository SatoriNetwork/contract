// Deploys the split stack onto a LOCAL hardhat node and prepares the exact
// state relayer/tests/test_e2e.py needs for a gasless predict: one stream with
// vote weight in a finished round and a value in the current round, a funded
// user, and a relayer account. Writes the target file the pytest looks for.
//
//   npx hardhat node                    # terminal 1 (or backgrounded)
//   npx hardhat run scripts/deploy-relay-e2e.js --network localhost
//   cd ../relayer && python3 -m pytest tests/test_e2e.py
//
// Accounts are the hardhat node's standard funded set: 0 deploys, 1 relays,
// 2 is the gasless user. Their keys are the publicly-known hardhat defaults —
// test-only, never fund them anywhere real.

const fs = require("fs");
const path = require("path");
const { ethers, network } = require("hardhat");
const { deploySplitFixture } = require("../test/next/splitFixture");

const HARDHAT_KEYS = {
  relayer: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d", // account 1
  user:    "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a", // account 2
};

async function advanceToNextRound() {
  const block = await ethers.provider.getBlock("latest");
  const nextMidnight = Math.floor(block.timestamp / 86400) * 86400 + 86400;
  await network.provider.send("evm_setNextBlockTimestamp", [nextMidnight + 1]);
  await network.provider.send("evm_mine");
}

async function main() {
  const [owner, relayer, user] = await ethers.getSigners();
  const fix = await deploySplitFixture(2000);
  const { token, hub, engine, registry, rewards } = fix;

  const tx = await hub.createSimpleDataStream("E2E Stream", owner.address);
  const rcpt = await tx.wait();
  let streamId;
  for (const log of rcpt.logs) {
    try {
      const parsed = registry.interface.parseLog(log);
      if (parsed && parsed.name === "DataStreamCreated") { streamId = parsed.args.streamId; break; }
    } catch {}
  }
  if (streamId === undefined) throw new Error("no DataStreamCreated event");
  // Streams and their auto-created binary games are 1:1 in creation order, so
  // the game id equals the stream id (same assumption the test suite makes).
  await (await fix.voting.setGameApproved(streamId, true)).wait();

  await (await token.transfer(user.address, ethers.parseEther("100"))).wait();
  await (await token.connect(user).approve(await hub.getAddress(), 0)).wait(); // permit must do the work
  await (await token.connect(owner).approve(await hub.getAddress(), ethers.MaxUint256)).wait();
  await (await hub.connect(owner).vote(streamId, ethers.parseEther("10"))).wait();
  await advanceToNextRound();
  await (await registry.setValue(streamId, 100)).wait();

  const out = {
    rpc: network.config.url || "http://127.0.0.1:8545",
    chainId: Number((await ethers.provider.getNetwork()).chainId),
    hub: await hub.getAddress(),
    token: await token.getAddress(),
    engine: await engine.getAddress(),
    rewards: await rewards.getAddress(),
    streamId: Number(streamId),
    relayerKey: HARDHAT_KEYS.relayer,
    userKey: HARDHAT_KEYS.user,
    user: user.address,
    relayer: relayer.address,
  };
  const target = path.join(__dirname, "..", "..", "relayer", "tests", "e2e-target.json");
  fs.writeFileSync(target, JSON.stringify(out, null, 2) + "\n");
  console.log("wrote", target);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
