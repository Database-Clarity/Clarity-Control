/**
 * Portable text policy (2026-11-02). This is a compatibility heuristic, not a
 * claim that a browser can test fonts on another device. Keep all coverage and
 * replacement decisions here. ASCII text and ordinary Latin-1/Latin Extended-A
 * letters are covered by Arial/Helvetica and system UI fallbacks. The explicit
 * punctuation below includes the common symbols in editor-data 100d9e6.
 * WORD JOINER and NBSP intentionally affect layout rather than drawing a glyph.
 * Other scripts/symbols remain unverified, not invalid; extend only with evidence.
 * Evidence: DIM src/app/main.scss (Open Sans, sans-serif, Destiny/DIM Symbols),
 * googlefonts/opensans; editor preview uses Arial/Helvetica/DestinySymbols,
 * Microsoft typography/font-list/arial and font-list/segoe-ui-symbol,
 * Android frameworks/base/data/fonts/fonts.xml (Noto fallback),
 * Unicode charts U0080, U0100, U2000, U2100, U1F800.
 * Supplemental Arrows-C needs specialist fallback. DIM special-cases U+1F845;
 * never automatically replace that semantic enhanced-perk marker.
 */
export const glyphPolicy = {
  ranges: [
    [0x20, 0x7e],
    [0xa0, 0xac],
    [0xae, 0x17f],
  ],
  characters: '\t\n\r–—‘’“”•…←↑→↓⇒≤≥≠−∞♥\u2060',
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
