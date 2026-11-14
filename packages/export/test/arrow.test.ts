import { validateText } from '@clarity/core';
import { expect, test } from 'vitest';
import { parseMarkup } from '@clarity/core/markup/parse';
import { buildLegacy, deployedLegacyPresets, newStyleFile } from '../src/index.js';
import { emptyNotes, transform } from '../src/v1/transform.js';
import { fixtureInput } from './helpers.js';

const inputWith = (text: string) => {
  const { input } = fixtureInput();
  for (const perk of Object.values(input.perks)) {
    if ('editor' in perk)
      for (const entry of Object.values(perk.editor ?? {}))
        if (entry) entry.main = entry.secondary = text;
  }
  return input;
};

test.each(deployedLegacyPresets)('%s lowers the new arrow exactly to the old glyph', (preset) => {
  expect(buildLegacy(inputWith('30%<arrow/>33%'), preset)).toEqual(
    buildLegacy(inputWith('30%🠚33%'), preset),
  );
});

test('clarityV2 keeps the symbol, with an optional portable fallback', () => {
  const input = inputWith('30%<arrow/>33%');
  expect(new TextDecoder().decode(buildLegacy(input, 'clarityV2'))).toContain('"arrow"');
  expect(buildLegacy(input, 'clarityV2', { arrowFallback: true })).toEqual(
    buildLegacy(inputWith('30%→33%'), 'clarityV2'),
  );
});

test('custom files keep the drawing or emit the configured text fallback', () => {
  const lines = parseMarkup('30%<arrow/>33%', { variables: '', titles: '' }).lines;
  expect(lines[0].linesContent).toEqual([
    { text: '30%' },
    { classNames: ['arrow'] },
    { text: '33%' },
  ]);
  const file = newStyleFile('arrow-test', 'structured');
  expect(JSON.stringify(transform(lines, file.format, 'lines', emptyNotes()))).toContain('"arrow"');
  file.format.symbols.arrow = { mode: 'replace', before: '→', after: '' };
  expect(transform(lines, file.format, 'lines', emptyNotes())).toEqual([
    { linesContent: [{ text: '30%→33%' }] },
  ]);
  expect(transform(lines, newStyleFile('arrow-text', 'plain').format, 'text', emptyNotes())).toBe(
    '30%→33%',
  );
});

test.each(['pve', 'pvp', 'yellow', 'bold'])('arrows inherit the %s text style', (style) => {
  const text = `<${style} 30%<arrow/>33% />`;
  expect(validateText(text, 'en')).toEqual([]);
  expect(parseMarkup(text).lines[0].linesContent).toEqual([
    { text: '30%', classNames: [style] },
    { classNames: [style, 'arrow'] },
    { text: '33%', classNames: [style] },
  ]);
});

test('the text fallback keeps surrounding formatting', () => {
  const file = newStyleFile('arrow-markdown', 'markdown');
  expect(
    transform(parseMarkup('<bold 30%<arrow/>33% />').lines, file.format, 'text', emptyNotes()),
  ).toBe('**30%****→****33%**');
});
