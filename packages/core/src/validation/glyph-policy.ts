/**
 * Portable text policy (2026-11-02). This is a compatibility heuristic, not a
 * claim that a browser can test fonts on another device. Keep all coverage and
 * replacement decisions here. ASCII text and ordinary Latin-1/Latin Extended-A
 * letters are covered by Arial/Helvetica and system UI fallbacks. The explicit
 * punctuation below includes the common symbols in editor-data 100d9e6.
 * WORD JOINER and NBSP intentionally affect layout rather than drawing a glyph.
 * Common Cyrillic, Kana, Han, Hangul and Bopomofo text is also vetted via
 * system language fallbacks (Yu Gothic/Malgun Gothic, PingFang/Hiragino,
 * Noto CJK). This applies across languages because translations can quote
 * another language. Supplementary Han and specialist scripts remain unverified.
 * Combining diacritics are needed for decomposed French/Spanish/Latin text.
 * Evidence: DIM src/app/main.scss (Open Sans, sans-serif, Destiny/DIM Symbols),
 * googlefonts/opensans; editor preview uses Arial/Helvetica/DestinySymbols,
 * Microsoft typography/font-list/arial and font-list/segoe-ui-symbol,
 * Android frameworks/base/data/fonts/fonts.xml (Noto fallback),
 * Unicode charts U0080, U0100, U2000, U2100, U1F800.
 * Script coverage: learn.microsoft.com/en-us/typography/font-list/yu-gothic
 * and /malgun-gothic; github.com/notofonts/noto-cjk; support.apple.com/120414.
 * Supplemental Arrows-C needs specialist fallback. DIM special-cases U+1F845;
 * never automatically replace that semantic enhanced-perk marker.
 */
export const glyphPolicy = {
  ranges: [
    [0x20, 0x7e],
    [0xa0, 0xac],
    [0xae, 0x17f],
    [0x300, 0x36f], // Combining diacritics (normal decomposed text).
    [0x400, 0x4ff], // Cyrillic, including Russian Ё/ё.
    [0x1100, 0x11ff], // Hangul Jamo (decomposed Korean).
    [0x3041, 0x3096], // Hiragana.
    [0x3099, 0x30ff], // Kana marks and Katakana.
    [0x3105, 0x312f], // Bopomofo (Traditional Chinese pronunciation).
    [0x3131, 0x318e], // Hangul compatibility letters.
    [0x4e00, 0x9fff], // Basic unified Han (Simplified/Traditional/Japanese).
    [0xac00, 0xd7a3], // Modern Hangul syllables.
    [0xff01, 0xff60], // Fullwidth punctuation, Latin letters and digits.
    [0xff61, 0xff9f], // Halfwidth Japanese punctuation and Katakana.
    [0xffe0, 0xffe6], // Fullwidth currency/math.
  ],
  characters: '\t\n\r–—‘’“”•…←↑→↓⇒≤≥≠−∞♥№\u2060\u3000、。〃々〆〇〈〉《》「」『』【】〔〕〜',
  knownRisk: {
    '🠚': { reason: 'Supplemental arrow needs a font some devices do not have.', replacement: '->' },
    '🠅': { reason: 'Supplemental arrow needs a font some devices do not have.', replacement: '^' },
    '🡅': { reason: 'Enhanced-perk marker: consumer support varies; DIM handles it specially.' },
    '\uFEFF': {
      reason:
        'Invisible legacy no-break character; check whether a space or WORD JOINER was intended.',
    },
  } as Record<string, { reason: string; replacement?: string }>,
};
