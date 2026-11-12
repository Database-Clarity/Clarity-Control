import { describe, expect, it } from 'vitest';
import {
  elementTagNames,
  findElementTags,
  hasElementTags,
  lowerElementTags,
} from './elementTags.js';
import { database } from '../../test/helpers.js';
import { exportLegacy } from '../exportLegacy.js';
import { migrateLegacy } from '../migrateLegacy.js';
import { enhancedMarkupType } from './baseEnhanced.js';
import { parseMarkup, reservedMarkerMessage } from './parse.js';
import type { MarkupGlobals, MarkupLine, MarkupSpan } from './types.js';

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

describe('assembled wrappers keep their old meaning; written spans render tagged', () => {
  const hasTint = (parsed: ReturnType<typeof parseMarkup>) =>
    JSON.stringify(parsed.lines).includes('elementText');
  // Output review repros: preparation assembles `<solar Scorch />`, which lowering (per source
  // document) never sees, so it must keep today's meaning: the bare icon, as consumers draw it.
  it.each([
    ['local variable', 'var open = <solar\n#open Scorch />'],
    ['carriage return', '<so\rlar Scorch />'],
    ['comment', '<so/* comment */lar Scorch />'],
    ['line tag', '<so<pve/>lar Scorch />'],
    // Code review repros.
    ['line tag inside the wrapper', 'Gain <solar Scorch<pve/> />'],
    ['comment inside the text', 'Gain <solar Sco/*<*/rch />'],
    ['carriage return inside the text', 'Gain <solar Sco\rrch />'],
  ])('%s assembling a wrapper parses as today', (_, text) => {
    const parsed = parseMarkup(text);
    expect(hasTint(parsed)).toBe(false);
    expect(hasElementTags(text)).toBe(false);
    expect(JSON.stringify(parsed.lines)).toContain('"classNames":["solar"]');
  });

  it('a global variable or an import that assembles a wrapper parses as today', () => {
    expect(
      hasTint(parseMarkup('#open Scorch />', { variables: 'var open = <solar', titles: '' })),
    ).toBe(false);
    expect(
      hasTint(
        parseMarkup('import Main from 123 Scorch />', {
          variables: '',
          titles: '',
          imports: { '123': 'export Main (\n<solar\n)' },
        }),
      ),
    ).toBe(false);
  });

  it('a tagged span written in a variable, a global, a title, or an import renders tagged', () => {
    expect(hasTint(parseMarkup('var hit = <arc Jolt />\nApplies #hit.'))).toBe(true);
    expect(
      hasTint(parseMarkup('Applies #hit.', { variables: 'var hit = <arc Jolt />', titles: '' })),
    ).toBe(true);
    expect(
      hasTint(
        parseMarkup('See <title more [Info] />.', {
          variables: '',
          titles: 'title Info (\n<void Volatile />\n)',
        }),
      ),
    ).toBe(true);
    expect(
      hasTint(
        parseMarkup('import Main from 123', {
          variables: '',
          titles: '',
          imports: { '123': 'export Main (\n<strand Sever />\n)' },
        }),
      ),
    ).toBe(true);
  });
});

