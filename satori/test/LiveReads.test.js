// Guard the eventual-consistency handling that deploy.js relies on IN THE SUITE.
//
// `deploy.js` verifies 37 wiring post-conditions by reading state back, then
// throws "deploy is NOT safe" on any miss. Every one of those reads is instant and
// consistent against hardhat's in-memory node — which, per LAUNCH_CHECKLIST
// section D, is the only place the deploy had ever run. On a load-balanced public
// RPC a read issued after a write can land on a node that has not applied the
// block yet, and a perfectly wired deploy fails verification.
//
// So the retry path is code that, by construction, the normal suite can never
// exercise: it only ever engages on a live network. That is exactly the shape of
// thing the G2 audit found rotting — a guard nobody runs. These tests drive the
// logic directly with probes that fail on demand, so both halves of the contract
// are pinned:
//
//   * a STALE read is rescued by re-reading, and
//   * a GENUINELY WRONG value still fails, every attempt, and stops the deploy.
//
// The second is the one that must never regress. A retry that swallows real faults
// would turn a loud, correct failure into a silent bad deploy.

const { expect } = require("chai");
const {
  runChecks,
  waitForHead,
  waitForCode,
  readPolicy,
} = require("../scripts/live-reads-lib");

// A probe that fails (or throws) its first `n` calls, then succeeds — a node that
// is behind and then catches up. `calls` records how often it was actually read.
function flaky(n, { mode = "false" } = {}) {
  const p = async () => {
    p.calls++;
    if (p.calls <= n) {
      if (mode === "throw") throw new Error(`could not decode result data`);
      return false;
    }
    return true;
  };
  p.calls = 0;
  return p;
}

describe("live-reads — verifying state on an eventually-consistent RPC", function () {
  describe("runChecks", function () {
    it("passes a check that only confirms on a later re-read (the lag case)", async () => {
      const probe = flaky(2);
      const { passedOn, failed } = await runChecks([["late", probe]], { attempts: 5 });

      expect(failed).to.have.length(0);
      expect(passedOn.get("late")).to.equal(3, "should record which attempt confirmed it");
      expect(probe.calls).to.equal(3);
    });

    it("still fails a check that is genuinely wrong, after exhausting attempts", async () => {
      const never = flaky(Infinity);
      const { passedOn, failed } = await runChecks([["broken", never]], { attempts: 4 });

      expect(failed.map(([n]) => n)).to.deep.equal(["broken"]);
      expect(passedOn.size).to.equal(0);
      expect(never.calls).to.equal(4, "every attempt should have been spent before failing");
    });

    it("treats a throwing probe as unconfirmed, not fatal, and rescues it too", async () => {
      // A node that cannot see the contract yet reverts the call rather than
      // returning a wrong value — the same lag wearing a different hat.
      const probe = flaky(1, { mode: "throw" });
      const { failed, passedOn } = await runChecks([["reverts-then-ok", probe]], { attempts: 3 });

      expect(failed).to.have.length(0);
      expect(passedOn.get("reverts-then-ok")).to.equal(2);
    });

    it("reports WHY a permanently throwing check failed", async () => {
      const { failed, lastError } = await runChecks(
        [["always-throws", flaky(Infinity, { mode: "throw" })]], { attempts: 2 });

      expect(failed).to.have.length(1);
      expect(lastError.get("always-throws")).to.match(/could not decode result data/);
    });

    it("clears a stale error when a later attempt fails cleanly instead of throwing", async () => {
      let n = 0;
      const probe = async () => {
        n++;
        if (n === 1) throw new Error("transient boom");
        return false; // now a clean, genuine failure — not the earlier error
      };
      const { failed, lastError } = await runChecks([["mixed", probe]], { attempts: 2 });

      expect(failed).to.have.length(1);
      expect(lastError.has("mixed")).to.equal(false,
        "a clean failure must not keep reporting an earlier transient error");
    });

    it("re-reads ONLY the checks that failed", async () => {
      const good = flaky(0);      // passes immediately
      const bad = flaky(2);       // needs three reads
      const { failed } = await runChecks(
        [["good", good], ["bad", bad]], { attempts: 5 });

      expect(failed).to.have.length(0);
      expect(good.calls).to.equal(1, "a passing check must not be read again");
      expect(bad.calls).to.equal(3);
    });

    it("with attempts=1 behaves exactly as the original single-pass verify", async () => {
      const probe = flaky(1); // would pass on a second read — must not get one
      const { failed } = await runChecks([["once", probe]], { attempts: 1 });

      expect(failed.map(([n]) => n)).to.deep.equal(["once"]);
      expect(probe.calls).to.equal(1);
    });

    it("reports every failing check, not just the first", async () => {
      const { failed } = await runChecks([
        ["a", flaky(Infinity)],
        ["b", flaky(0)],
        ["c", flaky(Infinity)],
      ], { attempts: 2 });

      expect(failed.map(([n]) => n)).to.deep.equal(["a", "c"]);
    });

    it("rejects a nonsensical attempts value rather than silently skipping checks", async () => {
      await expect(runChecks([["x", flaky(0)]], { attempts: 0 })).to.be.rejectedWith(/attempts/);
    });
  });

  describe("waitForHead", function () {
    it("returns once the head reaches the target block", async () => {
      let head = 100;
      const provider = { getBlockNumber: async () => head++ }; // advances as polled
      expect(await waitForHead(provider, 102, { tries: 10, delayMs: 0 })).to.equal(true);
    });

    it("gives up rather than hanging when the head never catches up", async () => {
      const provider = { getBlockNumber: async () => 1 };
      expect(await waitForHead(provider, 999, { tries: 3, delayMs: 0 })).to.equal(false);
    });
  });

  describe("waitForCode", function () {
    it("returns the byte size once code appears", async () => {
      let n = 0;
      const provider = { getCode: async () => (++n < 3 ? "0x" : "0xdeadbeef") };
      expect(await waitForCode(provider, "0xabc", { tries: 5, delayMs: 0 })).to.equal(4);
    });

    it("returns 0 — never throws — when code never appears", async () => {
      const provider = { getCode: async () => "0x" };
      expect(await waitForCode(provider, "0xabc", { tries: 3, delayMs: 0 })).to.equal(0);
    });
  });

  describe("readPolicy", function () {
    it("keeps local networks on a single attempt with no sleeps", () => {
      for (const n of ["hardhat", "localhost"]) {
        expect(readPolicy(n)).to.include({ local: true, attempts: 1, delayMs: 0 });
      }
    });

    it("gives live networks multiple spaced attempts", () => {
      for (const n of ["baseSepolia", "base"]) {
        const p = readPolicy(n);
        expect(p.local).to.equal(false);
        expect(p.attempts).to.be.greaterThan(1);
        expect(p.delayMs).to.be.greaterThan(0);
      }
    });
  });
});
