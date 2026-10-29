// The on-chain gross a fresh round is priced at, computed independently of
// SatoriHub.onChainGrossNow: the residual (emission net of the dev fee) less the
// off-chain share, floored the way the hub floors it.
async function onChainGrossOf(satori, rewards) {
  const residual = (await satori.emissionRateNow()) - (await satori.devRateNow());
  return residual - residual * (await rewards.offchainShareBps()) / 10000n;
}

module.exports = { onChainGrossOf };
