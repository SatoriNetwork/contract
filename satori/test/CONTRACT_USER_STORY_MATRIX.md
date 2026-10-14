# Contract User Story & Interaction Matrix

This document enumerates contract-level user stories and interaction combinations for:

- Claiming
- Claim delegation
- Prediction
- Prediction delegation
- Voting
- Vote delegation
- Multi-round timing effects

Its purpose is to make sure tests cover expected on-chain behavior for **all meaningful combinations**.

---

## 1) Core Actors and Relationships

- **Owner**: protocol owner/deployer actions and admin controls.
- **User**: regular token holder who can vote, predict, delegate, claim.
- **Predictor**: user currently making predictions.
- **Delegator**: user delegating prediction/voting/claim abilities.
- **Delegatee**: user receiving delegation.
- **Claim delegate**: address authorized to claim for owner.
- **Platform fee recipients**: fee destination addresses.

Relationship types:

1. `vote delegation`: `A -> B`
2. `prediction delegation`: `A -> B`
3. `claim delegation`: `A -> B`
4. `split delegation`: same user delegates different powers to different counterparties.
5. `switching`: delegation changes from old delegate to new delegate.
6. `undelegation`: delegation removed (including round-lock effects).

---

## 2) Baseline User Stories (Single Feature, Single Round)

### Claiming

- US-C1: User claims own rewards to self.
- US-C2: User claims own rewards to a different recipient.
- US-C3: User claims with zero rewards (returns 0, no unexpected mint).
- US-C4: User cannot double-claim already claimed rewards.

### Claim Delegation

- US-CD1: Owner delegates claim ability.
- US-CD2: Delegate claims on behalf of owner.
- US-CD3: Non-delegate cannot claim for owner.
- US-CD4: Owner blocked from self-claim while claim delegation is active.
- US-CD5: Undelegation cooldown enforced (cannot claim until next round).

### Prediction

- US-P1: User predicts on eligible stream with valid direction.
- US-P2: User blocked from double-predicting same round.
- US-P3: Invalid stream/direction reverts.
- US-P4: Prediction lock semantics enforced.

### Prediction Delegation

- US-PD1: Delegator delegates prediction power to delegatee.
- US-PD2: Delegator cannot predict while delegated.
- US-PD3: Delegatee prediction power includes delegated amounts.
- US-PD4: Undelegation updates lock and future behavior.

### Voting

- US-V1: User votes on valid stream.
- US-V2: Vote change correctly updates stream weights.
- US-V3: Eligibility reacts to vote weight changes.

### Vote Delegation

- US-VD1: Delegator delegates vote power.
- US-VD2: Delegate voting power reflects delegation.
- US-VD3: Cycle protections hold.
- US-VD4: Transfer updates delegated voting power correctly.

---

## 3) Cross-Feature Interaction Stories (Same Round)

### Claim × Claim Delegation

- US-CCX1: Delegate claims for owner, then owner attempt in same round should follow authorization rules.
- US-CCX2: Delegation switched mid-round; authorization must reflect latest state.

### Prediction × Prediction Delegation

- US-PPDX1: Delegate predicts using delegated power snapshot.
- US-PPDX2: Delegator balance change after prediction does not rewrite historical snapshot.

### Prediction × Claim

- US-PCX1: Claim before scoring maturity yields zero/expected behavior.
- US-PCX2: Claim after maturity settles expected rounds only.

### Voting × Prediction

- US-VPX1: Prediction only on currently eligible streams.
- US-VPX2: Eligibility shift after prediction does not corrupt prior-round accounting.

### Vote Delegation × Prediction Delegation

- US-VDPDX1: Same user delegates voting to X and prediction to Y; powers remain independent.
- US-VDPDX2: Switching one delegation type does not mutate other delegation type state.

### Claim Delegation × Prediction Delegation

- US-CDPDX1: Delegator delegates prediction to X and claim to Y; rewards accrue to owner, claim rights to Y.
- US-CDPDX2: Claim delegate receives only owner-authorized claim path, not unrelated users.

---

## 4) Multi-Round Stories (Temporal Interactions)

- US-MR1: Delegate predicts in round N, owner/delegator claims in N+2+, amounts consistent with split.
- US-MR2: Delegation switch between N and N+1 preserves old accrual and applies new delegate prospectively.
- US-MR3: Undelegation in round N enforces N+1 lock behavior then releases in N+2.
- US-MR4: Token transfers across rounds while delegated maintain reward-debt correctness.
- US-MR5: Claim delegation undelegation cooldown respected across boundaries.
- US-MR6: Mixed streams and partial correctness across rounds produce expected aggregate claimables.

---

## 5) High-Complexity Scenario Matrix

For each scenario below, tests should assert:

1. authorization outcomes,
2. reward accounting outcomes,
3. lock/timing outcomes,
4. state transitions for delegation mappings,
5. events and balances.

### A. Two-party matrix (A, B)

- A delegates all powers to B.
- A delegates vote only / prediction only / claim only.
- A undelegates each type in isolation.
- A switches delegate B -> C with pending rewards.

### B. Three-party split matrix (A, B, C)

- A: vote->B, prediction->C, claim->B.
- A: prediction->B, claim->C, self vote.
- B predicts, C claims for A, A attempts conflicting action.

### C. N-party pooled delegation matrix

- Many delegators to one predictor.
- Delegator joins/leaves pool between rounds.
- Delegator transfer-in/transfer-out while delegated.
- Predictor claims before/after delegators claim.

### D. Stress simulation matrix

- 10-20 users
- 2-5 streams
- 20+ rounds
- random-but-seeded action schedule
- invariant checks each round

---

## 6) Required Invariants (Every Complex Test Should Check)

- INV-1: `totalSupply` never decreases.
- INV-2: minted rewards are bounded by per-round emissions upper bound.
- INV-3: no unauthorized `claimFor` success.
- INV-4: no double-claim for same settled rewards.
- INV-5: delegation type independence (vote/prediction/claim do not leak state into each other).
- INV-6: switching delegate is prospective; historical accrual remains claimable to correct party.
- INV-7: no ghost delegation power after undelegation.

---

## 7) Test Layering Roadmap

### Layer 0 — Unit/Single-feature
- Keep deterministic tests per user story (US-C*, US-CD*, US-P*, US-PD*, US-V*, US-VD*).

### Layer 1 — Pairwise interactions
- Implement all *X* interaction stories (US-CCX*, US-PPDX*, US-VPX*, etc.) with 2-3 users.

### Layer 2 — Multi-round causal tests
- Implement US-MR* with explicit round timelines and assertions per transition.

### Layer 3 — Scenario matrix tests
- Implement matrices A/B/C with parameterized helper builders.

### Layer 4 — Seeded stress simulation
- Keep and expand scale simulation to 20+ rounds and diversified actions.

### Layer 5 — Invariant/fuzz harness
- Add property-like randomized suites (seeded reproducible runs) and invariant assertions.

---

## 8) Immediate Next Test Files to Add

1. `test/InteractionMatrix.ClaimPredictionDelegation.test.js`
2. `test/InteractionMatrix.VotePredictionIndependence.test.js`
3. `test/MultiRound.DelegationTransitions.test.js`
4. `test/MultiRound.TransferWhileDelegatedAccounting.test.js`
5. `test/Stress.SeededScenario20Users.test.js`

