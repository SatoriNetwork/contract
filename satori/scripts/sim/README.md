# Satori Simulation Suite — archived

The runnable simulation scripts that used to live in this directory
(`*-sim.js`, `*-test.js`, `harness.js`, `battery.sh`, etc.) have been
deleted. They were written against pre-games-refactor contracts and
referenced surfaces that no longer exist: `BountyVault`,
`setMaxEligibleStreams`, `setPlatformFeePercent` from `owner`, the
caller-picked `registerAdapter(uint16 id, ...)` shape, Ownable2Step,
etc. Rather than rewrite all forty, they were removed.

## Live coverage today

- **Unit tests** — `satori/test/`, run with `npx hardhat test`. ~1170
  tests, ~2 min full run.
- **Foundry invariants** — `satori/test/foundry/`, run with `forge test`.
  Exercises the same state machine via random call sequences.
- **Echidna invariants** — `satori/test/echidna/`. Property-based fuzzing.

## Markdown notes

The `*.md` files in this directory are kept as a record of the
efficiency-audit / option-B design work. They reference scenarios that
the deleted sims used to drive; treat the prose as historical context,
not as a guide to anything currently runnable.
