// Every event an off-chain reader consumes, pinned by full signature and topic0
// (docs/issues/events-are-the-read-model.md, rule 3). A failure here means a
// consumed event changed: if that was intended, run scripts/gen-event-topics.js
// and update every reader the diff names.
const { expect } = require("chai");
const fs = require("fs");
const path = require("path");
const { build, CONSUMED } = require("../scripts/gen-event-topics");

const FIXTURE = path.join(__dirname, "fixtures", "event-topics.json");
const INDEXER_COPY = path.join(__dirname, "..", "..", "satori-indexer", "src", "events.json");

describe("Consumed event topics", function () {
  const fixture = JSON.parse(fs.readFileSync(FIXTURE, "utf8"));
  const compiled = build();

  for (const [contract, events] of Object.entries(CONSUMED)) {
    for (const name of events) {
      it(`${contract}.${name} matches its committed signature and topic`, function () {
        expect(fixture[contract]?.[name], "missing from the fixture").to.not.equal(undefined);
        expect(compiled[contract][name].signature).to.equal(fixture[contract][name].signature);
        expect(compiled[contract][name].topic).to.equal(fixture[contract][name].topic);
      });
    }
  }

  it("lists nothing the generator does not", function () {
    expect(Object.keys(fixture).sort()).to.deep.equal(Object.keys(CONSUMED).sort());
    for (const c of Object.keys(fixture)) expect(Object.keys(fixture[c]).sort()).to.deep.equal([...CONSUMED[c]].sort());
  });

  it("the indexer reads the same file", function () {
    expect(fs.readFileSync(INDEXER_COPY, "utf8")).to.equal(fs.readFileSync(FIXTURE, "utf8"));
  });
});
