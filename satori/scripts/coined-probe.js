// Is `address` a Coined that CoinedAdapter can read? CoinedAdapter reads openOf
// and prices it on a copy of Coined's curve, so a Coined without openOf, or on
// another curve, would make every Coined stream fail or read wrong, for good.
//
// Read-only, so deploy.js runs it before its first chain write. Id 0x00..01 is
// never coined, so its supply is 0: its price is V/K, and 1 USDC buys
// isqrt(V² + 1e6·2K·1e18) − V units. The two pin V and K.
const { ethers } = require("ethers");

// Keep equal to CoinedAdapter.VIRTUAL_SUPPLY and CoinedAdapter.K.
const V = 1_000n * 10n ** 18n;
const K = 5n * 10n ** 15n;
const USDC = 10n ** 6n;
const WAD = 10n ** 18n;

function isqrt(n) {
  if (n < 2n) return n;
  let x = n, y = (x + 1n) / 2n;
  while (y < x) { x = y; y = (x + n / x) / 2n; }
  return x;
}

async function checkCoined(provider, address) {
  const c = new ethers.Contract(address, [
    "function openOf(bytes32) view returns (uint256)",
    "function priceOf(bytes32) view returns (uint256)",
    "function quoteBuy(bytes32,uint256) view returns (uint256)",
  ], provider);
  const never = ethers.zeroPadValue("0x01", 32);
  let price, units;
  try {
    await c.openOf(never);
    price = await c.priceOf(never);
    units = await c.quoteBuy(never, USDC);
  } catch (e) {
    throw new Error(`COINED_ADDRESS ${address} does not answer openOf, priceOf and quoteBuy ` +
      `(${e.shortMessage ?? e.message}) — CoinedAdapter needs Coined from current master.`);
  }
  const wantUnits = isqrt(V * V + USDC * 2n * K * WAD) - V;
  if (price !== V / K || units !== wantUnits) {
    throw new Error(`COINED_ADDRESS ${address} prices on another curve than CoinedAdapter copies: ` +
      `priceOf(0x..01) = ${price} (want ${V / K}), quoteBuy(0x..01, 1 USDC) = ${units} (want ${wantUnits}).`);
  }
}

module.exports = { checkCoined };
