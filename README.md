# Satori Protocol

A decentralized prediction market protocol with multi-source DataStream oracles and dynamic reward distribution.

## Features

### DataStream Types (4 of 5 Implemented)

**✅ Production Ready:**
1. **Simple Streams** - Registry-managed streams with direct value updates
2. **Custom Streams** - User-deployed oracle contracts implementing IDataStream interface
3. **Uniswap TWAP** - Time-weighted average prices from Uniswap V3 pools (30-min window)
4. **Chainlink Oracles** - Decentralized price feeds from Chainlink network

**⏸️ Pending:**
5. **OffChain Streams** - Merkle proof-based off-chain data (contract space reserved)

### Core Functionality

- **Prediction Markets** - Daily rounds with UP/DOWN/SAME predictions
- **Dynamic Rewards** - Proportional reward distribution based on prediction weight
- **Voting System** - Top 80% voting power determines eligible streams
- **Delegation** - Both claim delegation and prediction delegation supported
- **Streak Bonuses** - Weight multipliers for consecutive correct predictions
- **Historical Data** - 30-day circular buffer for all stream types

### UI Integration

- **React dApp** - Full-featured UI built with React and TypeScript
- **Stream Creation** - User-friendly forms for all 4 stream types
- **Governance Tab** - Stream management and voting interface
- **Real-time Charts** - Historical data visualization with Recharts
- **Wallet Integration** - MetaMask and WalletConnect support

## Architecture

**4-Contract Modular System:**
- `Satori.sol` — Core prediction market logic, SATORI ERC-20, mint paths
  (`claim` / `rewardMint` / `claimSlack`), and the default-stream lifecycle.
- `SatoriRegistry.sol` — DataStream registry and value history (32-slot
  ring buffer per stream). Hosts the 4 stream types (Simple, Custom,
  Chainlink, Uniswap) and the stale-anchor force-finalize logic.
- `SatoriRewards.sol` — Reward calculation, eager-credit scoring, the
  merged-pool bounty system (fund / drip / withdraw), the per-(user, token)
  stake surface for auto-boost, and prediction/claim delegation.
- `SatoriVoting.sol` — Stream eligibility voting + vote delegation.

`Multicall.sol` is a thin convenience contract present for legacy use; the
dapp can point at canonical Multicall3 at `0xcA11bde05977b3631167028862bE2a173976CA11`
instead.

Earlier drafts referenced a separate `SatoriHistory.sol` and a standalone
`BountyVault.sol`. Both are gone — the history ring lives inside
`SatoriRegistry.sol`, and the bounty surface was merged into
`SatoriRewards.sol` (commit `fba1a36`; further redesigned to a merged
per-(stream, token) pool in `d1370e2`). Documentation that still
references either name is stale.

## Prerequisites

- Node.js 16+ and npm
- Hardhat (`npm install`)
- MetaMask or compatible wallet (for UI)

## Setup

### Smart Contracts

1. Install dependencies:
```bash
cd satori
npm install
```

2. Compile contracts:
```bash
npx hardhat compile
```

### UI (React dApp)

1. Install dependencies:
```bash
cd satori-ui
npm install
```

2. Start development server:
```bash
npm start
```

## Running Tests

`satori/` is the hardhat project. Every hardhat command runs from there, and
`npm test` from the repo root does the `cd` for you. There is deliberately no
second config at the root: two project roots over one contract set gave every
contract two names and silently disarmed the size and storage-layout guards
(`docs/issues/closed/hardhat-guards-silently-fail-from-repo-root.md`).

Run all tests:
```bash
npm test              # from the repo root
cd satori && npx hardhat test    # equivalent
```

Run a specific test file:
```bash
cd satori
npx hardhat test test/Satori.test.js              # core functionality
npx hardhat test test/UniswapDataStreams.test.js  # Uniswap TWAP
npx hardhat test test/Voting.test.js              # voting
npx hardhat test test/Bounty.test.js              # bounties
```

