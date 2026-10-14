// Deterministic pseudo-English name from an ETH address.
// Port of /code/Eth-name.txt — same letter weighting, the same valid
// onsets/codas, and the same scoring/search loop. Same address always
// produces the same phrase.

// -----------------------------
// 1. Hex byte -> weighted letter
// -----------------------------

function hexpairToLetter(pair: string): string {
  const n = parseInt(pair, 16);
  if (Number.isNaN(n)) throw new Error(`Invalid byte: ${pair}`);

  if (n <= 0x1d) return 'e';
  if (n <= 0x33) return 't';
  if (n <= 0x47) return 'a';
  if (n <= 0x59) return 'o';
  if (n <= 0x6a) return 'i';
  if (n <= 0x7b) return 'n';
  if (n <= 0x8b) return 's';
  if (n <= 0x9a) return 'h';
  if (n <= 0xa9) return 'r';
  if (n <= 0xb4) return 'd';
  if (n <= 0xbe) return 'l';
  if (n <= 0xc5) return 'c';
  if (n <= 0xcc) return 'u';
  if (n <= 0xd3) return 'm';
  if (n <= 0xd9) return 'w';
  if (n <= 0xdf) return 'f';
  if (n <= 0xe5) return 'g';
  if (n <= 0xeb) return 'y';
  if (n <= 0xf1) return 'p';
  if (n <= 0xf5) return 'b';
  if (n <= 0xf8) return 'v';
  if (n <= 0xfb) return 'k';
  if (n === 0xfc) return 'j';
  if (n === 0xfd) return 'x';
  if (n === 0xfe) return 'q';
  return 'z'; // 0xff
}

function ethAddressToWeightedLetters(address: string): string {
  const h = address.toLowerCase().replace(/^0x/, '');
  if (h.length !== 40) throw new Error('Ethereum address must contain exactly 40 hex characters');
  if (!/^[0-9a-f]{40}$/.test(h)) throw new Error('Address has non-hex chars');
  let out = '';
  for (let i = 0; i < 40; i += 2) out += hexpairToLetter(h.slice(i, i + 2));
  return out;
}

// -----------------------------
// 2. Compress ugly consonant noise
// -----------------------------

const VOWELS = new Set('aeiou');

const VALID_ONSETS = new Set<string>([
  ...'bcdfghjklmnpqrstvwxz'.split(''),
  'bl', 'br', 'ch', 'cl', 'cr', 'dr',
  'fl', 'fr', 'gl', 'gr',
  'pl', 'pr',
  'sc', 'sk', 'sl', 'sm', 'sn', 'sp', 'st', 'sw',
  'th', 'tr', 'tw',
  'sh', 'wh', 'wr',
  'qu',
  'scr', 'shr', 'spl', 'spr', 'str', 'thr',
]);

const VALID_CODAS = new Set<string>([
  ...'bcdfghjklmnpqrstvwxz'.split(''),
  'ck', 'ct', 'ft', 'ld', 'lf', 'lk', 'lm', 'lp', 'lt',
  'ls', 'mp', 'nd', 'ng', 'nk', 'nt',
  'pt', 'rd', 'rk', 'rm', 'rn', 'rp', 'rt',
  'sk', 'sp', 'st', 'th',
  'lds', 'lks', 'lms', 'lts',
  'mps', 'nds', 'nks', 'nts',
  'rds', 'rks', 'rms', 'rns', 'rts',
]);

function longestValidSuffix(s: string, valid: Set<string>): string {
  for (let size = Math.min(3, s.length); size > 0; size--) {
    const chunk = s.slice(s.length - size);
    if (valid.has(chunk)) return chunk;
  }
  return '';
}

function longestValidPrefix(s: string, valid: Set<string>): string {
  for (let size = Math.min(3, s.length); size > 0; size--) {
    const chunk = s.slice(0, size);
    if (valid.has(chunk)) return chunk;
  }
  return '';
}

