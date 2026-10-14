import { ethers } from 'ethers';

/// The only cadence the registry accepts for a named stream.
export const NAMED_STREAM_CADENCE = 60;

/// `registry.namedAdapterId()` is 0 until the deploy wires the adapter. Checked
/// before anything the user has to sign, so an unwired chain fails fast.
export function requireNamedAdapterId(id: number): number {
  if (!id) throw new Error('Named streams are not enabled on this chain.');
  return id;
}

/// Arguments for hub.createAdapterDataStream(name, adapterId, provider, config,
/// cadence) on a named stream. The adapter's validate() pins provider to the
/// engine and config to the id the stream is about to receive, so `nextStreamId`
/// must be read right before the send — a stale one reverts StreamIdMismatch.
export function namedStreamCreateArgs(namedAdapterId: number, engine: string, nextStreamId: number) {
  return {
    adapterId: requireNamedAdapterId(namedAdapterId),
    target: engine,
    config: ethers.AbiCoder.defaultAbiCoder().encode(['uint32'], [nextStreamId]),
    cadence: NAMED_STREAM_CADENCE,
  };
}
