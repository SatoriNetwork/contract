// The cast: participants who differ in stake, skill, timing, frequency, which games
// they play, how they claim, whether they delegate, refer, vote, trade or settle.
// Each is data plus small functions; the runner turns their choices into transactions.
//
// Directions: "skill p" peeks at the real outcome and is right with probability p
// (a flat outcome or a Sentiment game falls back to a coin flip); the others use only
// public information.

const ALL = ["ALPHA", "BETA", "GAMMA"];
const daily = (h) => () => h;
const randomHour = (day, rng) => rng.int(24);

function cast() {
  const A = [];
  const add = (o) => A.push({ claim: "end", settle: "none", games: ALL, dir: { kind: "skill", p: 0.6 }, ...o });

  // --- skill and size ---
  add({ name: "Whale-Sage", persona: "whale, skilled 70%, 09:00 daily, all games + satori, weekly claim, referred by Whale-Gambler",
    stake: 90, when: daily(9), games: [...ALL, "satori"], dir: { kind: "skill", p: 0.7 }, claim: "weekly", referral: "Whale-Gambler" });
  add({ name: "Whale-Gambler", persona: "whale, coin flips, random hour daily, every game incl. the unpaid one, claims at the end",
    stake: 75, when: randomHour, games: [...ALL, "satori", "COLD"], dir: { kind: "random" } });
  add({ name: "Mid-Early", persona: "skilled 60%, 00:00 daily, ALPHA+BETA, daily claim, referred by Promoter",
    stake: 30, when: daily(0), games: ["ALPHA", "BETA"], claim: "daily", referral: "Promoter" });
  add({ name: "Mid-Late", persona: "skilled 60%, 23:00 daily, ALPHA+GAMMA, weekly claim, referred by Promoter",
    stake: 30, when: daily(23), games: ["ALPHA", "GAMMA"], claim: "weekly", referral: "Promoter" });
  add({ name: "Midnight-Hopper", persona: "skilled 58%, alternates 23:00 and 00:00 so calls land an hour apart across midnight (the M22 pattern)",
    stake: 22, when: (day) => (day % 2 === 0 ? 23 : 0), games: ["ALPHA", "satori"], dir: { kind: "skill", p: 0.58 } });
  add({ name: "Drifter", persona: "skilled 55%, an hour later every day, BETA",
    stake: 22, when: (day) => day % 24, games: ["BETA"], dir: { kind: "skill", p: 0.55 } });
  add({ name: "Momentum", persona: "follows each stream's last move, 12:00 daily",
    stake: 26, when: daily(12), dir: { kind: "momentum" }, claim: "weekly" });
  add({ name: "Contrarian", persona: "bets against each stream's last move, 15:00 daily",
    stake: 26, when: daily(15), dir: { kind: "contrarian" }, claim: "weekly" });
  add({ name: "Perma-Bull", persona: "always UP, 06:00 daily, three markets + satori",
    stake: 19, when: daily(6), games: [...ALL, "satori"], dir: { kind: "up" } });
  add({ name: "Perma-Bear", persona: "always DOWN, 18:00 daily, three markets + satori",
    stake: 19, when: daily(18), games: [...ALL, "satori"], dir: { kind: "down" } });
  add({ name: "Bad-Calls", persona: "wrong 70% of the time, 10:00 daily",
    stake: 15, when: daily(10), dir: { kind: "skill", p: 0.3 } });

  // --- frequency ---
  add({ name: "Weekender", persona: "skilled 65%, plays only 2 days in 7, 14:00, referred by Promoter",
    stake: 22, when: (day) => (day % 7 >= 5 ? 14 : null), dir: { kind: "skill", p: 0.65 }, referral: "Promoter" });
  add({ name: "Every-Other-Day", persona: "skilled 60%, every second day, 08:00",
    stake: 19, when: (day) => (day % 2 === 0 ? 8 : null) });
  add({ name: "Sometimes", persona: "coin flips, plays about half the days at a random hour",
    stake: 15, when: (day, rng) => (rng.bool(0.5) ? rng.int(24) : null), dir: { kind: "random" } });
  add({ name: "Quitter", persona: "skilled 62%, stops playing on day 120, claims at the end",
    stake: 30, when: (day) => (day < 120 ? 11 : null), dir: { kind: "skill", p: 0.62 } });
  add({ name: "Late-Joiner", persona: "skilled 62%, starts on day 150 with funds sent then",
    stake: 0, joinFunds: { day: 150, amount: 15 }, when: (day) => (day >= 150 ? 13 : null), dir: { kind: "skill", p: 0.62 }, claim: "weekly" });

  // --- the Sentiment game ---
  add({ name: "Sentiment-Herd", persona: "satori only, sides with yesterday's majority, 20:00",
    stake: 15, when: daily(20), games: ["satori"], dir: { kind: "herd" } });
  add({ name: "Sentiment-Contra", persona: "satori only, against yesterday's majority, 21:00",
    stake: 15, when: daily(21), games: ["satori"], dir: { kind: "antiherd" } });
  add({ name: "Sentiment-Random", persona: "satori only, coin flips, random hour",
    stake: 8, when: randomHour, games: ["satori"], dir: { kind: "random" } });

  // --- reputation, dust and small stakes ---
  add({ name: "Reputation-Builder", persona: "skilled 70% on the unpaid COLD game (streak, no pay) until day 100, then ALPHA",
    stake: 11, when: daily(4), games: (day) => (day < 100 ? ["COLD"] : ["ALPHA"]), dir: { kind: "skill", p: 0.7 } });
  add({ name: "Minnow-A", persona: "2 SATORI, skilled 60%, ALPHA at 11:00, referred by Promoter (also receives Trader's transfers)",
    stake: 1.5, when: daily(11), games: ["ALPHA"], referral: "Promoter" });
  add({ name: "Minnow-B", persona: "2 SATORI, skilled 55%, GAMMA + satori at 13:00",
    stake: 2.2, when: daily(13), games: ["GAMMA", "satori"], dir: { kind: "skill", p: 0.55 } });
  add({ name: "Dust-Farmer", persona: "0.01 SATORI (below the farming threshold), skilled 70%: paid when right, streak never grows",
    stake: 0.01, when: daily(7), games: ["ALPHA"], dir: { kind: "skill", p: 0.7 } });
  add({ name: "Dust-Bull", persona: "0.0005 SATORI, always UP on everything",
    stake: 0.0005, when: daily(16), games: [...ALL, "satori"], dir: { kind: "up" } });

  // --- claiming styles ---
  add({ name: "Compounder", persona: "skilled 64%, claims every day so its power grows, referred by Promoter",
    stake: 11, when: daily(9), dir: { kind: "skill", p: 0.64 }, claim: "daily", referral: "Promoter" });
  add({ name: "Cold-Claimer", persona: "skilled 60%, claims weekly to a separate cold wallet",
    stake: 15, when: daily(17), claim: "weekly", claimTo: "Cold-Wallet" });
  add({ name: "Cold-Wallet", persona: "never plays; receives Cold-Claimer's claims", stake: 0, passive: true });
  add({ name: "Promoter", persona: "never plays; is the referrer of five players, earns only their 5% cuts", stake: 0, passive: true, claim: "weekly" });

  // --- delegation ---
  add({ name: "Delegate-Pro", persona: "skilled 68%, predicts with 4-5 delegators' capital, keeps the default 10% of their share",
    stake: 22, when: daily(10), games: [...ALL, "satori"], dir: { kind: "skill", p: 0.68 }, claim: "weekly" });
  add({ name: "Delegate-Generous", persona: "skilled 60%, predictor fee set to 0 (delegators keep all of theirs)",
    stake: 19, when: daily(16), games: ["ALPHA", "BETA"], feeBps: 0, claim: "weekly" });
  add({ name: "Delegator-1", persona: "delegates to Delegate-Pro, claims weekly", stake: 7.5, delegateTo: "Delegate-Pro", claim: "weekly" });
  add({ name: "Delegator-2", persona: "delegates to Delegate-Pro, claims monthly", stake: 15, delegateTo: "Delegate-Pro", claim: "monthly" });
  add({ name: "Delegator-3", persona: "delegates to Delegate-Pro, claims only at the end", stake: 3.7, delegateTo: "Delegate-Pro" });
  add({ name: "Delegator-4", persona: "delegates to Delegate-Pro, claims daily", stake: 11, delegateTo: "Delegate-Pro", claim: "daily" });
  add({ name: "Delegator-5", persona: "delegates to Delegate-Generous, claims weekly", stake: 9, delegateTo: "Delegate-Generous", claim: "weekly" });
  add({ name: "Delegator-6", persona: "delegates to Delegate-Generous, claims at the end", stake: 6, delegateTo: "Delegate-Generous" });
  add({ name: "Switcher", persona: "delegates to Delegate-Pro, switches to Delegate-Generous on day 100, leaves and predicts itself from day 201",
    stake: 13, delegateTo: "Delegate-Pro", switches: [{ day: 100, to: "Delegate-Generous" }, { day: 200, to: null }],
    when: (day) => (day >= 201 ? 19 : null), games: ["BETA", "GAMMA"], dir: { kind: "skill", p: 0.55 }, claim: "weekly" });

  // --- voting, trading, settling, testing the rules ---
  add({ name: "Voter-Alpha", persona: "burns 1 SATORI on ALPHA every 10 days; skilled 55% on ALPHA at 05:00, claims weekly to fund the burns",
    stake: 22, when: daily(5), games: ["ALPHA"], dir: { kind: "skill", p: 0.55 }, claim: "weekly", votes: (day) => (day % 10 === 3 ? [{ game: "ALPHA", amount: 1 }] : []) });
  add({ name: "Voter-Spread", persona: "never predicts; burns 0.5 SATORI on a random market every 7 days",
    stake: 30, passive: true, votes: (day, rng) => (day % 7 === 2 ? [{ game: ALL[rng.int(3)], amount: 0.5 }] : []) });
  // Predicting locks transfers through the next round (A_rounds.md), so it sits out
  // the two days before each transfer.
  add({ name: "Trader", persona: "skilled 57%, sends 1 SATORI to Minnow-A every 5 days, sitting out the 2 days before (predicting locks transfers through the next round), claims weekly to fund them",
    stake: 22, claim: "weekly", when: (day) => (day % 5 === 0 || day % 5 === 1 ? null : 17), dir: { kind: "skill", p: 0.57 }, transfers: (day) => (day % 5 === 1 ? [{ to: "Minnow-A", amount: 1 }] : []) });
  add({ name: "Keeper", persona: "never predicts; settles everyone's open predictions every 3 days at 01:00", stake: 0.5, passive: true, keeper: true });
  add({ name: "Self-Settler", persona: "skilled 60%, settles its own predictions each day at 02:00, then predicts at 03:00",
    stake: 15, when: daily(3), settle: "self" });
  add({ name: "Rule-Tester", persona: "predicts at 22:00, then tries a second batch the same day and a prediction on a game that does not exist (both must revert)",
    stake: 7.5, when: daily(22), games: ["GAMMA"], dir: { kind: "random" }, ruleTester: true });
  return A;
}

module.exports = { cast };
