// Measures the actual gas savings of the hasParticipated sync-skip mask
// in _update. Compares paths:
//   A) transfer between two never-participated addresses (skip-mask active)
//   B) transfer between participant sender and never-participated recipient
//   C) transfer between two already-participating addresses (warm syncs)
//
// All transfers move 1 wei to isolate the _update overhead.
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { deploySatoriFixture } = require("../test/fixtures");

async function main() {
  const fix = await loadFixture(deploySatoriFixture);
  const { satori } = fix;
  const [, alice, bob, carol, dave, eve, frank] = fix.signers;

  // Fund everyone with 1 token so they have balance to send.
  for (const u of [alice, carol, eve]) {
    await satori.transfer(u.address, ethers.parseEther("1"));
  }
  await satori.initializeDefaultStream();

  // Path A: alice -> bob, both non-participants.
  const receiptA = await (await satori.connect(alice).transfer(bob.address, 1n)).wait();
  console.log(`A) non-participant → non-participant (skip-mask active): gasUsed = ${receiptA.gasUsed}`);

  // Make carol and eve participate.
  await satori.connect(carol).vote(1);
  await satori.connect(eve).vote(1);

  // Send 1 token to eve so she keeps a balance to send back. Eve's vote already
  // marked her, so her receive in the funding doesn't depend on the skip-mask.

  // Path B: carol -> dave, sender participates, recipient doesn't (cold child slot for dave).
  const receiptB = await (await satori.connect(carol).transfer(dave.address, 1n)).wait();
  console.log(`B) participant → non-participant (cold child slots for dave): gasUsed = ${receiptB.gasUsed}`);

  // Path C: carol -> eve, both participants (warm child slots).
  const receiptC = await (await satori.connect(carol).transfer(eve.address, 1n)).wait();
  console.log(`C) participant → participant (carol/eve already in child contracts): gasUsed = ${receiptC.gasUsed}`);

  // Path D: second transfer along the same edge to measure warm cost.
  const receiptD = await (await satori.connect(carol).transfer(eve.address, 1n)).wait();
  console.log(`D) participant → participant, second transfer (fully warm): gasUsed = ${receiptD.gasUsed}`);

  console.log();
  console.log(`Savings from skip-mask (B - A): ${receiptB.gasUsed - receiptA.gasUsed} gas`);
  console.log(`Savings from skip-mask (D - A): ${receiptD.gasUsed - receiptA.gasUsed} gas`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
