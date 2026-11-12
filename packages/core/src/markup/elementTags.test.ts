import { describe, expect, it } from 'vitest';
import {
  elementTagNames,
  findElementTags,
  hasElementTags,
  lowerElementTags,
} from './elementTags.js';
import { enhancedMarkupType } from './baseEnhanced.js';
import { parseMarkup } from './parse.js';
import type { MarkupLine, MarkupSpan } from './types.js';

// Hand-written: each tagged text and the legacy text an author writes for it today.
const fixtures: [name: string, tagged: string, legacy: string][] = [
  ['plain wrap', 'Gain <solar Scorch /> stacks.', 'Gain <solar/>Scorch stacks.'],
  [
    'multi-word text',
    'Creates a <void Void Breach /> on kill.',
    'Creates a <void/>Void Breach on kill.',
  ],
  ...elementTagNames.map((element): [string, string, string] => [
    `element ${element}`,
    `Deals <${element} ${element} damage />.`,
    `Deals <${element}/>${element} damage.`,
  ]),
  ['pve line', '<pve/>Applies <arc Jolt /> to targets.', '<pve/>Applies <arc/>Jolt to targets.'],
  ['pvp line', '<pvp/><stasis Slow /> for 2s', '<pvp/><stasis/>Slow for 2s'],
  ['yellow line', '<yellow/>Grants <strand Woven Mail />.', '<yellow/>Grants <strand/>Woven Mail.'],
  [
    'title body',
    'title Info (\nApplies <stasis Slow /> stacks.\n)\nSee <title details [Info] />.',
    'title Info (\nApplies <stasis/>Slow stacks.\n)\nSee <title details [Info] />.',
  ],
  [
    'export (import) block',
    'export Main (\nSuspends with <strand Suspend />.\n)\nimport Main from self',
    'export Main (\nSuspends with <strand/>Suspend.\n)\nimport Main from self',
  ],
  [
    'enhanced section',
    'Base text.\nenhanced (\n🡅 Longer <solar Radiant /> duration.\n)',
    'Base text.\nenhanced (\n🡅 Longer <solar/>Radiant duration.\n)',
  ],
  [
    'table cell',
    '< table wide >\n| <arc Amplified /> | 10%\n<$>',
    '< table wide >\n| <arc/>Amplified | 10%\n<$>',
  ],
  ['adjacent standalone icon', 'Gain <solar/><solar Scorch />.', 'Gain <solar/><solar/>Scorch.'],
  ['spaced text', 'Gain <solar  Scorch  /> stacks.', 'Gain <solar/> Scorch  stacks.'],
  [
    'unicode',
    'Verursacht <arc Blitz – Überladung 雷 /> Schaden.',
    'Verursacht <arc/>Blitz – Überladung 雷 Schaden.',
  ],
  [
    'several on one line',
    '<void Volatile /> and <solar Scorch /> and <arc Jolt />',
    '<void/>Volatile and <solar/>Scorch and <arc/>Jolt',
  ],
  ['tag-like text', 'Use <arc a > b /> here.', 'Use <arc/>a > b here.'],
];

// Today's behaviour, unchanged: not a tagged span.
const invalid: [name: string, text: string][] = [
  ['standalone icon', 'Gain <solar/> stacks.'],
  ['standalone icon with a space', 'Gain <solar /> stacks.'],
  ['empty text', 'Gain <solar  /> stacks.'],
  ['blank text', 'Gain <solar    /> stacks.'],
  ['nested tag', 'Gain <solar Scorch <bold x/> /> stacks.'],
  ['newline', 'Gain <solar Scorch\nstacks />.'],
  ['pipe', 'Gain <solar Scorch | stacks />.'],
  ['brackets', 'Gain <solar Scorch [x] />.'],
  ['open bracket', 'Gain <solar Scorch [x />.'],
  ['close bracket', 'Gain <solar Scorch x] />.'],
  ['unclosed', 'Gain <solar Scorch stacks.'],
  ['not an element', 'Gain <prismatic Transcendence />.'],
  ['colour tag', 'Gain <yellow Scorch />.'],
  ['missing space before close', 'Gain <solar Scorch/>.'],
];

