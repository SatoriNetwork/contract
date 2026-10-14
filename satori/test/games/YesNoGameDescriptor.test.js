// IGameUIDescriptor reference implementation on YesNoGame.
//
// These are pure, additive, view-only UI-metadata functions. They never
// touch the core, registry, games registry, or rewards — so the adapter is
// deployed standalone with dummy constructor addresses and asserted directly.
// This is intentionally decoupled from the protocol fixture: the whole point
// of the descriptor is that NOTHING on-chain depends on it.

const { expect } = require("chai");
const { ethers } = require("hardhat");

const YES = 1;
const NO = 2;

describe("YesNoGame — IGameUIDescriptor (optional, view-only)", function () {
  // gameId is irrelevant for these YES/NO views; use an arbitrary value.
  const GAME_ID = 7;

  async function deploy() {
    // Dummy non-zero addresses; descriptor views never call them.
    const a = "0x0000000000000000000000000000000000000001";
    const b = "0x0000000000000000000000000000000000000002";
    const c = "0x0000000000000000000000000000000000000003";
    const d = "0x0000000000000000000000000000000000000004";
    const YesNoGame = await ethers.getContractFactory("YesNoGame");
    const yesNo = await YesNoGame.deploy(a, b, c);
    await yesNo.waitForDeployment();
    return yesNo;
  }

  it("uiSchemaVersion() == 1", async function () {
    const g = await deploy();
    expect(await g.uiSchemaVersion()).to.equal(1);
  });

  it("optionCount(gameId) == 2", async function () {
    const g = await deploy();
    expect(await g.optionCount(GAME_ID)).to.equal(2);
  });

  it("optionLabel: 0 => 'Yes', 1 => 'No', reverts on 2", async function () {
    const g = await deploy();
    expect(await g.optionLabel(GAME_ID, 0)).to.equal("Yes");
    expect(await g.optionLabel(GAME_ID, 1)).to.equal("No");
    await expect(g.optionLabel(GAME_ID, 2)).to.be.revertedWithCustomError(
      g,
      "IndexOutOfRange"
    );
  });

  it("optionPayload: 0 => 0x01, 1 => 0x02, reverts on 2", async function () {
    const g = await deploy();
    expect(await g.optionPayload(GAME_ID, 0)).to.equal("0x01");
    expect(await g.optionPayload(GAME_ID, 1)).to.equal("0x02");
    await expect(g.optionPayload(GAME_ID, 2)).to.be.revertedWithCustomError(
      g,
      "IndexOutOfRange"
    );
  });

  it("predictInputSchema(gameId) == '' (discrete)", async function () {
    const g = await deploy();
    expect(await g.predictInputSchema(GAME_ID)).to.equal("");
  });

  it("configSchema() is non-empty, JSON-parseable, threshold/int128", async function () {
    const g = await deploy();
    const s = await g.configSchema();
    expect(s.length).to.be.greaterThan(0);
    const parsed = JSON.parse(s);
    expect(parsed.fields[0].key).to.equal("threshold");
    expect(parsed.fields[0].type).to.equal("int128");
  });

  it("bucketLabel: 1 => 'Yes', 2 => 'No', 0 => ''", async function () {
    const g = await deploy();
    expect(await g.bucketLabel(GAME_ID, YES)).to.equal("Yes");
    expect(await g.bucketLabel(GAME_ID, NO)).to.equal("No");
    expect(await g.bucketLabel(GAME_ID, 0)).to.equal("");
  });
});
