#!/usr/bin/env node
// Regenerate the committed record of every event an off-chain reader consumes
// (docs/issues/events-are-the-read-model.md, rule 3): its full signature and
// topic0, from the compiled artifacts. Writes test/fixtures/event-topics.json and
// the indexer's identical copy, satori-indexer/src/events.json.
//
//   npx hardhat compile && node scripts/gen-event-topics.js
//
// EventTopics.test.js fails while an artifact disagrees with the fixture, so a
// change to a consumed event is always a reviewed diff of this file's output.
// Add an event to CONSUMED when a reader starts using it.
const fs = require('fs');
const path = require('path');
const { Interface } = require('ethers');

const CONSUMED = {
  SatoriEngine: [
    'PredictionMade', 'PredictionScored', 'PredictionVoided', 'PredictionUnrecoverable',
    'PredictionDisplaced', 'StreakThresholdSet', 'CurveConfigSet',
  ],
  SatoriBounties: [
    'BountyFunded', 'BountyDripped', 'StrandedPotReclaimed', 'BountyTokenCleaned',
    'BountyPaid', 'BountyTokenStaked', 'BountyTokenUnstaked',
  ],
  SatoriRewards: [
    'ReferralPaid', 'ReferralSet', 'RewardSplit', 'DelegatorRewardsAccrued', 'RewardsClaimed',
    'RoundBudgetFrozen', 'PredictionDelegated', 'PredictionUndelegated', 'DelegatePowerSynced',
    'ClaimDelegated', 'ClaimUndelegated',
  ],
  SatoriVoting: ['Voted', 'GameApprovedSet', 'VotesMoved'],
  SatoriRegistry: [
    'DataStreamCreated', 'NamedAdapterSet', 'NamedStreamCreated', 'StreamValueUpdated',
    'NameUpdated', 'ProviderChanged',
  ],
  SatoriGames: ['GameCreated', 'GameNameUpdated', 'GameAuthorityTransferred'],
  SatoriAirdrop: ['AirdropAllocated', 'AirdropClaimed'],
};

const ARTIFACTS = path.join(__dirname, '..', 'artifacts', 'contracts');

function findArtifact(name) {
  const stack = [ARTIFACTS];
  while (stack.length) {
    const dir = stack.pop();
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.name === `${name}.json`) return p;
    }
  }
  throw new Error(`no artifact for ${name}; compile first`);
}

function build() {
  const out = {};
  for (const [contract, events] of Object.entries(CONSUMED)) {
    const iface = new Interface(JSON.parse(fs.readFileSync(findArtifact(contract), 'utf8')).abi);
    out[contract] = {};
    for (const name of events) {
      const ev = iface.getEvent(name);
      if (!ev) throw new Error(`${contract} has no event ${name}`);
      out[contract][name] = { signature: ev.format('full'), topic: ev.topicHash };
    }
  }
  return out;
}

module.exports = { CONSUMED, build };

if (require.main === module) {
  const text = JSON.stringify(build(), null, 2) + '\n';
  for (const p of [
    path.join(__dirname, '..', 'test', 'fixtures', 'event-topics.json'),
    path.join(__dirname, '..', '..', 'satori-indexer', 'src', 'events.json'),
  ]) {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, text);
    console.log(`wrote ${path.relative(process.cwd(), p)}`);
  }
}
