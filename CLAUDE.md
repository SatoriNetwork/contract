# CLAUDE

Code and source are saved.

## What We're Creating
We're building Satori Protocol - a prediction game that mints up to 1,440 tokens per 24-hour round, with rounds closing at midnight UTC.

## How We're Creating It
Development follows TDD methodology using Hardhat for local testing (plus a Foundry suite), building the contract first, then the dapp second.

## Comments
Write a comment only when it prevents a mistake that reading the code cannot —
above all a non-obvious cross-file dependency ("check X before modifying Y")
where the coupling is invisible unless you open a distant part of the codebase.
Do not narrate what code does, restate current state, or record history as
prose: it is redundant the day it is written and a liability once the code
moves and the comment goes stale. When in doubt, write nothing — the code is
the source of truth. Prefer deleting a redundant comment to updating it.
