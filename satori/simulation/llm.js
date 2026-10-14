// The adversary's safety boundary + plan loader. This file is the bridge between a
// red-team SUB-AGENT (a Claude Code agent that READ the immutable contract out-of-band
// and authored an attack PLAN) and the legal action space the harness can execute. There
// is NO external API here: the sub-agent does its thinking elsewhere and hands us a plan
// JSON; the harness replays it. It NEVER lets a malformed plan crash the run or escape the
// action set: parseActions is tolerant of prose/markdown, validatePlan drops anything
// illegal, and both return safe defaults on garbage. The same oracle then judges whatever
// the plan does.

// ---- Action schema (derived from actions.js execute()) --------------------------------
// Each entry: required field names per action type. Bounty/token actions require a token
// in the agent's view; validatePlan drops them otherwise.
const ACTION_SCHEMA = {
  predict:               { fields: ["gameId", "dir"], needsToken: false },
  predictMany:           { fields: ["entries"],       needsToken: false }, // entries: [{gameId, dir}]
  vote:                  { fields: ["gameId"],        needsToken: false },
  claim:                 { fields: [],                needsToken: false },
  settle:                { fields: ["user", "gameId"],needsToken: false },
  transfer:              { fields: ["to", "amount"],  needsToken: false },
  fundBounty:            { fields: ["gameId", "tokenAddr", "amount", "rate"], needsToken: true },
  stakeBounty:           { fields: ["tokenAddr", "amount"],   needsToken: true },
  unstakeBounty:         { fields: ["tokenAddr", "amount"],   needsToken: true },
  withdrawBounty:        { fields: ["tokenAddrs"],            needsToken: true }, // tokenAddrs: [addr]
  deployEvilGameAdapter: { fields: ["kind"],          needsToken: false }, // kind: 'everyoneWins'|'reentrant'
  createAdapterGame:     { fields: ["streamId", "adapterTypeId"], needsToken: false },
  noop:                  { fields: [],                needsToken: false },
};

const MAX_PLAN = 6;            // cap on actions per turn (a malformed plan can't spam)

// ---- loadPlan: read a sub-agent-authored attack plan from disk ------------------------
// Shape: { seed?, rounds?, wallets?:int (default 3), steps:[ {round:int, wallet:int,
// actions:[...] } ] }. `round` is RELATIVE (0-based, from the wallet's first seen round);
// `wallet` is the adversary wallet index (0..wallets-1). Never throws: a missing/garbage
// file yields a safe empty plan so the harness degrades to "adversary does nothing".
function loadPlan(planPath) {
  const fs = require("fs");
  const safe = { wallets: 1, steps: [] };
  try {
    const raw = fs.readFileSync(planPath, "utf8");
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== "object") return safe;
    const wallets = isNum(obj.wallets) && Number(obj.wallets) > 0 ? Math.floor(Number(obj.wallets)) : 3;
    const steps = Array.isArray(obj.steps) ? obj.steps.filter(
      (s) => s && typeof s === "object" && isNum(s.round) && isNum(s.wallet) && Array.isArray(s.actions)
    ).map((s) => ({ round: Math.floor(Number(s.round)), wallet: Math.floor(Number(s.wallet)), actions: s.actions }))
      : [];
    const plan = { wallets, steps };
    if (isNum(obj.seed)) plan.seed = Math.floor(Number(obj.seed));
    if (isNum(obj.rounds)) plan.rounds = Math.floor(Number(obj.rounds));
    return plan;
  } catch (e) {
    return safe;
  }
}

// ---- resolveRefs: deep-replace "$name.field" / "$name" with shared[name].field --------
// A plan can deploy in one step (capture:"evil") and reference "$evil.typeId" in a later
// createAdapterGame step. This walks the action object/array and substitutes any string of
// the form "$name" or "$name.field" with the captured scratchpad value. Unresolved refs
// (capture not run yet / bad name) pass through unchanged so validatePlan drops the action.
// Never throws — returns a best-effort resolved deep copy.
function resolveRefs(action, shared) {
  const sh = shared || {};
  const sub = (v) => {
    if (typeof v === "string" && v.length > 1 && v[0] === "$") {
      const m = v.slice(1).match(/^([A-Za-z0-9_]+)(?:\.([A-Za-z0-9_]+))?$/);
      if (m) {
        const obj = sh[m[1]];
        if (obj === undefined) return v;                 // not captured yet: leave as-is
        if (m[2] == null) return obj;                    // "$name"
        return obj && typeof obj === "object" && m[2] in obj ? obj[m[2]] : v; // "$name.field"
      }
      return v;
    }
    if (Array.isArray(v)) return v.map(sub);
    if (v && typeof v === "object") {
      const out = {};
      for (const k of Object.keys(v)) out[k] = sub(v[k]);
      return out;
    }
    return v;
  };
  try { return sub(action); } catch (e) { return action; }
}

