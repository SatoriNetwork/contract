// Base rejects any transaction that asks for more than 2^24 gas (EIP-7825, in
// force since the Azul hardfork), whatever the block limit. The batch sizes the
// dapp builds are sized against that, with a tenth held back.
//
// Measured on the contracts (test/BatchPredictionGasScaling.test.js, steady
// state: predict plus settle last round): ~317k fixed plus ~138k per game. A game
// the user holds a bounty stake on costs ~126k more, and the dapp does not know
// which games those are, so the cap assumes every game carries one. Adapter pulls
// cost ~150-190k each (docs/issues/rolling-24h-scoring.md, AdapterGas fork test).
export const TX_GAS_CAP = 16_777_216;

const BUDGET = Math.floor(TX_GAS_CAP * 0.9);
const PREDICT_FIXED_GAS = 317_000;
const PREDICT_GAME_GAS = 138_500;
const BOUNTY_STAKE_EXTRA_GAS = 126_000;
const STREAM_PULL_GAS = 150_000;

/** Most games one predict batch may carry. */
export const MAX_BATCH_PREDICTIONS = Math.floor(
  (BUDGET - PREDICT_FIXED_GAS) / (PREDICT_GAME_GAS + BOUNTY_STAKE_EXTRA_GAS),
);

/** Most streams one updateValues / setValues batch may carry. */
export const MAX_BATCH_STREAMS = Math.floor(BUDGET / STREAM_PULL_GAS);
