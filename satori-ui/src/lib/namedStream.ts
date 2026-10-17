/// The only cadence the registry accepts for a named stream.
export const NAMED_STREAM_CADENCE = 60;

/// `registry.namedAdapterId()` is 0 until the deploy wires the adapter. Checked
/// before anything the user has to sign, so an unwired chain fails fast.
export function requireNamedAdapterId(id: number): number {
  if (!id) throw new Error('Named streams are not enabled on this chain.');
  return id;
}

/// Arguments for hub.createAdapterDataStream(name, adapterId, provider, config,
/// cadence) on a named stream. The registry writes a named stream's config
/// itself and reverts NamedStreamConfig on any other, so it is always empty.
export function namedStreamCreateArgs(namedAdapterId: number, engine: string) {
  return {
    adapterId: requireNamedAdapterId(namedAdapterId),
    target: engine,
    config: '0x',
    cadence: NAMED_STREAM_CADENCE,
  };
}

/// SatoriBounties.fundBounty reverts NamedGame on any game of a named stream.
export const NAMED_NO_BOUNTY =
  'Named games take no bounties: a bounty pays every right call, and on a named game the crowd\'s own flow decides what is right.';
