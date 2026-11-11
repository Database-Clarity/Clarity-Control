import { describe, expect, it } from 'vitest';
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

it('distinguishes base and enhanced arms, including formulas inside tags', () => {
  expect(highlights('<pve {{${1+2}}{#damage}} />')).toEqual(
    expect.arrayContaining([
      { text: '{{', kind: 'tag' },
      { text: '${1+2}', kind: 'number' },
      { text: '}{', kind: 'tag' },
      { text: '#damage', kind: 'variable' },
      { text: '}}', kind: 'tag' },
    ]),
  );
  expect(highlights('<pvp [{{5}{8}}] />')).toEqual(
    expect.arrayContaining([
      { text: '{{', kind: 'tag' },
      { text: '5', kind: 'number' },
      { text: '}{', kind: 'tag' },
      { text: '8', kind: 'variable' },
      { text: '}}', kind: 'tag' },
    ]),
  );
  // Two pairs on a line and the prose after them; a pair never runs onto the next line.
  expect(highlights('a {{1}{2}} b {{x y}{z}} c\n{{3}')).toEqual([
    { text: '{{', kind: 'tag' },
    { text: '1', kind: 'number' },
    { text: '}{', kind: 'tag' },
    { text: '2', kind: 'variable' },
    { text: '}}', kind: 'tag' },
    { text: '{{', kind: 'tag' },
    { text: 'x y', kind: 'number' },
    { text: '}{', kind: 'tag' },
    { text: 'z', kind: 'variable' },
    { text: '}}', kind: 'tag' },
  ]);
});

it('retains markup and comment boundaries inside long unstyled prose', () => {
  const prefix = 'Ordinary prose with Unicode 🡅 and punctuation. '.repeat(40);
  const text = [
    prefix + '#damage ${20+#d} <solar/> [Detail] end',
    prefix + '<title Label [Detail] />',
    'https://example.test/plain // comment #ignored',
    '/* multiline',
    '#hidden */ #visible',
  ].join('\n');
  const ranges = highlights(text);
  expect(ranges).toEqual(
    expect.arrayContaining([
      { text: '#damage', kind: 'variable' },
      { text: '${20', kind: 'number' },
      { text: '+#d}', kind: 'variable' },
      { text: '<solar/>', kind: 'tag' },
      { text: '[Detail]', kind: 'tag' },
      { text: '#visible', kind: 'variable' },
    ]),
  );
  expect(ranges.some((r) => r.kind === 'comment' && r.text.includes('// comment #ignored'))).toBe(
    true,
  );
  expect(ranges.some((r) => r.kind === 'comment' && r.text.includes('#hidden'))).toBe(true);
  expect(ranges.filter((r) => r.kind === 'variable').map((r) => r.text)).toEqual([
    '#damage',
    '+#d}',
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

describe('enhanced numbers (#e${base+#d})', () => {
  it('colours the base number as a number and only the rest as the enhanced part', () => {
    const ranges = highlights('Lasts #e${4.5+#d} seconds and #e${12.5*#d}% more.');
    expect(ranges).toEqual([
      { text: '#e', kind: 'variable' },
      { text: '${4.5', kind: 'number' },
      { text: '+#d}', kind: 'variable' },
      { text: '#e', kind: 'variable' },
      { text: '${12.5', kind: 'number' },
      { text: '*#d}', kind: 'variable' },
    ]);
  });

  it('keeps a lone number and its braces in the base colour', () => {
    expect(highlights('A ${10} B ${x}')).toEqual([
      { text: '${10}', kind: 'number' },
      { text: '${x}', kind: 'number' },
    ]);
  });

  it('never carries the enhanced part to the next line, and survives an unclosed brace', () => {
    const ranges = highlights(['${5+#d', 'plain ${6'].join('\n'));
    expect(ranges).toEqual([
      { text: '${5', kind: 'number' },
      { text: '+#d', kind: 'variable' },
      { text: '${6', kind: 'number' },
    ]);
  });

  it('keeps slash operators out of the comment scanner', () => {
    const ranges = highlights('${8/*#d} after');
    expect(ranges).toEqual([
      { text: '${8', kind: 'number' },
      { text: '/*#d}', kind: 'variable' },
    ]);
  });
});

describe('pipes', () => {
  it('leaves stack pipes next to percent signs unhighlighted', () => {
    const text = [
      'Bonuses at 1|2|3|4|5 Stacks:',
      '• 16.7% | 28.6% | 37.5% decreased',
      '• 2.5%|10%|13%|b2',
    ].join('\n');
    expect(highlights(text)).toEqual([]);
  });

  it('still highlights the cell pipes inside a table block, and stops after it', () => {
    const text = ['< table x >', '|h Name |c 5', '<$>', 'After 1|2'].join('\n');
    expect(highlights(text)).toEqual([
      { text: '< table x >', kind: 'type' },
      { text: '|h', kind: 'type' },
      { text: '|c', kind: 'type' },
      { text: '<$>', kind: 'type' },
    ]);
  });
});
