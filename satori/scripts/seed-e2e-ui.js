// Seed the on-chain state the C2 Playwright UI specs need beyond the canonical
// deploy.js. Idempotent-ish: safe to re-run, but it always registers a fresh
// YesNoGame adapter + creates a new game, so re-runs add duplicates (harmless
// for the presence-based specs).
//
// What it seeds:
//   1) A YesNoGame adapter registered as a COMMUNITY game adapter, name "Yes/No"
//      -> makes the create-game type <select> offer a YesNo type (spec C2c) and
//         the descriptor-driven threshold field resolve.
//   2) A dedicated 2880-minute stream + a YesNo GAME on it (threshold via
//      abi.encode(int128)) — adapter (type > 0) games need a two-round host
//      cadence (>= 2880 minutes), which stream 1's 1440-minute cadence fails
//      -> makes the stream's games list show YES/NO predict buttons (spec C2b).
//   3) A CUSTOM ADAPTER stream (adapterId 3 from deploy.js). The Custom adapter
//      validates only that target != 0 (no on-chain probe) and its descriptor's
//      valueDisplay() returns (0,"","Custom value") regardless of target, so the
//      stream row renders a descriptor label via formatStreamValue (spec C2d)
//      without needing a real price feed/pool. (A Uniswap/Chainlink stream would
//      need a real pool/aggregator at the target — its validate() probes it.)
//
// Usage (after a hardhat node + deploy.js, see satori-ui/tests/RUNBOOK.md):
//   npx hardhat run scripts/seed-e2e-ui.js --network localhost
//
// Addresses come from deployments/<network>.json (written by deploy.js);
// override with HUB_ADDRESS / ENGINE_ADDRESS if needed.
const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

async function main() {
  const ethers = hre.ethers;
  const bookPath = path.join(__dirname, "..", "deployments", `${hre.network.name}.json`);
  const book = fs.existsSync(bookPath)
    ? JSON.parse(fs.readFileSync(bookPath, "utf8")).addresses || {}
    : {};
  const HUB = process.env.HUB_ADDRESS || book.hub;
  const ENGINE = process.env.ENGINE_ADDRESS || book.engine;
  if (!HUB || !ENGINE) {
    throw new Error(`hub/engine unknown — run deploy.js first (looked in ${bookPath}) or set HUB_ADDRESS/ENGINE_ADDRESS`);
  }
  const CUSTOM_ADAPTER_ID = Number(process.env.CUSTOM_ADAPTER_ID || 3); // deploy.js: Chainlink=1, Uniswap=2, Custom=3

  console.log("Seeding C2 e2e UI state against hub:", HUB);

  const [owner] = await ethers.getSigners();
  const hub = await ethers.getContractAt("SatoriHub", HUB);
  const games = await hub.satoriGames();
  const registry = await hub.satoriRegistry();
  const token = await ethers.getContractAt("SatoriToken", await hub.token());

  // The hub pulls the community-registration / creation burns via
  // approve+transferFrom (the monolith used an internal transfer) — grant it
  // allowance up front. The deployer holds the genesis mint, so it can pay.
  await (await token.approve(HUB, ethers.MaxUint256)).wait();

  // 1) Register a fresh YesNoGame adapter (community path; costs spam fee).
  //    The adapter's record/score caller ("core") is the ENGINE, not the hub —
  //    passing the hub would make every record/score revert Unauthorized.
  console.log("\n[1] Deploying + registering a YesNoGame adapter (name 'Yes/No')...");
  const YesNoGame = await ethers.getContractFactory("YesNoGame");
  const yesNo = await YesNoGame.deploy(ENGINE, games, registry);
  await yesNo.waitForDeployment();
  const yesNoImpl = await yesNo.getAddress();
  console.log("    YesNoGame impl:", yesNoImpl);

  const gamesC = await ethers.getContractAt("SatoriGames", games);
  const beforeType = await gamesC.nextGameTypeId();
  const regTx = await hub.registerCommunityGameAdapter(yesNoImpl, "Yes/No");
  await regTx.wait();
  const newType = Number(beforeType);
  console.log("    Registered as game type:", newType);

  // 2) Create a YesNo game with an int128 threshold. Adapter (type > 0)
  //    games need a two-round host cadence (>= 2880 minutes); stream 1's
  //    1440-minute default cadence fails that gate, so create a dedicated
  //    2880-minute stream and attach the game there.
  console.log("\n[2] Creating a 2880-minute host stream + YesNo game (threshold=500)...");
  const registryC = await ethers.getContractAt("SatoriRegistry", registry);
  await (await hub["createSimpleDataStream(string,address,uint24)"](
    "YesNo host (e2e)", owner.address, 2880
  )).wait();
  const yesNoStreamId = Number(await registryC.getDataStreamCount());
  const cfg = ethers.AbiCoder.defaultAbiCoder().encode(["int128"], [500]);
  const createTx = await hub.createGame(yesNoStreamId, newType, cfg, "Above/Below");
  await createTx.wait();
  console.log("    Game created on stream", yesNoStreamId + ".");

  // 3) Create a Custom adapter stream so a descriptor valueDisplay renders.
  //    The Custom adapter's validate() only rejects target==0 (no on-chain
  //    probe), and its descriptor's valueDisplay() ignores the target, so any
  //    non-zero address works. The stream just needs adapterId>0 so the dapp
  //    probes the adapter impl for its label ("Custom value").
  console.log("\n[3] Creating a Custom adapter stream (adapterId %d)...", CUSTOM_ADAPTER_ID);
  try {
    const target = owner.address; // any non-zero address; descriptor ignores it
    const sTx = await hub["createAdapterDataStream(string,uint32,address,bytes,uint24)"](
      "Custom feed (e2e)", CUSTOM_ADAPTER_ID, target, "0x", 2880
    );
    await sTx.wait();
    console.log("    Custom adapter stream created.");

    // 4) A second YesNo game on the Custom stream. The deployer PROVIDES that
    //    stream, so it appears on the Advanced tab's "Your Streams" (manage)
    //    list — and with 2 games its "games" pill opens the games sub-view,
    //    which is where the create-game form lives (create-game.spec.ts).
    const customId = Number(await registryC.getDataStreamCount());
    console.log("\n[4] Creating a YesNo game on the Custom stream (id %d)...", customId);
    await (await hub.createGame(customId, newType, cfg, "Above/Below (custom)")).wait();
    console.log("    Game created on the Custom stream.");
  } catch (e) {
    console.log("    (skipped Custom stream/game:", e.shortMessage || e.message, ")");
  }

  console.log("\nDone. The C2 specs (adapters/games-list/create-game/stream-value) now have live state.");
}

main().catch((e) => { console.error(e); process.exit(1); });
