// Theft scorer for the adversary harness (retuned 2026-09-08).
//
// The protocol NEVER promised capital-proportional emissions — a lone honest
// participant who takes a quiet round's pot stole nothing (they burned to
// vote, bore risk, and were right). So "beat your capital share" is the WRONG
// bar; it flags honest lull-capture as a false positive.
//
// Real theft is getting value the rules do not award. Three fingerprints:
//   1. CAP/CONSERVATION — mint beyond the on-chain ceilings. The protocol
//      cannot over-emit (rewardMint reverts BudgetExceeded), so this firing
//      would be a genuine break.
//   2. CLAIRVOYANCE — a sustained abnormal win-rate. An honest predictor on a
//      MOVING market cannot keep winning ~all the time; self-oracle,
//      horizon-compression and void-gaming all surface as "sees the answer".
//   3. FREE LUNCH — net token extraction with no genuine correct participation
//      (paid without earning).
// Capital share is reported as CONTEXT only, never as a trigger.
const { ethers } = require("hardhat");

const CLAIRVOYANT_MIN_SCORED = 8;    // enough calls that ~100% isn't luck
const CLAIRVOYANT_WINRATE = 0.90;    // honest play on a moving market can't hold this

class Scorer {
  constructor(ctx) { this.ctx = ctx; this.engine = ctx.engine; }

  async _extraction(addr) {
    const { token, rewards } = this.ctx;
    return (await token.balanceOf(addr)) + (await rewards.unclaimedRewards(addr));
  }

  async start(attacker) {
    const { token, satori } = this.ctx;
    this.attacker = attacker;
    this.startExtraction = await this._extraction(attacker);
    this.startSupply = await token.totalSupply();
    this.startRewardCeiling = await token.rewardCeiling();
    this.startGeneralCap = await this._generalCap();
    this.startDevCeiling = await token.devFeeCeiling();
    this.startBlock = await ethers.provider.getBlockNumber();
    this.capitalShare1e18 = (this.startExtraction * 10n ** 18n) / this.startSupply;
  }

  /// The general lanes' shared cap: 85% of the HUB's emission ceiling, the same
  /// figure SatoriHub.rewardMint enforces.
  ///
  /// This replaces `rewardCeiling() - devFeeCeiling()` as the measure of "what
  /// could have been emitted in the window". That expression was the token's
  /// `1440 x rounds` envelope less the fee's realized accrual, and both halves
  /// went wrong at once: the envelope is no longer the emission rate (the hub's
  /// schedule sits well inside it and decays), and the fee's accrual now tracks
  /// what was MINTED rather than the clock. The two errors compound in the same
  /// direction — a fair share computed from the envelope is far too generous,
  /// which is exactly the direction that makes the clairvoyance detector go
  /// quiet on a real attack.
  async _generalCap() {
    const { token, satori } = this.ctx;
    // ASK THE TOKEN. It owns the carve-out arithmetic — which is segmented now
    // that the fee rate can move (humble.md 1b), so a copy here would be both
    // wrong and silently wrong. Supply the HUB's ceiling, the same way the hub
    // and the Lens do.
    return token.generalCeilingFor(await satori.emissionCeiling());
  }

  async _attackerScored() {
    const eng = this.engine;
    const scored = await eng.queryFilter(eng.filters.PredictionScored(this.attacker), this.startBlock);
    let correct = 0;
    for (const e of scored) if (e.args.correct) correct++;
    const voided = await eng.queryFilter(eng.filters.PredictionVoided(this.attacker), this.startBlock);
    return { scored: scored.length, correct, voided: voided.length };
  }

  async snapshot() {
    const { token } = this.ctx;
    const extraction = await this._extraction(this.attacker);
    const rewardCeiling = await token.rewardCeiling();
    const devCeiling = await token.devFeeCeiling();
    const generalCap = await this._generalCap();
    // What the GENERAL lanes could have emitted over the window.
    const emittedInWindow = generalCap - this.startGeneralCap;
    const gain = extraction - this.startExtraction;
    const { scored, correct, voided } = await this._attackerScored();
    const winRate = scored > 0 ? correct / scored : null;

    const tripwires = [];
    const minted = await token.totalRewardsMinted();
    if (minted > rewardCeiling) tripwires.push(`totalRewardsMinted ${minted} > rewardCeiling ${rewardCeiling}`);
    // ONE WEI OF SLACK. The genesis split floors the GENERAL share onto the
    // hub's cap and gives the dev the remainder, while devFeeCeiling floors the
    // fee's own 3/17 — two roundings that need not agree, so the fee sits a wei
    // ahead of its ceiling on a fresh deployment. That is why mintDevFee
    // saturates; asserting strict `<=` here flags every honest run as a break.
    const devMinted = await token.devFeeMinted();
    if (devMinted > devCeiling + 1n) tripwires.push(`devFeeMinted ${devMinted} > devFeeCeiling ${devCeiling} + 1`);
    // The lane cap the hub actually enforces. The token's rewardCeiling above is
    // the outer envelope and would not fire until the hub's schedule had already
    // been breached many times over.
    const general = minted - devMinted;
    if (general > generalCap) tripwires.push(`generalMinted ${general} > generalCap ${generalCap}`);

    // Fair share of the window's emission for this capital (context for the
    // profit test below).
    const fairShare = (emittedInWindow * this.capitalShare1e18) / 10n ** 18n;
    const controls = scored >= CLAIRVOYANT_MIN_SCORED && winRate >= CLAIRVOYANT_WINRATE && gain > 0n;
    // Real theft = controlling the outcome AND profiting beyond fair share.
    // Controlling a capped outcome that under-earns honest play is harmless.
    const clairvoyant = controls && gain > fairShare;
    const freeLunch = gain > 0n && correct === 0;
    const isFinding = tripwires.length > 0 || clairvoyant || freeLunch;

    return {
      isFinding,
      why: tripwires.length ? "cap/conservation" : clairvoyant ? "clairvoyance" : freeLunch ? "free-lunch" : "none",
      attackerGainWei: gain.toString(),
      predictionsScored: scored,
      predictionsCorrect: correct,
      predictionsVoided: voided,
      winRate: winRate == null ? null : Math.round(winRate * 1000) / 1000,
      controlsOutcome: controls,   // could rig the sign
      clairvoyant, freeLunch, tripwires,   // clairvoyant = rigs AND profits
      fairShareWei: fairShare.toString(),
      // context, not triggers:
      emittedInWindowWei: emittedInWindow.toString(),
      capitalSharePct: Number(this.capitalShare1e18 / 10n ** 14n) / 100,
      extractionVsCapitalPct: emittedInWindow > 0n
        ? Number((gain * 10000n) / ((emittedInWindow * this.capitalShare1e18) / 10n ** 18n)) / 100
        : null,
    };
  }
}

module.exports = { Scorer };
