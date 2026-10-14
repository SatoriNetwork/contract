// Profanity filter for stream names.
//
// Stream names are free text chosen by stream creators and stored on-chain.
// The contract has no filtering — that's a deliberate design choice (no
// censorship at the protocol level). The dapp side is mutable, so we apply
// a client-side filter here to hide streams whose names contain obvious
// slurs or swear words. This is a UX choice, not a moderation policy:
// the streams still exist on-chain and are accessible via direct ID or
// via a different frontend.
//
// Match policy:
//   - Case-insensitive
//   - Whole-word match for short common words to avoid false positives
//     ("ass" should not flag "assistant"; "cum" should not flag "cumulus")
//   - Substring match for unambiguous slurs that don't appear in common words
//   - Leetspeak normalization (3→e, 1→i, 0→o, @→a, $→s) before matching
//
// This list is intentionally small and biased toward obvious cases.
// False positives (clean streams hidden) are worse than false negatives
// (rude streams shown). When in doubt, leave a word off the list.

// Words matched only as whole tokens (bounded by non-letters on both sides).
const WHOLE_WORD_BLOCKLIST = [
  'ass',
  'asshole',
  'bastard',
  'bitch',
  'bollocks',
  'cock',
  'cum',
  'cunt',
  'damn',
  'dick',
  'fag',
  'faggot',
  'fuck',
  'fucked',
  'fucker',
  'fucking',
  'jerk',
  'piss',
  'prick',
  'pussy',
  'shit',
  'shitty',
  'slut',
  'tit',
  'tits',
  'twat',
  'wanker',
  'whore',
];

// Substrings matched anywhere (used for slurs and obvious profanity stems
// that don't legitimately appear inside common words).
const SUBSTRING_BLOCKLIST = [
  'nigger',
  'nigga',
  'faggot',
  'retard',
  'tranny',
  'kike',
  'spic',
  'chink',
  'wetback',
];

function normalize(input: string): string {
  return input
    .toLowerCase()
    .replace(/3/g, 'e')
    .replace(/1/g, 'i')
    .replace(/!/g, 'i')
    .replace(/0/g, 'o')
    .replace(/@/g, 'a')
    .replace(/\$/g, 's')
    .replace(/\+/g, 't')
    // Collapse repeated letters: "fuuuuck" → "fuck"
    .replace(/(.)\1{2,}/g, '$1');
}

/**
 * Returns true if the given stream name contains profanity that should
 * cause it to be hidden in the dapp UI.
 */
export function isProfane(name: string): boolean {
  if (!name) return false;
  const norm = normalize(name);

  for (const word of SUBSTRING_BLOCKLIST) {
    if (norm.includes(word)) return true;
  }

  // Word boundary split. \w lets digits sneak through, so we tokenize on
  // anything that isn't a letter — matches what most readers would call a
  // "word boundary."
  const tokens = norm.split(/[^a-z]+/).filter(Boolean);
  for (const tok of tokens) {
    if (WHOLE_WORD_BLOCKLIST.includes(tok)) return true;
  }

  return false;
}

