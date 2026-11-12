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
    // Table cells spell plain text with undefined classNames and title keys.
    const plain = (span: MarkupSpan) =>
      span.text !== undefined &&
      Object.entries(span).every(([key, field]) => key === 'text' || field === undefined);
    for (const span of spans) {
      const untinted = span.classNames?.includes('elementText') ? { text: span.text } : span;
      const last = out.at(-1);
      if (last && plain(last) && plain(untinted))
        out[out.length - 1] = { text: last.text! + untinted.text! };
      else out.push(plain(untinted) ? { text: untinted.text } : { ...untinted });
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

describe('preview equals the lowered form, tinted only for plain tagged text', () => {
  const enhanced = { variables: '', titles: '', type: enhancedMarkupType };
  // Code and output review round 2: authored spans whose text changes in preparation. Text with
  // a variable, arithmetic, a native pair, or a comment draws the icon without the tint.
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
  it.each(cases)('%s', (name, text, globals) => {
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
    const plain = name.startsWith('trailing') || name.startsWith('table');
    expect(JSON.stringify(tagged.lines).includes('elementText')).toBe(plain);
    if (!plain) expect(tagged.lines).toEqual(legacy.lines);
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

describe('markers never change how preparation reads the lowered text', () => {
  // Output review round 3: the close marker split a variable name (`#hit` + `tail` lowers to
  // `#hittail`), and a marker before trailing spaces defeated declaration trimming.
  const lowerAll = (globals: MarkupGlobals): MarkupGlobals => ({
    ...globals,
    variables: lowerElementTags(globals.variables),
    titles: lowerElementTags(globals.titles),
    imports:
      globals.imports &&
      Object.fromEntries(
        Object.entries(globals.imports).map(([key, value]) => [key, lowerElementTags(value)]),
      ),
  });
  const same = (text: string, globals: MarkupGlobals) => {
    const preview = parseMarkup(text, globals);
    const legacy = parseMarkup(lowerElementTags(text), lowerAll(globals));
    expect(rendered(preview.lines)).toEqual(rendered(legacy.lines));
    expect(preview.diagnostics).toEqual(legacy.diagnostics);
    return preview;
  };
  const plain = { variables: '', titles: '' };
  it.each(elementTagNames)('a variable name continued after the tag (%s)', (element) => {
    for (const type of [undefined, enhancedMarkupType]) {
      const g = { ...plain, type };
      same(`var hit = Scorch\nvar hittail = Other\nGain <${element} #hit />tail.`, g);
      same(`var hit = Scorch\nGain <${element} #hit />tail.`, g);
      same(`Gain <${element} #hit />tail.`, { ...g, variables: 'var hit = A\nvar hittail = B' });
    }
  });
  it.each([
    ['local', 'var X = <solar Word  />\nGain #X after.', plain],
    ['CRLF', 'var X = <solar Word  />\r\nGain #X after.', plain],
    ['repeated', 'var X = <solar Word  />\nGain #X#X after.', plain],
    ['global', 'Gain #X after.', { variables: 'var X = <solar Word  />', titles: '' }],
    [
      'title',
      'See <title more [T] />.',
      { variables: '', titles: 'title T (\nGain <arc Word  /> after.\n)' },
    ],
    [
      'import',
      'import Main from 124',
      { ...plain, imports: { '124': 'export Main (\nvar X = <void Word  />\nGain #X after.\n)' } },
    ],
    ['native base arm', 'var X = {{<solar Word  />}{<solar Other  />}}\nGain #X after.', plain],
    [
      'native enhanced arm',
      'var X = {{<solar Word  />}{<solar Other  />}}\nGain #X after.',
      { ...plain, type: enhancedMarkupType },
    ],
  ] as [string, string, MarkupGlobals][])(
    'declaration trimming keeps working: %s',
    (_, text, globals) => {
      same(text, globals);
    },
  );
  it('keeps the tint whenever preparation reads the text the same way', () => {
    const preview = same('var X = <solar Word  />\nGain #X after.', plain);
    expect(JSON.stringify(preview.lines)).toContain('elementText');
  });
});

describe('tagged text through a variable, arithmetic, a nested tag, or a comment: icon, no tint', () => {
  // Code review round 3 and output review round 3 counterexamples. Root ruling 13:4x: such text
  // draws the icon without the tint; the text is exactly the lowered form's.
  const lowerAll = (globals: MarkupGlobals): MarkupGlobals => ({
    ...globals,
    variables: lowerElementTags(globals.variables),
    titles: lowerElementTags(globals.titles),
  });
  const plain = { variables: '', titles: '' };
  const tints = (lines: MarkupLine[]) => JSON.stringify(lines).match(/"elementText","\w+"/g) ?? [];
  it.each([
    ['variable boundary', 'var xs = Scorches\nGain <solar #x />s.', plain, []],
    ['variable continued after the tag', 'var hit = Scorch\nGain <solar #hit />tail.', plain, []],
    ['global variable', 'Gain <arc #hit />.', { variables: 'var hit = Jolt', titles: '' }, []],
    ['block comment the next text completes', 'Gain <solar / />* hidden */next.', plain, []],
    ['line comment the next text completes', 'Gain <solar a / />/ hidden', plain, []],
    ['comment inside', 'Gain <solar Sco/* hi */rch />.', plain, []],
    ['arithmetic crossing the end', 'Gain <solar ${2+2 />} stacks.', plain, []],
    ['arithmetic inside', 'Gain <solar ${2+2} /> stacks.', plain, []],
    ['native pair', 'Gain <solar {{Scorch}{Radiant}} />.', plain, []],
    // The nested tag keeps its own tint; the tag around it draws only its icon.
    ['nested tag', 'var x = <arc Jolt />\nGain <solar a #x b />.', plain, ['"elementText","arc"']],
  ] as [string, string, MarkupGlobals, string[]][])('%s', (_, text, globals, tinted) => {
    const preview = parseMarkup(text, globals);
    const legacy = parseMarkup(lowerElementTags(text), lowerAll(globals));
    expect(tints(preview.lines)).toEqual(tinted);
    expect(rendered(preview.lines)).toEqual(rendered(legacy.lines));
    expect(preview.diagnostics).toEqual(legacy.diagnostics);
    const element = /<(\w+) /.exec(text.slice(text.indexOf('Gain')))![1];
    expect(JSON.stringify(preview.lines)).toContain(`{"classNames":["${element}"]}`);
    expect(JSON.stringify(preview)).not.toMatch(/[\uE000\uE001]/);
  });
  it('the reviewed texts render exactly as the lowered form', () => {
    const text = (lines: MarkupLine[]) =>
      lines.map((line) => line.linesContent?.map((span) => span.text ?? '').join('')).join('\n');
    expect(text(parseMarkup('var xs = Scorches\nGain <solar #x />s.').lines)).toBe(
      'Gain Scorches.',
    );
    expect(text(parseMarkup('Gain <solar / />* hidden */next.').lines)).toBe('Gain next.');
    expect(text(parseMarkup('Gain <solar ${2+2 />} stacks.').lines)).toBe('Gain 4 stacks.');
    expect(text(parseMarkup('var x = <arc Jolt />\nGain <solar a #x b />.').lines)).toBe(
      'Gain a Jolt b.',
    );
  });
  it('plain keywords keep the tint, also through a variable that holds the tag', () => {
    expect(tints(parseMarkup('Gain <solar Scorch /> and <arc Jolt />.').lines)).toEqual([
      '"elementText","solar"',
      '"elementText","arc"',
    ]);
    expect(tints(parseMarkup('var x = <solar Scorch  />\nGain #x stacks.').lines)).toEqual([
      '"elementText","solar"',
    ]);
  });
});

describe('plain keywords in tables keep the tint', () => {
  // Code review round 4: cell spans carry undefined classNames and title keys, which the
  // untinted comparison did not treat as plain text, so every table dropped all tint.
  const tints = (lines: MarkupLine[]) => JSON.stringify(lines).match(/"elementText","\w+"/g) ?? [];
  const lowered = (globals: MarkupGlobals): MarkupGlobals => ({
    ...globals,
    variables: lowerElementTags(globals.variables),
    titles: lowerElementTags(globals.titles),
    imports:
      globals.imports &&
      Object.fromEntries(
        Object.entries(globals.imports).map(([key, value]) => [key, lowerElementTags(value)]),
      ),
  });
  const check = (text: string, globals: MarkupGlobals, expected: string[]) => {
    const preview = parseMarkup(text, globals);
    const legacy = parseMarkup(lowerElementTags(text), lowered(globals));
    expect(tints(preview.lines)).toEqual(expected);
    expect(rendered(preview.lines)).toEqual(rendered(legacy.lines));
    expect(preview.diagnostics).toEqual(legacy.diagnostics);
  };
  const plain = { variables: '', titles: '' };
  it.each(elementTagNames)('a keyword followed by text in a cell (%s)', (element) => {
    check(`< table wide >\n| <${element} Word /> stacks | 10%\n<$>`, plain, [
      `"elementText","${element}"`,
    ]);
  });
  it('a table in a title and in an import', () => {
    check(
      'See <title more [T] />.',
      {
        variables: '',
        titles: 'title T (\n< table wide >\n| <arc Amplified /> stacks | 10%\n<$>\n)',
      },
      ['"elementText","arc"'],
    );
    check(
      'import Main from 125',
      {
        ...plain,
        imports: { '125': 'export Main (\n< table wide >\n| <void Volatile /> rounds | 2\n<$>\n)' },
      },
      ['"elementText","void"'],
    );
  });
  it('a document mixing ordinary lines and a table keeps every tint', () => {
    check(
      'Gain <solar Scorch /> stacks.\n< table wide >\n| <arc Amplified /> stacks | 10%\n<$>\nThen <strand Sever />.',
      plain,
      ['"elementText","solar"', '"elementText","arc"', '"elementText","strand"'],
    );
  });
  // Code review round 4b: spaces the markers split off became whitespace-only cell spans, which
  // tables drop, so the comparison fell back to the untinted render for the whole document.
  const cells: [name: string, cell: string][] = [
    ['leading spaces', 'before <EL  Word /> stacks'],
    ['leading spaces at the cell start', '<EL   Word /> stacks'],
    ['a tab before the text', 'before <EL \tWord /> stacks'],
    ['spaces before the next icon', 'before <EL Word  /><pve/> stacks'],
    ['two tags, spaces between', '<EL  Word  /> <EL  Other /> end'],
    ['spaces both sides, cell end', 'x <EL   Word   />'],
  ];
  it.each(elementTagNames.flatMap((element) => cells.map(([name, cell]) => [element, name, cell])))(
    'spaces around the text in a cell (%s, %s)',
    (element, _, cell) => {
      const text = `< table wide >\n| ${cell.replaceAll('EL', element)} | 10%\n<$>`;
      const count = cell.split('<EL').length - 1;
      for (const type of [undefined, enhancedMarkupType])
        check(text, { ...plain, type }, Array(count).fill(`"elementText","${element}"`));
    },
  );
  it('leading spaces in tables of titles, imports, and mixed documents keep every tint', () => {
    const table = (element: string) => `< table wide >\n| a <${element}  Word /> b | 1\n<$>`;
    check('See <title more [T] />.', { ...plain, titles: `title T (\n${table('arc')}\n)` }, [
      '"elementText","arc"',
    ]);
    check(
      'import Main from 126',
      { ...plain, imports: { '126': `export Main (\n${table('void')}\n)` } },
      ['"elementText","void"'],
    );
    check(`Gain <solar Scorch /> stacks.\n${table('arc')}\r\nThen <void Volatile />.`, plain, [
      '"elementText","solar"',
      '"elementText","arc"',
      '"elementText","void"',
    ]);
  });
  it('ordinary lines keep spaces around tinted text exactly', () => {
    for (const text of [
      'Gain <arc  Word /> stacks.',
      'Gain <arc Word  /><pve/> stacks.',
      'Gain <arc  Word  /> <solar  Other /> end',
    ])
      check(
        text,
        plain,
        (text.match(/<(arc|solar) /g) ?? []).map((tag) => `"elementText","${tag.slice(1, -1)}"`),
      );
  });
});
