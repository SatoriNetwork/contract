const { ethers } = require("hardhat");

// Reconstruct an RLP block header from an `eth_getBlockByNumber` result.
//
// WHY THIS EXISTS. The proposal (§16) prefers `debug_getRawHeader`, which hands
// back the RLP directly. Almost no public RPC exposes `debug_*`, so in practice
// reconstruction is the NORMAL path, not the fallback — and reconstruction is
// the one place in this design where a silent mistake is possible, because a
// wrong field order or a wrong integer encoding produces a header that is simply
// a different block.
//
// That is survivable for exactly one reason: the caller must assert
// `keccak256(header) === block.hash` before submitting. A reconstruction bug then
// fails loudly and locally instead of on chain. `rawHeaderFor` below does that
// assertion itself, so a caller cannot forget.
//
// FIELD ORDER is consensus, and every fork that has extended the header has
// APPENDED to it. The optional tail is included only as far as the RPC reports
// it, which is what makes one encoder work across pre-London chains, Base today,
// and whatever Base becomes.

// Quantities are RLP integers: minimal-width, big-endian, and zero is the empty
// string. Getting this wrong on a field that happens to be zero (a common case
// for `difficulty` and `blobGasUsed` post-merge) is the classic reconstruction
// bug, because the header still looks plausible.
function qty(hexish) {
  if (hexish === undefined || hexish === null) return "0x";
  const v = BigInt(hexish);
  if (v === 0n) return "0x";
  let h = v.toString(16);
  if (h.length % 2) h = "0" + h;
  return "0x" + h;
}

// Byte strings (hashes, addresses, bloom, extraData) pass through as-is.
const data = (h) => (h === undefined || h === null ? "0x" : h);

/// The consensus field order. Index 3 is stateRoot and index 8 is number —
/// the two this design reads — and both sit in the frontier-era prefix.
function headerFields(b) {
  const fields = [
    data(b.parentHash),        // 0
    data(b.sha3Uncles),        // 1
    data(b.miner),             // 2
    data(b.stateRoot),         // 3  <- what we are after
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
  // The appended tail, in fork order. Each is included only if the node reports
  // it, and a present field means every earlier optional field is present too —
  // so this walks the list rather than testing each independently.
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

/// Reconstruct, and REFUSE to return anything that does not hash to the block's
/// own hash. Never relax this — it is the whole safety argument.
function rawHeaderFor(block) {
  const raw = ethers.encodeRlp(headerFields(block));
  const got = ethers.keccak256(raw);
  if (got.toLowerCase() !== block.hash.toLowerCase()) {
    throw new Error(
      `header reconstruction mismatch for block ${BigInt(block.number)}:\n` +
      `  reconstructed ${got}\n  block.hash    ${block.hash}\n` +
      `  (field count ${headerFields(block).length} — a fork may have appended a field)`
    );
  }
  return raw;
}

module.exports = { rawHeaderFor, headerFields, qty };
