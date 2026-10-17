import { namedStreamCreateArgs, NAMED_STREAM_CADENCE } from './namedStream';

// hub.createAdapterDataStream(name, namedAdapterId, engine, 0x, 60) — the
// adapter's validate() pins provider == engine, the registry writes the config
// itself (any other reverts NamedStreamConfig) and refuses any cadence but 60.

const ENGINE = '0x0DCd1Bf9A1b36cE34237eEaFef220932846BCD82';

describe('namedStreamCreateArgs', () => {
  it('targets the engine with the registry-reported adapter id', () => {
    const a = namedStreamCreateArgs(5, ENGINE);
    expect(a.adapterId).toBe(5);
    expect(a.target).toBe(ENGINE);
  });

  it('sends an empty config: the registry writes it', () => {
    expect(namedStreamCreateArgs(4, ENGINE).config).toBe('0x');
  });

  it('forces the hourly cadence the registry demands', () => {
    expect(namedStreamCreateArgs(5, ENGINE).cadence).toBe(60);
    expect(NAMED_STREAM_CADENCE).toBe(60);
  });

  it('refuses an unwired chain rather than sending adapter 0', () => {
    expect(() => namedStreamCreateArgs(0, ENGINE)).toThrow(/not enabled/i);
  });
});