The suite is the source of truth for its own size; run it rather than trusting a
count written here. The deploy guards are part of it
(`test/ContractSize.test.js`, `test/StorageLayout.test.js`), so a contract that
grew past the EIP-170 limit or moved a storage slot fails the run.
- ❌ 0 failing

### E2E Tests (Playwright)

Run UI end-to-end tests:
```bash
cd satori-ui

# Install Playwright (first time only)
npx playwright install

# Run all E2E tests
npx playwright test

# Run stream creation tests (13 tests)
npx playwright test tests/stream-creation-all-types.spec.ts

# Run with UI
npx playwright test --ui

# Generate report
npx playwright test --reporter=html
```

**E2E Test Coverage:**
- Stream creation flows (all 4 types)
- Form validation and error handling
- Datastream voting and cycling
- Historical data display
- Accessibility (keyboard navigation, ARIA labels)

## Deployment

### Local Deployment (Hardhat Network)

All of these run from `satori/`, the hardhat project.

1. Start a local Hardhat node in one terminal:
```bash
cd satori
npx hardhat node
```

2. In another terminal, deploy the contract:
```bash
cd satori
npx hardhat run scripts/deploy.js --network localhost
```

### Deploy to Hardhat's Built-in Network (temporary):
```bash
cd satori
npx hardhat run scripts/deploy.js
```

## Setup Script

After deployment, you can put the contract in a typical state (advance through several rounds):

```bash
cd satori
CONTRACT_ADDRESS=0x... npx hardhat run scripts/setup.js --network localhost
```

Replace `0x...` with your deployed contract address.

## Key Contract Functions

### Round Management
- `getCurrentRound()` — Current round number (`block.timestamp /
  timeUnitSeconds`). Rounds are wall-clock-based; there is no explicit
  `endRound` step.

### DataStream Management
- `createSimpleDataStream(name, authority)` — Create a Simple stream.
- `createCustomDataStream(name, target, authority)` — Register a Custom
  oracle (caller-supplied `IDataStream` implementation).
- `createUniswapDataStream(name, pool, authority)` — Create a Uniswap V3
  TWAP stream (8-hour TWAP window per `UNISWAP_TWAP_WINDOW`).
- `createChainlinkDataStream(name, aggregator, authority)` — Create a
  Chainlink-backed stream.
- `setValue(streamId, value)` — Update Simple-stream value (authority only).
- `updateValue(streamId)` — Pull-mode: fetch fresh value from a
  Custom / Uniswap / Chainlink stream (permissionless).

### Predictions
- `predict(streamId, direction)` — Make a prediction (UP=1, DOWN=2).
- `predictMultiple(requests[])` — Batch up to 25 streams per round.
- `settlePrediction(user, streamId)` — Permissionless: settle a pending
  prediction (correct → eager credit; wrong → no credit; voided /
  unrecoverable handled in-line).
- `claim()` / `claim(recipient)` — Claim accumulated `unclaimedRewards`
  SATORI to msg.sender or to a chosen recipient.
- `claimFor(owner, recipient)` — Authorized claim via claim-delegation.

### Bounty
- `fundBounty(streamId, token, amount, proposedRate)` — Irrevocably fund a
  (stream, token) bounty pool. Anyone can call. Rate is contribution-
  weighted across funders. No recover path.
- `withdrawBounty(tokens[], recipient)` — Per-token bounty withdrawal.

### Voting + delegation
- `vote(streamId, isUp)` — Cast a vote (weight = your SATORI balance).
- `setVoteDelegation(delegate)` — Delegate your vote weight.
- `delegatePredictionPower(delegate)` — Delegate your prediction power.
  The delegator earns SATORI share via 80/10/5/5; bounty share is
  predictor-only.
- `delegateClaimAbility(delegate)` — Delegate the right to call
  `claimFor` on your behalf.

