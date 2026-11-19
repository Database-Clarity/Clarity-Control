// The one formatting equivalence shared by every approval fingerprint (cell text and authored
// English alike): line breaks, whitespace runs, zero-width characters, dashes, and straight or
// curly quotes. Wording, numbers, and every other symbol remain significant. Kept free of
// imports so schema modules can use it without a cycle.
const ZERO_WIDTH = /[\u200b-\u200d\u2060\ufeff\u00ad]/g;
const DASHES = /[\u2010-\u2015\u2212]/g;
const APOSTROPHES = /[\u2018\u2019\u201a\u201b]/g;
const QUOTES = /[\u201c\u201d\u201e\u201f]/g;
export function normaliseEvidenceText(text: string): string {
  return text
    .normalize('NFC')
    .replace(/\r\n?/g, '\n')
    .replace(ZERO_WIDTH, '')
    .replace(DASHES, '-')
    .replace(APOSTROPHES, "'")
    .replace(QUOTES, '"')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .trim();
}
