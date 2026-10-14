import { ethers } from 'ethers';

// Single source of truth for game-type semantics. Pure functions only — no
// React, no contract calls. The SatoriGames model is many-games-per-stream:
// every stream auto-creates exactly one built-in binary game (gameTypeId 0)
// and users can add adapter games (gameTypeId 1+). The on-chain config and
// predict payload encodings differ per game "kind", so all of that logic is
// centralized here and imported wherever the UI builds config/payload bytes
// or renders labels.

// 'binary'  — built-in type-0 binary game (UP/DOWN).
// 'yesno'   — a type-1+ adapter whose registered name reads like "Yes/No".
// 'generic' — any other adapter; the UI treats config/payload as raw bytes.
export type GameKind = 'binary' | 'yesno' | 'generic';

// Classify a game by its type id + the adapter's registered name.
// gameTypeId 0 -> 'binary'. Otherwise a name matching /yes\s*\/?\s*no/i
// (e.g. "Yes/No", "YesNo", "yes no") -> 'yesno'. Everything else -> 'generic'.
export function gameKind(gameTypeId: number, adapterName?: string): GameKind {
  if (gameTypeId === 0) return 'binary';
  if (adapterName && /yes\s*\/?\s*no/i.test(adapterName)) return 'yesno';
  return 'generic';
}

export interface DirectionOption {
  value: number;
  label: string;
}

// Direction options for the 2-bucket kinds; null for 'generic'.
// binary -> UP(1)/DOWN(2); yesno -> YES(1)/NO(2).
export function directionOptions(kind: GameKind): DirectionOption[] | null {
  switch (kind) {
    case 'binary':
      return [
        { value: 1, label: 'UP' },
        { value: 2, label: 'DOWN' },
      ];
    case 'yesno':
      return [
        { value: 1, label: 'YES' },
        { value: 2, label: 'NO' },
      ];
    case 'generic':
      return null;
  }
}

// Build the createGame config bytes for a kind. Throws a readable Error on bad
// input (the UI surfaces these).
//   binary  -> '0x' (the built-in game takes no config)
//   yesno   -> abi.encode(['int128'],[threshold])  (32 bytes)
//   generic -> the raw configHex passed through (must be valid hex); '0x' default
export function encodeGameConfig(
  kind: GameKind,
  opts: { threshold?: bigint | string | number; configHex?: string },
): string {
  switch (kind) {
    case 'binary':
      return '0x';
    case 'yesno': {
      const { threshold } = opts;
      if (threshold === undefined || threshold === null || threshold === '') {
        throw new Error('A Yes/No game needs a threshold value.');
      }
      let value: bigint;
      try {
        value = BigInt(threshold);
      } catch {
        throw new Error(`Invalid threshold "${String(threshold)}", must be a whole number.`);
      }
      try {
        return ethers.AbiCoder.defaultAbiCoder().encode(['int128'], [value]);
      } catch {
        throw new Error('Threshold is out of range for a signed 128-bit integer.');
      }
    }
    case 'generic': {
      const configHex = opts.configHex ?? '0x';
      if (configHex !== '0x' && !ethers.isHexString(configHex)) {
        throw new Error('Config must be a 0x-prefixed hex string.');
      }
      return configHex;
    }
  }
}

// Build a predict payload for a kind. Throws a readable Error on bad input.
//   binary/yesno -> solidityPacked(['uint8'],[direction])  (direction must be 1 or 2)
//   generic      -> the raw payloadHex passed through; must be valid hex AND
//                   non-empty (an empty '0x' payload reverts on-chain).
export function encodePredictPayload(
  kind: GameKind,
  opts: { direction?: number; payloadHex?: string },
): string {
  switch (kind) {
    case 'binary':
    case 'yesno': {
      const { direction } = opts;
      if (direction !== 1 && direction !== 2) {
        throw new Error('Pick a direction before predicting.');
      }
      return ethers.solidityPacked(['uint8'], [direction]);
    }
    case 'generic': {
      const payloadHex = opts.payloadHex;
      if (!payloadHex || !ethers.isHexString(payloadHex)) {
        throw new Error('Payload must be a 0x-prefixed hex string.');
      }
      if (payloadHex === '0x') {
        throw new Error('Payload cannot be empty. Provide the bytes this game expects.');
      }
      return payloadHex;
    }
  }
}

// Human label for a kind, e.g. for badges.
export function gameKindLabel(kind: GameKind): string {
  switch (kind) {
    case 'binary':
      return 'Binary (Up/Down)';
    case 'yesno':
      return 'Yes/No';
    case 'generic':
      return 'Custom';
  }
}