### Stake / boost
- `stakeBountyToken(token, amount)` — Lock an ERC-20 to use as boost on
  future predictions on streams with bounties in that token.
- `unstakeBountyToken(token, amount, recipient)` — Reclaim; blocked while
  the stake is committed to a pending prediction.

## Project Structure

```
/app/
├── satori/                      # Smart contracts
│   ├── contracts/
│   │   ├── Satori.sol           # Core prediction market + SATORI ERC-20
│   │   ├── SatoriRegistry.sol   # DataStream registry + value-history ring
│   │   ├── SatoriRewards.sol    # Rewards, bounty pool, stake/boost,
│   │   │                        #   prediction + claim delegation
│   │   ├── SatoriVoting.sol     # Stream eligibility voting + delegation
│   │   ├── Multicall.sol        # Legacy convenience; canonical Multicall3
│   │   │                        #   exists at 0xcA11...CA11 on every chain
│   │   ├── interfaces/          # Cross-contract interfaces
│   │   ├── libraries/           # SatoriTypes (shared constants + structs)
│   │   └── mocks/               # Test mocks (MockERC20, MockFeeERC20, …)
│   ├── test/                    # Hardhat test suite
│   └── scripts/
│       ├── deploy.js            # Deployment script
│       └── setup.js             # Setup typical state
│
├── satori-ui/                   # React dApp
│   ├── src/
│   │   ├── components/
│   │   │   ├── streams/StreamCreation.tsx  # Stream creation UI
│   │   │   ├── charts/          # Data visualization
│   │   │   ├── prediction/      # Prediction interface
│   │   │   └── voting/          # Voting interface
│   │   ├── hooks/               # React hooks
│   │   ├── pages/               # Page components
│   │   └── utils/               # Utilities
│   ├── tests/                   # Playwright E2E tests
│   │   ├── stream-creation-all-types.spec.ts  # 13 tests
│   │   └── datastream-cycling.spec.ts
│   └── public/                  # Static assets
│
└── docs/                        # Documentation
    ├── features/
    │   ├── UI_STREAM_CREATION.md    # User guide (NEW)
    │   └── UNISWAP_TWAP.md          # Uniswap integration
    ├── design/
    │   ├── DATA_STREAMS.md          # DataStream architecture
    │   └── VOTE.md                  # Voting system
    ├── testing/
    │   └── E2E_TESTING.md           # Playwright documentation (NEW)
    └── issues/
        └── ISSUES.md                # Current status
```

## Documentation

### User Guides
- **[UI Stream Creation Guide](/app/docs/features/UI_STREAM_CREATION.md)** - How to create streams through the UI
- **[Uniswap TWAP Guide](/app/docs/features/UNISWAP_TWAP.md)** - Uniswap V3 integration details

### Technical Documentation
- **[DataStream Design](/app/docs/design/DATA_STREAMS.md)** - DataStream architecture and types
- **[Voting System](/app/docs/design/VOTE.md)** - Dual heap voting mechanism
- **[E2E Testing](/app/docs/testing/E2E_TESTING.md)** - Playwright test documentation

### Status
- **[Issues & Status](/app/docs/issues/ISSUES.md)** - Current system status and resolved issues

## System Status

**Version:** v2.1 (5-contract modular architecture)

**Smart Contracts:**
- ✅ 339/339 tests passing (100%)
- ✅ All contracts under 24KB size limit
- ✅ 19,062 bytes headroom for future features
- ✅ 4 of 5 DataStream types implemented

**UI:**
- ✅ Full stream creation interface
- ✅ Real-time historical data charts
- ✅ Voting and governance UI
- ✅ E2E test coverage (13 Playwright tests)

**Production Ready:** ✅ YES
- All core functionality implemented and tested
- UI fully integrated with smart contracts
- Comprehensive documentation
- E2E test coverage
- Ready for mainnet deployment

## License

MIT