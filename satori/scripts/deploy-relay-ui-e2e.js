// Stages the browser out-of-ETH scenario for relayer/tests/e2e_ui.mjs:
// deploys the split stack, makes one stream predictable in the current round,
// seeds the dapp's default dev account (hardhat #1) with SATORI, and DRAINS its
// ETH to ~0 — so a prediction from it cannot pay gas and must route through the
// relayer. The relayer uses hardhat #3, which keeps its ETH.
//
//   npx hardhat node --port <RPC>
//   HARDHAT_URL=http://127.0.0.1:<RPC> npx hardhat run scripts/deploy-relay-ui-e2e.js --network localhost
//
// Writes relayer/tests/ui-e2e-target.json for the browser test to read.

const fs = require("fs");
const path = require("path");
const { ethers, network } = require("hardhat");
const { deploySplitFixture } = require("../test/next/splitFixture");

async function advanceToNextRound() {
  const block = await ethers.provider.getBlock("latest");
  const nextMidnight = Math.floor(block.timestamp / 86400) * 86400 + 86400;
  await network.provider.send("evm_setNextBlockTimestamp", [nextMidnight + 1]);
  await network.provider.send("evm_mine");
}

async function main() {
  const [owner, , user] = await ethers.getSigners(); // #0 owner, #1 = dapp dev account, #2 spare
  const devUser = (await ethers.getSigners())[1]; // hardhat #1 = 0x7099… the dapp connects as this
  const fix = await deploySplitFixture(2000);
  const { token, hub, engine, registry, rewards, voting } = fix;

  // The dapp batches every read through Multicall3 at the canonical 0xcA11…
  // address, absent on a fresh hardhat chain (deploy.js installs it; the test
  // fixture does not). Without it every aggregate3 returns 0x and no data
  // loads. Same install deploy.js does — after the stack, so no address shifts.
  {
    const mc3 = await (await ethers.getContractFactory("Multicall3Mock")).deploy();
    await mc3.waitForDeployment();
    const code = await network.provider.send("eth_getCode", [await mc3.getAddress(), "latest"]);
    await network.provider.send("hardhat_setCode",
      ["0xcA11bde05977b3631167028862bE2a173976CA11", code]);
  }

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
  await (await voting.setGameApproved(streamId, true)).wait();

  // Seed the dev account with SATORI (its gas fee will be paid from this), then
  // make the stream live in the current round.
  await (await token.transfer(devUser.address, ethers.parseEther("100"))).wait();
  await advanceToNextRound();
  await (await registry.setValue(streamId, 100)).wait();

  // Force the dev account's ETH to a dust amount directly — no drain tx, no
  // fee-math guessing (the node's getFeeData and the signer's auto-filled
  // maxFeePerGas disagree on a fresh chain). 0.0001 ETH is nonzero yet far
  // below the dapp's predict gas budget (750k * fee), so hasEth reads false.
  await network.provider.send("hardhat_setBalance",
    [devUser.address, ethers.toBeHex(ethers.parseEther("0.0001"))]);
  const left = await ethers.provider.getBalance(devUser.address);

  const out = {
    rpc: network.config.url || "http://127.0.0.1:8545",
    chainId: Number((await ethers.provider.getNetwork()).chainId),
    hub: await hub.getAddress(),
    token: await token.getAddress(),
    engine: await engine.getAddress(),
    rewards: await rewards.getAddress(),
    streamId: Number(streamId),
    devUser: devUser.address,
    devUserEthLeft: left.toString(),
    // hardhat #3 — the relayer, keeps its ETH.
    relayerKey: "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
  };
  const target = path.join(__dirname, "..", "..", "relayer", "tests", "ui-e2e-target.json");
  fs.writeFileSync(target, JSON.stringify(out, null, 2) + "\n");
  console.log("wrote", target, "\ndevUser ETH left:", ethers.formatEther(left));
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
