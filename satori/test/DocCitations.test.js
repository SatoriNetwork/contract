// Canonical docs must not cite CODE LINE NUMBERS.
//
// WHY THIS TEST EXISTS
// On 2026-08-19 the Q&A rubric and narratives carried 165 `File.sol:NNN`
// citations. A semantic check — does the cited line actually contain the symbol
// it is cited for? — found **50 of the 51 checkable ones were wrong**. Not
// missing: wrong. They pointed at real lines of real files, several hundred
// lines away from the thing they claimed to reference.
//
// That is worse than having no citation at all. A precise-looking reference gets
// trusted, so a reader either follows it and is misled, or checks it and loses
// faith in the whole document. Both outcomes cost more than the precision bought.
//
// The decay is structural rather than careless: every contract edit shifts every
// line below it, in every file, silently. Nothing fails. `File.sol` plus a
// backticked symbol survives edits; `File.sol:NNN` cannot.
//
// So the rule is: name the file and the symbol, never the line. This test is what
// stops the 166th citation from being added six weeks from now.
//
// SCOPE. `docs/issues/` is exempt on purpose: an issue is a record of what was
// true on the day it was written, and a line number there is evidence rather
// than navigation. Everything else that a reader NAVIGATES by is in scope.
//
// EXTENDED 2026-08-20. The original scope was the two canonical doc sets only,
// which turned out to be where the rot had been *cleaned*, not where it lived.
// A sweep found 79 more citations outside it — in design docs, the launch
// checklist, the dapp, the deploy scripts and the tests — and **46 of them cited
// `Satori.sol`, a file that has not existed since the token/engine/hub split**.
// Source comments decay exactly like prose does, so they are guarded the same way.
const { expect } = require("chai");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..", "..");
// Doc dirs (markdown) + source trees (comments). Single files allowed too.
const CANONICAL = ["docs/questions", "docs/narratives", "docs/design",
                   "docs/LAUNCH_CHECKLIST.md", "docs/PATH_TO_LIVE.md",
                   "satori/contracts", "satori/scripts", "satori/test",
                   "satori-ui/src"];
const CITATION = /\b[A-Za-z][A-Za-z0-9_]*\.sol:\d+/g;
const EXTS = [".md", ".sol", ".js", ".ts", ".tsx"];
const SKIP = new Set(["node_modules", "artifacts", "cache", "build", "out", "typechain-types"]);

function mdFiles(dir) {
  const abs = path.join(ROOT, dir);
  if (!fs.existsSync(abs)) return [];
  if (fs.statSync(abs).isFile()) return [{ rel: dir, abs }];
  const out = [];
  (function walk(d, rel) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (SKIP.has(e.name)) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p, `${rel}/${e.name}`);
      else if (EXTS.some((x) => e.name.endsWith(x))) out.push({ rel: `${rel}/${e.name}`, abs: p });
    }
  })(abs, dir);
  return out;
}

describe("Docs and source: no code line-number citations", function () {
  it("cites files and symbols, never line numbers", function () {
    // This test file necessarily contains the pattern in its own prose.
    const SELF = "test/DocCitations.test.js";
    const offenders = [];
    for (const dir of CANONICAL) {
      for (const { rel, abs } of mdFiles(dir)) {
        if (rel.endsWith(SELF)) continue;
        const text = fs.readFileSync(abs, "utf8");
        text.split("\n").forEach((line, i) => {
          const hits = line.match(CITATION);
          if (hits) offenders.push(`${rel}:${i + 1}  ${hits.join(", ")}`);
        });
      }
    }
    expect(offenders,
      `Line-number citations found in the canonical docs. They decay silently on ` +
      `every contract edit — 50 of 51 checked were wrong on 2026-08-19. Cite the ` +
      `file and the symbol instead:\n  ` + offenders.join("\n  ") + "\n"
    ).to.deep.equal([]);
  });

  it("actually scans a non-trivial number of files (guards against a silent no-op)", function () {
    // A test that scans nothing passes forever. If the docs move, this fails
    // loudly instead of quietly protecting an empty set.
    // ~629 files in scope as of the 2026-08-20 extension. A threshold well above
    // the old doc-only count (~25) is what catches a source tree silently
    // dropping out of scope — the failure mode this test exists to prevent.
    const count = CANONICAL.reduce((n, d) => n + mdFiles(d).length, 0);
    expect(count).to.be.greaterThan(400);
  });
});
