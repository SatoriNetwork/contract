import { ethers } from 'ethers';
import { namedStreamCreateArgs, NAMED_STREAM_CADENCE } from './namedStream';

// hub.createAdapterDataStream(name, namedAdapterId, engine, abi.encode(uint32(nextStreamId)), 60)
// — the adapter's validate() pins provider == engine and config == the id the
// stream is about to get, and the registry refuses any cadence but 60.

const ENGINE = '0x0DCd1Bf9A1b36cE34237eEaFef220932846BCD82';

describe('namedStreamCreateArgs', () => {
  it('targets the engine with the registry-reported adapter id', () => {
    const a = namedStreamCreateArgs(5, ENGINE, 42);
    expect(a.adapterId).toBe(5);
    expect(a.target).toBe(ENGINE);
  });

  it('encodes nextStreamId as a single uint32', () => {
    const a = namedStreamCreateArgs(4, ENGINE, 42);
    expect(a.config).toBe(ethers.AbiCoder.defaultAbiCoder().encode(['uint32'], [42]));
    const [decoded] = ethers.AbiCoder.defaultAbiCoder().decode(['uint32'], a.config);
    expect(Number(decoded)).toBe(42);
  });

  it('forces the hourly cadence the registry demands', () => {
    expect(namedStreamCreateArgs(5, ENGINE, 1).cadence).toBe(60);
    expect(NAMED_STREAM_CADENCE).toBe(60);
  });

  it('refuses an unwired chain rather than sending adapter 0', () => {
    expect(() => namedStreamCreateArgs(0, ENGINE, 42)).toThrow(/not enabled/i);
  });
});
