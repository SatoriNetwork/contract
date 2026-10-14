// IStreamAdapterUIDescriptor reference implementation on the three canonical
// stream adapters (Chainlink V3, Uniswap V3, Custom).
//
// These are pure/view, additive, UI-metadata functions. They never touch the
// core, registry, games, or rewards — so each adapter is deployed standalone
// and asserted directly. The whole point of the descriptor is that NOTHING
// on-chain depends on it, mirroring IGameUIDescriptor.

const { expect } = require("chai");
const { ethers } = require("hardhat");

const EXPECTED_CHAINLINK_CONFIG_SCHEMA =
  '{"version":1,"fields":[{"key":"maxFeedAge","label":"Max feed age (seconds)","type":"uint64","min":"60","max":"93600","help":"Reject the Chainlink answer if older than this. 60s-26h."}]}';

const EMPTY_CONFIG_SCHEMA = '{"version":1,"fields":[]}';

// An arbitrary address used where valueDisplay ignores `target`, and an EOA /
// non-responding address used to prove the Chainlink try/catch fallback.
const ANY_ADDR = "0x000000000000000000000000000000000000dEaD";

async function deployChainlink() {
  const F = await ethers.getContractFactory("ChainlinkV3Adapter");
  const c = await F.deploy();
  await c.waitForDeployment();
  return c;
}

async function deployUniswap() {
  const F = await ethers.getContractFactory("UniswapV3Adapter");
  const c = await F.deploy();
  await c.waitForDeployment();
  return c;
}

async function deployCustom() {
  const F = await ethers.getContractFactory("CustomAdapter");
  const c = await F.deploy();
  await c.waitForDeployment();
  return c;
}

describe("Stream adapters — IStreamAdapterUIDescriptor (optional, view-only)", function () {
  describe("uiSchemaVersion() == 1 for all three", function () {
    it("Chainlink", async function () {
      expect(await (await deployChainlink()).uiSchemaVersion()).to.equal(1);
    });
    it("Uniswap", async function () {
      expect(await (await deployUniswap()).uiSchemaVersion()).to.equal(1);
    });
    it("Custom", async function () {
      expect(await (await deployCustom()).uiSchemaVersion()).to.equal(1);
    });
  });

  describe("configSchema()", function () {
    it("Chainlink: exact maxFeedAge JSON, parses with key/type/min/max", async function () {
      const c = await deployChainlink();
      const s = await c.configSchema();
      expect(s).to.equal(EXPECTED_CHAINLINK_CONFIG_SCHEMA);
      const parsed = JSON.parse(s);
      expect(parsed.fields[0].key).to.equal("maxFeedAge");
      expect(parsed.fields[0].type).to.equal("uint64");
      expect(parsed.fields[0].min).to.equal("60");
      expect(parsed.fields[0].max).to.equal("93600");
    });

    it("Chainlink: min/max mirror MIN_FEED_AGE / MAX_FEED_AGE", async function () {
      const c = await deployChainlink();
      const parsed = JSON.parse(await c.configSchema());
      expect(BigInt(parsed.fields[0].min)).to.equal(await c.MIN_FEED_AGE());
      expect(BigInt(parsed.fields[0].max)).to.equal(await c.MAX_FEED_AGE());
    });

    it("Uniswap: one optional twapWindow field", async function () {
      const u = await deployUniswap();
      const parsed = JSON.parse(await u.configSchema());
      expect(parsed.version).to.equal(1);
      expect(parsed.fields).to.have.length(1);
      expect(parsed.fields[0].key).to.equal("twapWindow");
      expect(parsed.fields[0].type).to.equal("uint32");
      expect(parsed.fields[0].optional).to.equal(true);
      // The advertised bounds must be the ones actually enforced, or the dapp
      // builds a form that submits values the adapter rejects.
      expect(BigInt(parsed.fields[0].min)).to.equal(await u.MIN_TWAP_WINDOW());
      expect(BigInt(parsed.fields[0].default)).to.equal(await u.DEFAULT_TWAP_WINDOW());
      // No policy ceiling: the advertised max is the hard limit of a uint16
      // observation ring, not a rule of ours.
      expect(BigInt(parsed.fields[0].max)).to.equal(65535n);
    });

    it("Custom: empty field set", async function () {
      const c = await deployCustom();
      const s = await c.configSchema();
      expect(s).to.equal(EMPTY_CONFIG_SCHEMA);
      expect(JSON.parse(s).fields).to.deep.equal([]);
    });
  });

  describe("valueDisplay()", function () {
    it("Uniswap => (0, 'tick', 'Uniswap V3 TWAP tick')", async function () {
      const u = await deployUniswap();
      const [decimals, unit, label] = await u.valueDisplay(ANY_ADDR, "0x");
      expect(decimals).to.equal(0);
      expect(unit).to.equal("tick");
      expect(label).to.equal("Uniswap V3 TWAP tick");
    });

    it("Custom => (0, '', 'Custom value')", async function () {
      const c = await deployCustom();
      const [decimals, unit, label] = await c.valueDisplay(ANY_ADDR, "0x");
      expect(decimals).to.equal(0);
      expect(unit).to.equal("");
      expect(label).to.equal("Custom value");
    });

    it("Chainlink against a NON-responding target falls back without reverting", async function () {
      const c = await deployChainlink();
      // EOA / dead address: no decimals()/description() — proves try/catch.
      const [decimals, unit, label] = await c.valueDisplay(ANY_ADDR, "0x");
      expect(decimals).to.equal(8);
      expect(unit).to.equal("");
      expect(label).to.equal("Chainlink feed");
    });

    it("Chainlink against a CONTRACT lacking decimals()/description() falls back via try/catch", async function () {
      const c = await deployChainlink();
      // MockDataStream has code but no decimals()/description() — exercises the
      // try/catch fallback path distinctly from the codeless short-circuit.
      const Stream = await ethers.getContractFactory("MockDataStream");
      const stream = await Stream.deploy();
      await stream.waitForDeployment();
      const [decimals, unit, label] = await c.valueDisplay(await stream.getAddress(), "0x");
      expect(decimals).to.equal(8);
      expect(unit).to.equal("");
      expect(label).to.equal("Chainlink feed");
    });

    it("Chainlink happy path: passes through aggregator decimals()/description()", async function () {
      const c = await deployChainlink();
      const Mock = await ethers.getContractFactory("MockChainlinkAggregator");
      const agg = await Mock.deploy();
      await agg.waitForDeployment();
      // Default mock metadata: 8 decimals, "ETH / USD".
      let [decimals, unit, label] = await c.valueDisplay(await agg.getAddress(), "0x");
      expect(decimals).to.equal(8);
      expect(unit).to.equal("");
      expect(label).to.equal("ETH / USD");

      // Override and re-read to prove genuine passthrough (not the fallback).
      await agg.setMetadata(18, "BTC / USD");
      [decimals, unit, label] = await c.valueDisplay(await agg.getAddress(), "0x");
      expect(decimals).to.equal(18);
      expect(unit).to.equal("");
      expect(label).to.equal("BTC / USD");
    });
  });
});
