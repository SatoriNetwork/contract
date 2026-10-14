"use strict";
const { encodeRlp, keccak256 } = require("ethers");

// Reconstruct an RLP block header from an `eth_getBlockByNumber` result.
//
// This is a PORT of satori/test/governance/rlpHeader.js (the canonical copy,
// with the full WHY) minus its hardhat import — the pipeline must be
// self-contained for its Docker build. Keep the two in sync; the e2e test
// exercises this copy against the on-chain verifier, so drift fails loudly.
//
// The one safety rule survives intact: NEVER return a header that does not
// hash to the block's own hash. A reconstruction bug then fails here,
// locally and loudly, instead of on chain.

// Quantities are RLP integers: minimal-width, big-endian, zero is the empty
// string. Getting this wrong on a field that happens to be zero (difficulty,
// blobGasUsed) is the classic reconstruction bug.
function qty(hexish) {
  if (hexish === undefined || hexish === null) return "0x";
  const v = BigInt(hexish);
  if (v === 0n) return "0x";
  let h = v.toString(16);
  if (h.length % 2) h = "0" + h;
  return "0x" + h;
}

const data = (h) => (h === undefined || h === null ? "0x" : h);

function headerFields(b) {
  const fields = [
    data(b.parentHash),        // 0
    data(b.sha3Uncles),        // 1
    data(b.miner),             // 2
    data(b.stateRoot),         // 3  <- what the verifier is after
    data(b.transactionsRoot),  // 4
    data(b.receiptsRoot),      // 5
    data(b.logsBloom),         // 6
    qty(b.difficulty),         // 7
    qty(b.number),             // 8  <- cross-checked on chain
    qty(b.gasLimit),           // 9
    qty(b.gasUsed),            // 10
    qty(b.timestamp),          // 11
    data(b.extraData),         // 12
    data(b.mixHash),           // 13
    data(b.nonce),             // 14
  ];
  // The appended tail, in fork order. A present field implies every earlier
  // optional field is present, so walk and stop.
  const tail = [
    ["baseFeePerGas", qty],          // London
    ["withdrawalsRoot", data],       // Shanghai
    ["blobGasUsed", qty],            // Cancun
    ["excessBlobGas", qty],          // Cancun
    ["parentBeaconBlockRoot", data], // Cancun
    ["requestsHash", data],          // Prague / OP Stack Isthmus
  ];
  for (const [key, enc] of tail) {
    if (b[key] === undefined || b[key] === null) break;
    fields.push(enc(b[key]));
  }
  return fields;
}

function rawHeaderFor(block) {
  const raw = encodeRlp(headerFields(block));
  const got = keccak256(raw);
  if (got.toLowerCase() !== block.hash.toLowerCase()) {
    throw new Error(
      `header reconstruction mismatch for block ${BigInt(block.number)}: ` +
      `reconstructed ${got}, block.hash ${block.hash} ` +
      `(field count ${headerFields(block).length} — a fork may have appended a field)`
    );
  }
  return raw;
}

module.exports = { rawHeaderFor, headerFields, qty };
