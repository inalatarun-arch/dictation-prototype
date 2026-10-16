// Rule-based cleanup for dictated text.
// Pure functions: no DOM, no network, no AI service. The same file runs in the
// browser and in the Node tests (test/cleanup.test.js).
//
// Traces to: SRS-005 (cleanup rules), SRS-006 (custom words), SRS-004 (insertion spacing).
// Values marked [PROPOSED] come from the requirements document and still need approval.

export const DEFAULT_FILLERS = ['um', 'umm', 'uh', 'uhh', 'er', 'erm', 'hmm'];
export const PAUSE_PUNCTUATION_SECONDS = 1.0; // [PROPOSED] SRS-005: pause longer than this ends a sentence
export const MAX_CUSTOM_WORDS = 200; // [PROPOSED] TC-CLN-007

// "like" and "you know" are deliberately not in the default list: removing them
// deletes real words ("I like tea"). Pass your own list through options.fillers.

const MARK = '';
const WORD = '\\p{L}\\p{M}\\p{N}_'; // letters, combining marks (Hindi matras), digits
const SENTENCE_END = /[.!?।…]["'”’)\]]*$/u;
const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Collapse whitespace, tidy spaces around punctuation, trim stray leading commas. */
export function normalizeSpacing(text) {
  return String(text)
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.;:!?।…])/gu, '$1')
    .replace(/,\s*([.!?।…])/gu, '$1')
    .replace(/^[\s,;:]+/u, '')
    .trim();
}

/** Sentence-ending mark that fits the script of the last letter: "।" for Devanagari, "." otherwise. */
function terminalMark(text) {
  const lastLetter = [...text].reverse().find((ch) => /\p{L}/u.test(ch));
  return lastLetter && /\p{Script=Devanagari}/u.test(lastLetter) ? '।' : '.';
}

/** Remove whole-word fillers. "umbrella" and "uh-huh" are left alone. */
export function removeFillers(text, fillers = DEFAULT_FILLERS) {
  const list = fillers.map((f) => String(f).trim()).filter(Boolean);
  if (!list.length) return text;
  const alternatives = list
    .sort((a, b) => b.length - a.length)
    .map(escapeRegExp)
    .join('|');
  const filler = new RegExp(`(?<![${WORD}'’-])(?:${alternatives})(?![${WORD}'’-])`, 'giu');
  let t = text.replace(filler, MARK);
  // ", um," collapses to a single comma
  t = t.replace(new RegExp(`,\\s*${MARK}(?:\\s*${MARK})*\\s*,`, 'g'), ',');
  // remaining fillers (and one comma that followed them) become a space
  t = t.replace(new RegExp(`${MARK}(?:\\s*${MARK})*\\s*[,;]?`, 'g'), ' ');
  return t;
}

/**
 * Join Whisper segments. A pause longer than pauseSeconds between two segments
 * ends the sentence if it has no ending mark yet. Exactly pauseSeconds does not.
 * chunks: [{ text, timestamp: [startSeconds, endSeconds] }]
 */
export function joinChunks(chunks, pauseSeconds = PAUSE_PUNCTUATION_SECONDS) {
  let out = '';
  let lastEnd = null;
  for (const chunk of chunks) {
    const part = String(chunk?.text ?? '').trim();
    if (!part) continue;
    const [start, end] = Array.isArray(chunk.timestamp) ? chunk.timestamp : [null, null];
    if (out) {
      const gap = typeof start === 'number' && typeof lastEnd === 'number' ? start - lastEnd : 0;
      if (gap > pauseSeconds + 1e-9 && !SENTENCE_END.test(out)) {
        const body = out.replace(/[,;:\s]+$/u, '');
        out = body + terminalMark(body);
      }
      out += ' ';
    }
    out += part;
    if (typeof end === 'number') lastEnd = end;
    else if (typeof start === 'number') lastEnd = start;
  }
  return out;
}

/** Add a sentence-ending mark when the text has none. */
export function ensureTerminalPunctuation(text) {
  const t = text.trim();
  if (!t || SENTENCE_END.test(t)) return t;
  const body = t.replace(/[,;:\-–—\s]+$/u, '');
  return body ? body + terminalMark(body) : '';
}

/** Capitalize the first letter of the text and of each sentence. */
export function capitalizeSentences(text) {
  return text.replace(/(^|[.!?।…]["'”’)\]]*\s+)(\p{Ll})/gu, (_, lead, ch) => lead + ch.toUpperCase());
}

/**
 * Parse the custom word list. One entry per line:
 *   Winfo                 -> fixes the capitalization of "winfo"
 *   win four -> Winfo     -> replaces "win four" with "Winfo"
 * Blank lines and lines starting with # are ignored.
 */
export function parseCustomWords(raw) {
  const entries = [];
  const seen = new Set();
  for (const line of String(raw ?? '').split(/\r?\n/)) {
    const s = line.trim();
    if (!s || s.startsWith('#')) continue;
    const arrow = s.match(/^(.+?)\s*(?:->|→)\s*(.+)$/u);
    const heard = (arrow ? arrow[1] : s).trim();
    const correct = (arrow ? arrow[2] : s).trim();
    const key = heard.toLowerCase();
    if (!heard || !correct || seen.has(key)) continue;
    seen.add(key);
    entries.push({ heard, correct });
  }
  return { entries, count: entries.length, tooMany: entries.length > MAX_CUSTOM_WORDS };
}

/** Replace whole-word, case-insensitive matches with the saved spelling. */
export function applyCustomWords(text, entries) {
  if (!entries?.length) return text;
  const longestFirst = [...entries].sort((a, b) => b.heard.length - a.heard.length);
  let t = text;
  for (const { heard, correct } of longestFirst) {
    const pattern = heard.split(/\s+/).map(escapeRegExp).join('\\s+');
    t = t.replace(new RegExp(`(?<![${WORD}])${pattern}(?![${WORD}])`, 'giu'), () => correct);
  }
  return t;
}

/**
 * Full cleanup. input is a string or an array of Whisper chunks.
 * Returns '' when nothing but fillers or punctuation was said.
 */
export function cleanup(input, options = {}) {
  const o = {
    removeFillers: true,
    capitalize: true,
    punctuate: true,
    fillers: DEFAULT_FILLERS,
    customWords: [],
    pauseSeconds: PAUSE_PUNCTUATION_SECONDS,
    ...options,
  };
  let text = Array.isArray(input)
    ? joinChunks(input, o.punctuate ? o.pauseSeconds : Infinity)
    : String(input ?? '');
  text = normalizeSpacing(text);
  if (o.removeFillers) text = normalizeSpacing(removeFillers(text, o.fillers));
  if (!text || !/[\p{L}\p{N}]/u.test(text)) return '';
  if (o.punctuate) text = ensureTerminalPunctuation(text);
  if (o.capitalize) text = capitalizeSentences(text);
  return applyCustomWords(text, o.customWords).trim();
}

/**
 * The exact string to insert at the caret: adds a space before it when the
 * previous character is a word character, and after it when the next one is.
 */
export function spacedInsertion(value, start, end, text) {
  const prev = value.slice(0, start).slice(-1);
  const next = value.slice(end).slice(0, 1);
  let piece = text;
  if (prev && !/[\s(\[{“‘]/u.test(prev) && !/^[,.;:!?।…)\]}]/u.test(piece)) piece = ' ' + piece;
  if (next && !/[\s,.;:!?।…)\]}]/u.test(next)) piece += ' ';
  return piece;
}