describe('preview equals the lowered form plus the tint, through preparation', () => {
  const enhanced = { variables: '', titles: '', type: enhancedMarkupType };
  // Code and output review round 2: authored spans whose text changes in preparation.
  const cases: [name: string, text: string, globals?: MarkupGlobals][] = [
    ['local variable in the text', 'var hit = Scorch\nGain <solar #hit />.'],
    [
      'global variable in the text',
      'Gain <solar #hit />.',
      { variables: 'var hit = Scorch', titles: '' },
    ],
    ['native base/enhanced pair', 'Gain <solar {{Scorch}{Radiant}} />.'],
    ['native pair, enhanced arm', 'Gain <solar {{Scorch}{Radiant}} />.', enhanced],
    ['arithmetic', 'Gain <solar ${2+2} /> stacks.'],
    ['comment inside the text', 'Gain <solar Sco/* hi */rch />.'],
    [
      'title body with a variable',
      'var hit = Jolt\nSee <title more [Info] />.\ntitle Info (\nApplies <arc #hit />.\n)',
    ],
    [
      'numeric import',
      'import Main from 123',
      {
        variables: '',
        titles: '',
        imports: { '123': 'export Main (\nApplies <void #hit />.\n)\nvar hit = Volatile' },
      },
    ],
    ['trailing space at the line end', 'Gain <solar Scorch  />\nNext'],
    ['table cell', '< table wide >\n| <arc Amplified  /> | 10%\n<$>'],
  ];
  it.each(cases)('%s', (_, text, globals) => {
    const lowered: MarkupGlobals | undefined = globals && {
      ...globals,
      variables: lowerElementTags(globals.variables),
      titles: lowerElementTags(globals.titles),
      imports:
        globals.imports &&
        Object.fromEntries(
          Object.entries(globals.imports).map(([key, value]) => [key, lowerElementTags(value)]),
        ),
    };
    const tagged = parseMarkup(text, globals);
    const legacy = parseMarkup(lowerElementTags(text), lowered);
    expect(JSON.stringify(tagged.lines)).toContain('elementText');
    expect(rendered(tagged.lines)).toEqual(rendered(legacy.lines));
    expect(tagged.diagnostics).toEqual(legacy.diagnostics);
    expect(JSON.stringify(tagged)).not.toMatch(/[\uE000\uE001]/);
  });

  it('an unrelated literal (here in a comment) never tints an assembled wrapper', () => {
    const text = '// <solar Scorch />\nvar open = <solar\n#open Scorch />';
    expect(JSON.stringify(parseMarkup(text).lines)).not.toContain('elementText');
    expect(parseMarkup(text).lines).toEqual(
      parseMarkup('var open = <solar\n#open Scorch />').lines,
    );
  });

  it('refuses the preview markers in authored text, in the text or a document it reads', () => {
    for (const [text, globals] of [
      ['Gain \uE000Scorch\uE001.', undefined],
      ['Gain #hit.', { variables: 'var hit = \uE000x', titles: '' }],
    ] as const) {
      const parsed = parseMarkup(text, globals);
      expect(parsed.diagnostics).toContainEqual({
        severity: 'error',
        message: reservedMarkerMessage,
      });
      expect(JSON.stringify(parsed.lines)).not.toMatch(/[\uE000\uE001]/);
    }
    expect(parseMarkup('Gain Scorch.').diagnostics).toEqual([]);
  });
});

describe('preview markers never leave the parser', () => {
  // Nothing is stripped before these checks: the markers must simply never appear.
  const markers = /[\uE000\uE001]/;
  it('over every live description, parsed lines and the legacy export hold no marker', () => {
    const tooltips = migrateLegacy(database('live'));
    const imports: Record<string, string> = {};
    for (const tooltip of tooltips) {
      const text = tooltip.text.en?.text;
      if (text !== undefined) imports[String(tooltip.hash)] = text;
    }
    const globals = { variables: imports['2'] ?? '', titles: imports['3'] ?? '', imports };
    let parsed = 0;
    for (const tooltip of tooltips) {
      const text = tooltip.text.en?.text;
      if (text === undefined) continue;
      for (const type of [undefined, enhancedMarkupType]) {
        expect(markers.test(JSON.stringify(parseMarkup(text, { ...globals, type })))).toBe(false);
        parsed++;
      }
    }
    expect(parsed).toBeGreaterThan(4000);
    expect(markers.test(JSON.stringify(exportLegacy(tooltips, 0)))).toBe(false);
  });

  it('tagged fixtures: the parse and the export hold no marker; the export keeps the authored text', () => {
    const tagged = fixtures.map(([, text], index) => ({
      hash: 1000 + index,
      associated: [],
      text: { en: { text, updatedAt: '2026-01-01T00:00:00.000Z', updatedBy: 'a' } },
    }));
    for (const { text } of tagged)
      expect(markers.test(JSON.stringify(parseMarkup(text.en.text)))).toBe(false);
    const exported = JSON.stringify(exportLegacy(tagged, 0));
    expect(markers.test(exported)).toBe(false);
  });
});