// ---- parseActions: first JSON array in the text (tolerant of prose / ``` fences) ------
function parseActions(text) {
  if (typeof text !== "string") return [];
  // Strip code fences so a fenced array parses cleanly.
  const unfenced = text.replace(/```(?:json)?/gi, "");
  // Scan for the first balanced top-level [...] and try to parse it.
  const start = unfenced.indexOf("[");
  if (start === -1) return [];
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < unfenced.length; i++) {
    const c = unfenced[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "[") depth++;
    else if (c === "]") {
      depth--;
      if (depth === 0) {
        const slice = unfenced.slice(start, i + 1);
        try {
          const arr = JSON.parse(slice);
          return Array.isArray(arr) ? arr : [];
        } catch (e) {
          return [];
        }
      }
    }
  }
  return [];
}

// ---- validatePlan: the SAFETY BOUNDARY. Sanitize a raw model plan into a legal action --
// array. Drops unknown types / missing fields, coerces dir to 1|2, drops bounty/token
// actions when the view has no token, and caps length. Never throws — returns [] on
// garbage. Nothing a model invents can crash the run or escape the legal action space.
function validatePlan(rawArray, view) {
  if (!Array.isArray(rawArray)) return [];
  const hasToken = !!(view && view.token && view.token.addr);
  const out = [];
  for (const a of rawArray) {
    if (out.length >= MAX_PLAN) break;
    if (!a || typeof a !== "object") continue;
    const spec = ACTION_SCHEMA[a.type];
    if (!spec) continue;                          // unknown type
    if (spec.needsToken && !hasToken) continue;   // no token -> bounty/token action illegal

    if (a.type === "predict") {
      if (!isNum(a.gameId)) continue;
      out.push({ type: "predict", gameId: Number(a.gameId), dir: coerceDir(a.dir) });
    } else if (a.type === "predictMany") {
      if (!Array.isArray(a.entries)) continue;
      const entries = a.entries
        .filter((e) => e && isNum(e.gameId))
        .map((e) => ({ gameId: Number(e.gameId), dir: coerceDir(e.dir) }))
        .slice(0, MAX_PLAN);
      if (!entries.length) continue;
      out.push({ type: "predictMany", entries });
    } else if (a.type === "vote") {
      if (!isNum(a.gameId)) continue;
      out.push({ type: "vote", gameId: Number(a.gameId) });
    } else if (a.type === "claim") {
      out.push({ type: "claim" });
    } else if (a.type === "settle") {
      if (typeof a.user !== "string" || !isNum(a.gameId)) continue;
      out.push({ type: "settle", user: a.user, gameId: Number(a.gameId) });
    } else if (a.type === "transfer") {
      if (typeof a.to !== "string" || a.amount == null) continue;
      out.push({ type: "transfer", to: a.to, amount: toBig(a.amount) });
    } else if (a.type === "fundBounty") {
      if (!isNum(a.gameId)) continue;
      out.push({ type: "fundBounty", gameId: Number(a.gameId),
        tokenAddr: view.token.addr, amount: toBig(a.amount), rate: toBig(a.rate) });
    } else if (a.type === "stakeBounty") {
      out.push({ type: "stakeBounty", tokenAddr: view.token.addr, amount: toBig(a.amount) });
    } else if (a.type === "unstakeBounty") {
      out.push({ type: "unstakeBounty", tokenAddr: view.token.addr, amount: toBig(a.amount) });
    } else if (a.type === "withdrawBounty") {
      out.push({ type: "withdrawBounty", tokenAddrs: [view.token.addr] });
    } else if (a.type === "deployEvilGameAdapter") {
      const kind = a.kind === "reentrant" ? "reentrant" : "everyoneWins";
      out.push({ type: "deployEvilGameAdapter", kind, name: str(a.name) || "evil",
        capture: str(a.capture) || undefined });
    } else if (a.type === "createAdapterGame") {
      if (!isNum(a.streamId) || !isNum(a.adapterTypeId)) continue;
      out.push({ type: "createAdapterGame", streamId: Number(a.streamId),
        adapterTypeId: Number(a.adapterTypeId), config: str(a.config) || "0x",
        name: str(a.name) || "g", capture: str(a.capture) || undefined });
    } else if (a.type === "noop") {
      out.push({ type: "noop" });
    }
  }
  return out;
}

function isNum(x) { return x != null && Number.isFinite(Number(x)); }
function str(x) { return typeof x === "string" ? x : null; }
function coerceDir(d) { return Number(d) === 2 ? 2 : 1; } // 1 (up) | 2 (down); default up
function toBig(x) {
  try {
    if (typeof x === "bigint") return x;
    if (typeof x === "number") return BigInt(Math.trunc(x));
    if (typeof x === "string" && /^\d+$/.test(x.trim())) return BigInt(x.trim());
  } catch (e) { /* fall through */ }
  return 0n; // a 0-amount action is harmless (likely reverts; treated as data)
}

// ---- buildAdversaryBrief: the plain-text brief a red-team SUB-AGENT receives -----------
// This is NOT a model API call. It is the briefing document handed to a Claude Code
// sub-agent (out-of-band) that will READ the immutable contract and AUTHOR a plan JSON.
// It explains: the rules of engagement, the legal action space, the plan format (incl.
// capture/$ref), the world layout, and the named invariants to try to break. The
// sub-agent's deliverable is a plan file replayed via SIM_LLM_PLAN.
function buildAdversaryBrief({ source, schema, worldInfo, goal } = {}) {
  const sch = schema || ACTION_SCHEMA;
  return [
    "=== RED-TEAM BRIEF: Satori Protocol adversarial simulation ===",
    "",
    "You are a red-team SUB-AGENT. You may READ the immutable contract source (you CANNOT",
    "change it). Your only lever on the deployed system is to author an attack PLAN (JSON)",
    "that the harness replays: it seats one adversary wallet per `wallets`, and each round",
    "feeds your scheduled actions through validatePlan (the safety boundary) and executes",
    "the survivors. The SAME invariant oracle judges the result as for every honest player.",
    "",
    "GOAL: " + (goal || "extract more than your fair share and break a named invariant."),
    "",
    "Named invariants to try to break (a real break = a found bug):",
    "  - mint conservation: totalSupply == totalRewardsMinted; per-(game,round) credit <= one round budget (720e18).",
    "  - bounty-token solvency: held + paidOut + fees == fundedIn per token.",
    "  - strand: a believed-pending settle must not revert NoPendingPrediction.",
    "  - auth: owner() stays address(0); fee bps is reduce-only.",
    "  - economic: out-earn every honest player (value redistribution the hard cap can't see).",
    "",
    "Legal action schema (objects with EXACTLY these shapes; anything else is dropped):",
    schemaText(sch),
    "  dir is 1 (up) or 2 (down). Bounty/token actions are only legal when your wallet holds a token.",
    "  deployEvilGameAdapter/createAdapterGame accept an optional `capture:\"name\"` that stores",
    "  the tx result ({typeId,...} / {gameId}) into a shared scratchpad.",
    "",
    "PLAN FORMAT (JSON file, passed as SIM_LLM_PLAN):",
    '  {',
    '    "seed": 3,            // optional; env SIM_SEED overrides',
    '    "rounds": 12,         // optional; env SIM_ROUNDS overrides',
    '    "wallets": 3,         // number of adversary wallets to seat (default 3)',
    '    "steps": [',
    '      { "round": 0, "wallet": 0, "actions": [ {"type":"deployEvilGameAdapter","kind":"everyoneWins","capture":"evil"} ] },',
    '      { "round": 1, "wallet": 0, "actions": [ {"type":"createAdapterGame","streamId":2,"adapterTypeId":"$evil.typeId","capture":"evilgame"} ] },',
    '      { "round": 2, "wallet": 0, "actions": [ {"type":"vote","gameId":"$evilgame.gameId"} ] },',
    '      { "round": 3, "wallet": 1, "actions": [ {"type":"predict","gameId":"$evilgame.gameId","dir":1} ] }',
    '    ]',
    '  }',
    "  - `round` is RELATIVE (0-based) from the wallet's first turn; `wallet` is 0..wallets-1.",
    "  - A string of the form \"$name\" or \"$name.field\" is replaced at run time with the",
    "    scratchpad value captured by an earlier `capture:\"name\"` action (cross-step refs).",
    "  - At most " + MAX_PLAN + " actions survive per wallet per turn.",
    "",
    worldInfo ? "=== WORLD LAYOUT ===\n" + worldInfo + "\n" : "",
    source ? "=== CONTRACT SOURCE DIGEST ===\n" + source : "(read the contract source under satori/contracts/ to author your attack)",
  ].join("\n");
}

function schemaText(schema) {
  return Object.entries(schema || ACTION_SCHEMA)
    .map(([type, spec]) => `  {"type":"${type}"${spec.fields.length ? ", " +
      spec.fields.map((f) => `"${f}":...`).join(", ") : ""}}` +
      (spec.needsToken ? "  (needs token)" : ""))
    .join("\n");
}

module.exports = {
  ACTION_SCHEMA,
  parseActions,
  validatePlan,
  loadPlan,
  resolveRefs,
  buildAdversaryBrief,
  MAX_PLAN,
};
