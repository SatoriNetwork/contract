const { expect } = require("chai");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { deploySplitCompatFixture } = require("./splitFixture");

// Progressive-rollout capability flags. Ids must match SatoriHub's CAP_* and the
// bit positions read by SatoriRewards.capabilityAllowed. The flag storage + admin
// setter live on SatoriRewards (it owns the `admin` role); the hub and bounties
// gate their user entry points against it.
//
// The ids are a dense 0..7. Removing a capability renumbers the ones above it —
// intended pre-launch, because the policy is one stored word and every
// deployment starts it at zero. That stops being safe only once a live bitmap
// has to survive a change.
const CAP = {
  CREATE_STREAM: 0,
  AUTHOR_GAME: 1,
  REGISTER_STREAM_ADAPTER: 2,
  REGISTER_GAME_ADAPTER: 3,
  BOUNTY: 4,
  DELEGATE_PREDICTION: 5,
  DELEGATE_CLAIM: 6,
  VOTE: 7,
};
const LIVE = Object.values(CAP);           // every bit gates something
const ALL_ON = 0xff;  // bits 0..7 — what the fixture sets
const LAST = 7; // highest capability bit

const fix = () => deploySplitCompatFixture(2000);

describe("Capability flags (progressive rollout)", () => {
  // Every gated entry point + the contract whose CapabilityDisabled error fires.
  // Args are dummies on purpose: the capability gate is the FIRST statement in
  // each function, so it reverts before any other validation runs.
  function gatedCalls(f, caller) {
    const hub = f.hub.connect(caller);
    const bounties = f.bounties.connect(caller);
    const addr = f.owner.address; // any nonzero address
    const tok = f.token.target;
    return {
      [CAP.CREATE_STREAM]: { c: f.hub, call: () => hub.createSimpleDataStream("x", addr) },
      [CAP.AUTHOR_GAME]: { c: f.hub, call: () => hub.createGame(1, 0, "0x", "x") },
      [CAP.REGISTER_STREAM_ADAPTER]: { c: f.hub, call: () => hub.registerCommunityAdapter(addr, "x") },
      [CAP.REGISTER_GAME_ADAPTER]: { c: f.hub, call: () => hub.registerCommunityGameAdapter(addr, "x") },
      [CAP.BOUNTY]: { c: f.bounties, call: () => bounties.fundBounty(1, tok, 1, 1) },
      [CAP.DELEGATE_PREDICTION]: { c: f.hub, call: () => hub.delegatePredictionPower(addr) },
      [CAP.DELEGATE_CLAIM]: { c: f.hub, call: () => hub.delegateClaimAbility(addr) },
      [CAP.VOTE]: { c: f.hub, call: () => hub.vote(2, 1n) },
    };
  }

  it("setCapabilities is admin-only", async () => {
    const f = await loadFixture(fix);
    const stranger = f.signers[6];
    await expect(f.rewards.connect(stranger).setCapabilities(ALL_ON))
      .to.be.revertedWithCustomError(f.rewards, "Unauthorized");
    await expect(f.rewards.connect(f.owner).setCapabilities(ALL_ON)).to.not.be.reverted;
  });

  it("the fixture leaves every capability enabled (full-featured test env)", async () => {
    const f = await loadFixture(fix);
    const stranger = f.signers[6];
    for (const c of LIVE) {
      expect(await f.rewards.capabilityAllowed(c, stranger.address), `cap ${c}`).to.equal(true);
    }
  });

  it("unset bits read as disabled (default OFF), but the admin is always allowed", async () => {
    const f = await loadFixture(fix);
    const stranger = f.signers[6];
    // Cap 8 — nothing above voting exists — is never set -> disabled.
    expect(await f.rewards.capabilityAllowed(LAST + 1, stranger.address)).to.equal(false);
    // Clear the whole policy: every flag then reads disabled for a non-admin...
    await f.rewards.connect(f.owner).setCapabilities(0);
    for (const c of LIVE) {
      expect(await f.rewards.capabilityAllowed(c, stranger.address), `cap ${c} public`).to.equal(false);
      // ...yet the admin bypasses every flag.
      expect(await f.rewards.capabilityAllowed(c, f.owner.address), `cap ${c} admin`).to.equal(true);
    }
  });

  it("with a capability OFF, a non-admin call reverts CapabilityDisabled (all 8 live caps)", async () => {
    const f = await loadFixture(fix);
    const stranger = f.signers[6];
    await f.rewards.connect(f.owner).setCapabilities(0); // all off
    const calls = gatedCalls(f, stranger);
    for (const c of LIVE) {
      await expect(calls[c].call(), `cap ${c} must be gated`)
        .to.be.revertedWithCustomError(calls[c].c, "CapabilityDisabled");
    }
  });

  it("the removed features have no entry point left on the hub", async () => {
    // Vote bounties and vote delegation were removed with burn voting. Their
    // capability ids were reclaimed rather than burned, so what pins the
    // numbering is this: the functions must be gone from the ABI entirely.
    const f = await loadFixture(fix);
    const names = f.hub.interface.fragments.filter((fr) => fr.type === "function").map((fr) => fr.name);
    expect(names).to.not.include("createVoteBounty");
    expect(names).to.not.include("acceptVoteBounty");
    expect(names).to.not.include("cancelVoteBounty");
    expect(names).to.not.include("setVoteDelegation");
    expect(names).to.not.include("clearVote");
    // Dense ids, no holes. Off-chain game adapters held 7 until 2026-08-20;
    // removing them COMPACTED the list, moving voting 8 -> 7.
    expect(LIVE.slice().sort((a, b) => a - b)).to.deep.equal([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  it("stakeBountyToken is gated by CAP_BOUNTY as well", async () => {
    const f = await loadFixture(fix);
    const stranger = f.signers[6];
    await f.rewards.connect(f.owner).setCapabilities(0);
    await expect(f.bounties.connect(stranger).stakeBountyToken(f.token.target, 1))
      .to.be.revertedWithCustomError(f.bounties, "CapabilityDisabled");
  });

  it("the admin bypasses the flag even when the capability is OFF", async () => {
    const f = await loadFixture(fix);
    await f.rewards.connect(f.owner).setCapabilities(0); // all off
    // delegateClaimAbility needs no fee/balance; the admin (owner) passes the gate.
    await expect(f.hub.connect(f.owner).delegateClaimAbility(f.signers[7].address))
      .to.not.be.reverted;
  });

  it("enabling one capability opens exactly that one to the public", async () => {
    const f = await loadFixture(fix);
    const stranger = f.signers[6];
    await f.rewards.connect(f.owner).setCapabilities(0); // all off

    // Off -> the public is blocked.
    await expect(f.hub.connect(stranger).delegateClaimAbility(f.owner.address))
      .to.be.revertedWithCustomError(f.hub, "CapabilityDisabled");

    // Enable ONLY CAP_DELEGATE_CLAIM -> the public may now use it...
    await f.rewards.connect(f.owner).setCapabilities(1 << CAP.DELEGATE_CLAIM);
    await expect(f.hub.connect(stranger).delegateClaimAbility(f.owner.address)).to.not.be.reverted;

    // ...but a sibling capability stays closed.
    await expect(f.hub.connect(stranger).delegatePredictionPower(f.owner.address))
      .to.be.revertedWithCustomError(f.hub, "CapabilityDisabled");
  });
});

// ---------------------------------------------------------------------------
// The capability numbering is a DOCUMENTED interface, and the docs drifted.
//
// On 2026-08-20 LAUNCH_CHECKLIST H1 still listed `VOTE_BOUNTY(4)` and
// `DELEGATE_VOTE(8)` — features the burn-voting migration deleted — and the ids
// after them were shifted by one, because the survivors were COMPACTED rather
// than left with holes. Anyone assembling a bitmap from that list would have
// opened a DIFFERENT capability than the one they named — silently, with no
// error, because every bit is a valid bit. That is the whole risk and it is
// enough: an operator reaching for claim delegation gets something else.
// (An earlier version of this comment inflated that into a specific catastrophe.
// It was wrong on the specifics and the plain version above is the real point.)
//
// The tests above were right the whole time. Nothing connected them to the
// prose, so nothing failed. This does.
describe("Capability numbering matches the canonical docs", () => {
  const fs = require("fs");
  const path = require("path");
  const docs = path.join(__dirname, "..", "..", "..", "docs");

  it("docs/design/capability-rollout.md's table matches the CAP ids in this file", () => {
    const md = fs.readFileSync(path.join(docs, "design", "capability-rollout.md"), "utf8");
    // Rows look like: | 4 | Bounties | `SatoriBounties.fundBounty`, ... |
    const rows = [...md.matchAll(/^\|\s*(\d+)\s*\|\s*([^|]+?)\s*\|/gm)]
      .map((m) => [Number(m[1]), m[2]]);
    const documented = [...new Set(rows.filter(([b]) => b <= LAST).map(([b]) => b))];
    expect(documented.sort((a, b) => a - b))
      .to.deep.equal(LIVE.slice().sort((a, b) => a - b),
        "capability-rollout.md documents a different set of bits than the tests pin");
  });

  it("no canonical doc still names a capability that was deleted", () => {
    const offenders = [];
    for (const dir of ["design", "questions", "narratives"]) {
      const d = path.join(docs, dir);
      if (!fs.existsSync(d)) continue;
      for (const f of fs.readdirSync(d).filter((x) => x.endsWith(".md"))) {
        const text = fs.readFileSync(path.join(d, f), "utf8");
        text.split("\n").forEach((line, i) => {
          // A mention is fine when it is explaining the REMOVAL; flag only lines
          // that read as a live capability id.
          if (/CAP_VOTE_BOUNTY|CAP_DELEGATE_VOTE/.test(line) &&
              !/remove|delete|reclaim|corrected|burn|no longer|used to/i.test(line)) {
            offenders.push(`${dir}/${f}:${i + 1}`);
          }
        });
      }
    }
    expect(offenders, `deleted capabilities named as live in: ${offenders.join(", ")}`).to.deep.equal([]);
  });

  it("'all on' is 0xff — eight capabilities at bits 0..7, densely numbered", () => {
    expect(ALL_ON).to.equal((1 << (LAST + 1)) - 1);
    expect(LIVE.length).to.equal(LAST + 1);
  });
});