function compressToPronounceable(input: string): string {
  const s = input.toLowerCase().replace(/[^a-z]/g, '');
  const vowelIndexes: number[] = [];
  for (let i = 0; i < s.length; i++) if (VOWELS.has(s[i])) vowelIndexes.push(i);
  if (vowelIndexes.length === 0) return '';

  const out: string[] = [];

  let pendingOnset = longestValidSuffix(s.slice(0, vowelIndexes[0]), VALID_ONSETS);

  for (let idx = 0; idx < vowelIndexes.length; idx++) {
    const vowelI = vowelIndexes[idx];
    out.push(pendingOnset);
    out.push(s[vowelI]);
    pendingOnset = '';

    if (idx + 1 < vowelIndexes.length) {
      const nextVowelI = vowelIndexes[idx + 1];
      const run = s.slice(vowelI + 1, nextVowelI);

      const nextOnset = longestValidSuffix(run, VALID_ONSETS);

      let middle = run;
      if (nextOnset) middle = run.slice(0, run.length - nextOnset.length);

      const coda = longestValidPrefix(middle, VALID_CODAS);
      out.push(coda);
      pendingOnset = nextOnset;
    } else {
      const finalRun = s.slice(vowelI + 1);
      let finalCoda = longestValidPrefix(finalRun, VALID_CODAS);
      if (finalRun.endsWith('y') && !finalCoda.endsWith('y')) finalCoda += 'y';
      out.push(finalCoda);
    }
  }

  return out.join('');
}

// -----------------------------
// 3. Extract 2–3 pseudo-words
// -----------------------------

const GOOD_PATTERNS: Record<string, number> = {
  CVC: 10,
  CV: 7,
  VC: 7,
  VCV: 8,
  CVCV: 11,
  VCVC: 9,
  CCV: 8,
  CCVC: 11,
  CVCC: 8,
  CVCVC: 12,
  VCCV: 8,
};

function cvPattern(s: string): string {
  let out = '';
  for (const ch of s) out += VOWELS.has(ch) ? 'V' : 'C';
  return out;
}

function hasBadCluster(s: string): boolean {
  const re = /[^aeiou]+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    const run = m[0];
    if (run.length <= 1) continue;
    if (VALID_ONSETS.has(run) || VALID_CODAS.has(run)) continue;
    if (run.length === 2 && run[1] === 's') continue;
    return true;
  }
  return false;
}

function candidateScore(word: string): number | null {
  let hasVowel = false;
  for (const ch of word) if (VOWELS.has(ch)) { hasVowel = true; break; }
  if (!hasVowel) return null;

  const pattern = cvPattern(word);
  let score = GOOD_PATTERNS[pattern] ?? 3;

  if (hasBadCluster(word)) score -= 8;
  if ('aeiourlnstmg'.includes(word[word.length - 1])) score += 2;

  if (word.length === 3) score += 3;
  else if (word.length === 4) score += 2;
  else if (word.length === 5) score += 1;
  else score -= 4;

  return score >= 7 ? score : null;
}

interface Candidate {
  i: number;
  j: number;
  word: string;
  score: number;
}

function extractCandidates(s: string): Candidate[] {
  const out: Candidate[] = [];
  for (let i = 0; i < s.length; i++) {
    for (let size = 3; size <= 5; size++) {
      const word = s.slice(i, i + size);
      if (word.length < size) continue;
      const score = candidateScore(word);
      if (score !== null) out.push({ i, j: i + size, word, score });
    }
  }
  return out;
}

function extractPseudoPhrase(s: string, maxWords = 3): string {
  const candidates = extractCandidates(s);
  let bestScore = -Infinity;
  let bestWords: string[] = [];

  function search(start: number, words: string[], score: number) {
    if (words.length >= 2) {
      const finalScore = score - (s.length - start) * 0.15;
      if (finalScore > bestScore) {
        bestScore = finalScore;
        bestWords = words.slice();
      }
    }
    if (words.length === maxWords) return;
    for (const c of candidates) {
      if (c.i < start) continue;
      const skipped = c.i - start;
      search(c.j, [...words, c.word], score + c.score - skipped * 0.35);
    }
  }

  search(0, [], 0);
  return bestWords.length > 0 ? bestWords.join(' ') : s;
}

// -----------------------------
// 4. Public API
// -----------------------------

const cache = new Map<string, string>();

export function ethAddressName(address: string): string {
  if (!address) return '';
  const key = address.toLowerCase();
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  let phrase: string;
  try {
    const weighted = ethAddressToWeightedLetters(address);
    const compressed = compressToPronounceable(weighted);
    phrase = extractPseudoPhrase(compressed);
  } catch {
    phrase = '';
  }
  cache.set(key, phrase);
  return phrase;
}
