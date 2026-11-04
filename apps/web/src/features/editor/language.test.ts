import { expect, it } from 'vitest';
import { highlightTree, tagHighlighter, tags } from '@lezer/highlight';
import { clarityLanguage } from './language';

const highlighter = tagHighlighter([
  { tag: tags.keyword, class: 'keyword' },
  { tag: tags.string, class: 'string' },
  { tag: tags.variableName, class: 'variable' },
  { tag: tags.number, class: 'number' },
  { tag: tags.typeName, class: 'type' },
  { tag: tags.tagName, class: 'tag' },
  { tag: tags.comment, class: 'comment' },
]);
function highlights(text: string) {
  const ranges: { text: string; kind: string }[] = [];
  highlightTree(clarityLanguage.parser.parse(text), highlighter, (from, to, kind) => {
    ranges.push({ text: text.slice(from, to), kind });
  });
  return ranges;
}

it('retains markup and comment boundaries inside long unstyled prose', () => {
  const prefix = 'Ordinary prose with Unicode 🡅 and punctuation. '.repeat(40);
  const text = [
    prefix + '#damage ${20+#d} <solar/> [Detail] |b2 end',
    prefix + '<title Label [Detail] />',
    'https://example.test/plain // comment #ignored',
    '/* multiline',
    '#hidden */ #visible',
  ].join('\n');
  const ranges = highlights(text);
  expect(ranges).toEqual(
    expect.arrayContaining([
      { text: '#damage', kind: 'variable' },
      { text: '${20+#d}', kind: 'number' },
      { text: '<solar/>', kind: 'tag' },
      { text: '[Detail]', kind: 'tag' },
      { text: '|b2', kind: 'type' },
      { text: '#visible', kind: 'variable' },
    ]),
  );
  expect(ranges.some((r) => r.kind === 'comment' && r.text.includes('// comment #ignored'))).toBe(
    true,
  );
  expect(ranges.some((r) => r.kind === 'comment' && r.text.includes('#hidden'))).toBe(true);
  expect(ranges.filter((r) => r.kind === 'variable').map((r) => r.text)).toEqual([
    '#damage',
    '#visible',
  ]);
  expect(ranges.some((r) => r.kind === 'comment' && r.text.includes('https:'))).toBe(false);
});

it('keeps declaration names highlighted after spaces and punctuation', () => {
  const ranges = highlights('title Shared (\nBody\n)\nvar damage = 25\nexport hidden Value (');
  for (const name of ['Shared', 'damage', '25', 'Value']) {
    expect(ranges).toContainEqual({ text: name, kind: 'string' });
  }
  for (const keyword of ['title', 'var', 'export hidden ']) {
    expect(ranges).toContainEqual({ text: keyword, kind: 'keyword' });
  }
});
