/// Shared multi-decimal token fixture for bounty/stake economic tests.
///
/// Real-world ERC20s span a wide range of decimal counts. This helper
/// stands up a standard set so each economic-intent test can run against
/// the same realistic matrix:
///
///   USDC-like  — 6 decimals  (stablecoin standard)
///   WBTC-like  — 8 decimals  (bitcoin-precision representation)
///   DAI-like   — 18 decimals (canonical ERC20)
///   GEMS-like  — 0 decimals  (extreme low-precision sanity check)
///
/// Each token is returned with: contract handle, address, decimals,
/// and a `units(n)` helper that converts a whole-token count into the
/// token's base-unit amount (so test math reads naturally regardless
/// of decimals).

const { ethers } = require("hardhat");

/// Standard multi-decimal set used across economic-fairness tests.
const STANDARD_DECIMAL_SET = [
  { key: "USDC", name: "Mock USDC",  symbol: "USDC", decimals: 6  },
  { key: "WBTC", name: "Mock WBTC",  symbol: "WBTC", decimals: 8  },
  { key: "DAI",  name: "Mock DAI",   symbol: "DAI",  decimals: 18 },
  { key: "GEMS", name: "Mock Gems",  symbol: "GEMS", decimals: 0  },
];

/// Deploy a single ERC20 with the given decimals. Returns an object with
/// `{ contract, address, decimals, symbol, units }`. The `units(n)`
/// helper converts a whole-token count to base-unit amount (BigInt).
async function deployToken({ name = "Mock", symbol = "MCK", decimals = 18 } = {}) {
  const F = await ethers.getContractFactory("MockERC20WithDecimals");
  const t = await F.deploy(name, symbol, decimals);
  await t.waitForDeployment();
  const address = await t.getAddress();
  const dec = BigInt(decimals);
  return {
    contract: t,
    address,
    decimals,
    symbol,
    units(n) {
      // n can be a number, string, or BigInt — interpret as a whole-token count.
      return BigInt(n) * (10n ** dec);
    },
  };
}

/// Deploy the standard multi-decimal set as a keyed object:
///   { USDC, WBTC, DAI, GEMS } — each entry shaped per `deployToken`.
async function deployStandardTokenSet() {
  const out = {};
  for (const spec of STANDARD_DECIMAL_SET) {
    out[spec.key] = await deployToken(spec);
  }
  return out;
}

/// Mint `wholeUnits` of token `t` to each address in `recipients` AND
/// approve them to spend that amount on the `spender` address. Common
/// pre-test setup ergonomic: one call gets every actor ready to stake.
async function mintAndApprove(t, recipients, spender, wholeUnits) {
  const amount = t.units(wholeUnits);
  for (const r of recipients) {
    const addr = typeof r === "string" ? r : r.address;
    await t.contract.mint(addr, amount);
    if (typeof r !== "string") {
      await t.contract.connect(r).approve(spender, amount);
    }
  }
  return amount;
}

module.exports = {
  STANDARD_DECIMAL_SET,
  deployToken,
  deployStandardTokenSet,
  mintAndApprove,
};