/** What the preview draws, without the tint: icons, links, titles, and merged plain text. */
function rendered(lines: MarkupLine[]): unknown {
  const flatten = (spans: MarkupSpan[]) => {
    const out: MarkupSpan[] = [];
    for (const span of spans) {
      const untinted = span.classNames?.includes('elementText') ? { text: span.text } : span;
      const last = out.at(-1);
      if (last && Object.keys(last).join() === 'text' && Object.keys(untinted).join() === 'text')
        last.text += untinted.text!;
      else out.push({ ...untinted });
    }
    return out.map((span) =>
      span.title ? { ...span, title: rendered(span.title) as MarkupLine[] } : span,
    );
  };
  return lines.map((line) => ({
    ...line,
    linesContent: line.linesContent && flatten(line.linesContent),
    table: line.table?.map((row) => ({
      ...row,
      rowContent: row.rowContent?.map((cell) => ({
        ...cell,
        cellContent: flatten(cell.cellContent),
      })),
    })),
  }));
}

describe('lowerElementTags', () => {
  it.each(fixtures)('%s lowers to the hand-written legacy text', (_, tagged, legacy) => {
    expect(hasElementTags(tagged)).toBe(true);
    expect(lowerElementTags(tagged)).toBe(legacy);
    expect(hasElementTags(legacy)).toBe(false);
  });

  it.each(fixtures)('%s is idempotent', (_, tagged) => {
    const lowered = lowerElementTags(tagged);
    expect(lowerElementTags(lowered)).toBe(lowered);
  });

  it.each([...fixtures.map(([name, , legacy]) => [name, legacy]), ...invalid])(
    '%s without tagged spans comes back as the same string',
    (_, text) => {
      expect(hasElementTags(text)).toBe(false);
      expect(Object.is(lowerElementTags(text), text)).toBe(true);
    },
  );

  it('finds each span with its source range', () => {
    const text = 'a <solar Scorch /> b <arc Jolt />';
    expect(findElementTags(text)).toEqual([
      { element: 'solar', text: 'Scorch', from: 2, to: 18 },
      { element: 'arc', text: 'Jolt', from: 21, to: 33 },
    ]);
  });
});

describe('element-tagged spans in the parser', () => {
  it('draws the icon, then the text in the element tint', () => {
    expect(parseMarkup('Gain <solar Scorch /> stacks.')).toEqual({
      lines: [
        {
          classNames: [],
          linesContent: [
            { text: 'Gain ' },
            { classNames: ['solar'] },
            { text: 'Scorch', classNames: ['elementText', 'solar'] },
            { text: ' stacks.' },
          ],
        },
      ],
      diagnostics: [],
    });
  });

  it.each(fixtures)('%s renders like its lowered text, minus the tint', (_, tagged, legacy) => {
    // The enhanced type keeps `enhanced (` sections in the preview.
    const globals = { variables: '', titles: '', type: enhancedMarkupType };
    const parsedTagged = parseMarkup(tagged, globals);
    const parsedLegacy = parseMarkup(legacy, globals);
    expect(parsedTagged.diagnostics).toEqual(parsedLegacy.diagnostics);
    expect(rendered(parsedTagged.lines)).toEqual(rendered(parsedLegacy.lines));
    expect(JSON.stringify(parsedTagged.lines)).toContain('elementText');
  });

  it.each(invalid)('%s parses as today', (_, text) => {
    expect(JSON.stringify(parseMarkup(text))).not.toContain('elementText');
  });

  it('keeps the stray-tag diagnostic for invalid forms that had it', () => {
    for (const text of [
      'Gain <solar Scorch <bold x/> /> stacks.',
      'Gain <solar Scorch\nstacks />.',
      'Gain <solar Scorch stacks.',
    ]) {
      expect(parseMarkup(text).diagnostics.map(({ message }) => message)).toEqual([
        expect.stringContaining('Unclosed or unknown tag "<solar"'),
      ]);
    }
  });

  it('keeps today drawing an invalid wrapper as the bare icon', () => {
    expect(parseMarkup('Gain <solar Scorch [x] />.').lines[0].linesContent).toEqual([
      { text: 'Gain ' },
      { classNames: ['solar'] },
      { text: '.' },
    ]);
  });
});
