const { ethers } = require("hardhat");

// Every SATORI destroyed so far. Votes and the hub's fees (stream, game,
// community adapter, bounty posting) all burn, so the supply identity is
// supply == rewards minted + airdrop minted - burned.
// Accepts the token, or the hub (anything with `token()`).
async function burnedTotal(tokenOrHub) {
  const token = typeof tokenOrHub.filters?.Transfer === "function"
    ? tokenOrHub
    : await ethers.getContractAt("SatoriToken", await tokenOrHub.token());
  const logs = await token.queryFilter(token.filters.Transfer(null, ethers.ZeroAddress));
  return logs.reduce((sum, l) => sum + l.args.value, 0n);
}

module.exports = { burnedTotal };
