import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { parseMarkup, type MarkupLine } from '@clarity/core/markup/parse';
import { describe, expect, test } from 'vitest';
import {
  bungieIdentical,
  type InventoryItems,
  compile,
  compileStages,
  decodeV1,
  isValidId,
  legacyPresets,
  newStyleFile,
  projectIndex,
  styleFormats,
  styles,
  symbolIds,
  validateV1,
  type Catalog,
  type ExportConfig,
  type LegacyInput,
  type StyleFile,
} from '../src/index.js';
import { configSchema, immutableChanges, migrateConfig, unknownCategories } from '../src/config.js';
import { emptyNotes, transform } from '../src/v1/transform.js';
import { editorDataInput, expected, fixtureInput, liveInput, sha256 } from './helpers.js';

// Config edits for the rejection table; the shapes are checked by the schema under test.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = any;
const decoder = new TextDecoder();
const json = (bytes: Uint8Array) => JSON.parse(decoder.decode(bytes));

// ---------------------------------------------------------------- small inputs
const perk = (hash: number, main: string, extra: Record<string, unknown> = {}) => ({
  hash,
  name: `Perk ${hash}`,
  type: 'Weapon Perk',
  uploadedBy: 'test',
  lastUpload: 1,
  updateTracker: { descriptions: { en: { lastUpdate: 5, updatedBy: 'a' } } },
  editor: { en: { main, secondary: main } },
  inLiveDatabase: true,
  uploadToLive: true,
  ...extra,
});
const globalsRows = {
  1: perk(1, 'export Shared (\nfrom global\n)'),
  2: perk(2, 'var C = 5'),
  3: perk(3, 'title Help (\nHelp text\n)'),
};
const catalog: Catalog = {
  categories: [
    { id: 'weapon-trait' },
    { id: 'weapon-trait-enhanced' },
    { id: 'verbs' },
    { id: 'armor-trait-exotic' },
    { id: 'weapon-frame' },
  ],
  items: {
    100: { categoryId: 'armor-trait-exotic' },
    101: { categoryId: 'verbs' },
    102: { categoryId: 'verbs' },
    200: { categoryId: 'weapon-trait' },
    201: { categoryId: 'weapon-trait-enhanced' },
    300: { categoryId: 'weapon-frame' },
    301: { categoryId: 'weapon-frame' },
    400: { categoryId: 'weapon-trait' },
  },
};
const refsInput = {
  perks: {
    ...globalsRows,
    100: perk(100, 'Exotic <arc/>uses #C <bold verbs />', {
      associated: [101, 102],
      type: 'Armor Trait Exotic',
    }),
    101: perk(101, 'Verb one\nimport main from 400'),
    102: perk(102, 'Verb two'),
    200: perk(200, 'Trait {{base}{enhanced}} 🡅', { type: 'Weapon Trait' }),
    201: {
      hash: 201,
      aliasOf: 200,
      aliasKind: 'frame',
      name: 'Trait Enhanced',
      type: 'Weapon Trait Enhanced',
    },
    250: { hash: 250, aliasOf: 200, aliasKind: 'sandbox' },
    300: perk(300, 'Frame <link Docs [https://x.example] /> <title Help [Help] />', {
      type: 'Weapon Frame',
    }),
    301: { hash: 301, aliasOf: 300, aliasKind: 'frame', name: 'Frame alias', type: 'Weapon Frame' },
    400: perk(400, 'Imported body\nimport Shared from global'),
    500: perk(500, 'No catalog item'),
  },
} as unknown as LegacyInput;

const file = (
  patch: Partial<StyleFile['data']> = {},
  style: (typeof styles)[number] = 'structured',
  shape?: 'lines' | 'text',
) =>
  newStyleFile(
    'main',
    style,
    {
      categories: [
        'armor-trait-exotic',
        'verbs',
        'weapon-trait',
        'weapon-trait-enhanced',
        'weapon-frame',
      ],
      sandboxPerks: ['weapon-trait'],
      frameAliases: true,
      languages: ['en'],
      keys: ['name', 'associated'],
      bungieIdentical: false,
      ...patch,
    },
    shape,
  );

const text = (plan: ReturnType<typeof compile>, hash: number) =>
  plan.expanded![hash]?.descriptions.en;

// ---------------------------------------------------------------- AC1 schema
const validConfig = (): ExportConfig => ({
  schema: 1,
  id: 'dim',
  name: 'Destiny Item Manager',
  files: [file(), { id: 'legacy', formatVersion: 1, preset: 'dim' }],
});

describe('config schema 1 (AC1)', () => {
  test('accepts every style in both shapes and every legacy preset', () => {
    for (const style of styles) {
      for (const shape of ['lines', 'text'] as const) {
        expect(() =>
          configSchema.parse({ ...validConfig(), files: [file({}, style, shape)] }),
        ).not.toThrow();
      }
    }
    for (const preset of legacyPresets) {
      expect(() =>
        configSchema.parse({ ...validConfig(), files: [{ id: 'old', formatVersion: 1, preset }] }),
      ).not.toThrow();
    }
  });

  test.each([
    ['unknown top-level key', (c: Loose) => ({ ...c, extra: 1 })],
    ['unknown file key', (c: Loose) => ({ ...c, files: [{ ...c.files[0], extra: 1 }] })],
    [
      'unknown data key',
      (c: Loose) => ({ ...c, files: [{ ...c.files[0], data: { ...c.files[0].data, x: 1 } }] }),
    ],
    [
      'unknown format key',
      (c: Loose) => ({
        ...c,
        files: [{ ...c.files[0], format: { ...c.files[0].format, weaponSections: 'labelled' } }],
      }),
    ],
    [
      'unknown symbol',
      (c: Loose) => ({
        ...c,
        files: [
          { ...c.files[0], format: { ...c.files[0].format, symbols: { blue: { mode: 'keep' } } } },
        ],
      }),
    ],
    ['__proto__ key', (c: Loose) => JSON.parse(JSON.stringify(c).replace('{', '{"__proto__":{},'))],
    [
      '__proto__ symbol',
      (c: Loose) => ({
        ...c,
        files: [
          {
            ...c.files[0],
            format: { ...c.files[0].format, symbols: JSON.parse('{"__proto__":{"mode":"keep"}}') },
          },
        ],
      }),
    ],
    [
      'extra key in a rule',
      (c: Loose) => ({
        ...c,
        files: [
          {
            ...c.files[0],
            format: { ...c.files[0].format, symbols: { bold: { mode: 'drop', before: 'x' } } },
          },
        ],
      }),
    ],
    [
      'four files',
      (c: Loose) => ({
        ...c,
        files: [0, 1, 2, 3].map((n) => ({ id: `f${n}x`, formatVersion: 1, preset: 'dim' })),
      }),
    ],
    ['duplicate file ids', (c: Loose) => ({ ...c, files: [c.files[1], c.files[1]] })],
    [
      'legacy preset with data',
      (c: Loose) => ({ ...c, files: [{ ...c.files[1], data: c.files[0].data }] }),
    ],
    ['format version 2', (c: Loose) => ({ ...c, files: [{ ...c.files[1], formatVersion: 2 }] })],
    ['schema 2', (c: Loose) => ({ ...c, schema: 2 })],
    ['path traversal id', (c: Loose) => ({ ...c, id: '../dim' })],
    ['reserved id', (c: Loose) => ({ ...c, id: 'index' })],
    ['v1 as id', (c: Loose) => ({ ...c, files: [{ ...c.files[1], id: 'v1' }] })],
    ['name over 64 characters', (c: Loose) => ({ ...c, name: 'x'.repeat(65) })],
    [
      'control character',
      (c: Loose) => ({
        ...c,
        files: [
          {
            ...c.files[0],
            format: {
              ...c.files[0].format,
              symbols: { bold: { mode: 'replace', before: '\n', after: '' } },
            },
          },
        ],
      }),
    ],
    [
      'keep in the text shape',
      (c: Loose) => ({
        ...c,
        files: [
          {
            ...file({}, 'markdown'),
            format: { ...file({}, 'markdown').format, symbols: { bold: { mode: 'keep' } } },
          },
        ],
      }),
    ],
    [
      'no languages',
      (c: Loose) => ({
        ...c,
        files: [{ ...c.files[0], data: { ...c.files[0].data, languages: [] } }],
      }),
    ],
    [
      'duplicate language',
      (c: Loose) => ({
        ...c,
        files: [{ ...c.files[0], data: { ...c.files[0].data, languages: ['en', 'en'] } }],
      }),
    ],
    [
      'unknown key name',
      (c: Loose) => ({
        ...c,
        files: [{ ...c.files[0], data: { ...c.files[0].data, keys: ['stats'] } }],
      }),
    ],
  ])('rejects %s', (_name, change) => {
    expect(configSchema.safeParse(change(structuredClone(validConfig()))).success).toBe(false);
  });

  test('ids are path-safe', () => {
    expect(['dim', 'light-gg', 'a1'].every(isValidId)).toBe(true);
    expect(
      ['_build', 'changelog', 'well-known', 'v12', 'Dim', 'a', 'a/b', '..', 'x'.repeat(33)].some(
        isValidId,
      ),
    ).toBe(false);
  });

  test('every row of every style stays customisable: each symbol can be kept, dropped, or replaced', () => {
    for (const style of styles) {
      const base = file({}, style, 'lines');
      for (const symbol of symbolIds) {
        for (const rule of [
          { mode: 'keep' },
          { mode: 'drop' },
          { mode: 'replace', before: '<', after: '>' },
        ]) {
          const changed = {
            ...base,
            format: { ...base.format, symbols: { ...base.format.symbols, [symbol]: rule } },
          };
          expect(configSchema.safeParse({ ...validConfig(), files: [changed] }).success).toBe(true);
        }
      }
    }
  });

  test('URL slots: active files plus retained entries stay within 6, 2 retained per file', () => {
    const entry = (n: number, uid = 'abcdefgh') => ({
      path: `dim/v1/old${n}.json`,
      uid,
      formatVersion: 1,
      snapshot: { id: `old${n}`, formatVersion: 1, preset: 'dim' },
      until: '2027-02-11T00:00:00Z',
    });
    const config = {
      ...validConfig(),
      retained: [entry(1), entry(2, 'bcdefghi'), entry(3, 'cdefghij'), entry(4, 'defghijk')],
    };
    expect(configSchema.safeParse(config).success).toBe(true);
    expect(
      configSchema.safeParse({ ...config, retained: [...config.retained, entry(5, 'efghijkl')] })
        .success,
    ).toBe(false);
    expect(
      configSchema.safeParse({ ...config, retained: [entry(1), entry(2), entry(3)] }).success,
    ).toBe(false);
  });

  test('migration hook n -> n+1: applied in order, then validated; newer or unmigratable schemas throw', () => {
    const v0 = { ...validConfig(), schema: 0 };
    expect(() => migrateConfig(v0)).toThrow(/positive integer/);
    expect(migrateConfig(validConfig())).toEqual(configSchema.parse(validConfig()));
    expect(() => migrateConfig({ ...validConfig(), schema: 2 })).toThrow(/newer/);
    // A schema 1 -> 2 step (renaming `name` to `title`), run against target 2.
    const table = {
      1: ({ name, ...rest }: Record<string, unknown>) => ({ ...rest, title: name, schema: 2 }),
    };
    const migrated = migrateConfig(validConfig(), table, 2) as unknown as Record<string, unknown>;
    expect(migrated.schema).toBe(2);
    expect(migrated.title).toBe('Destiny Item Manager');
    expect(() => migrateConfig(validConfig(), {}, 2)).toThrow(/No migration/);
    expect(() => migrateConfig(validConfig(), { 1: (c) => c }, 2)).toThrow(/must produce schema 2/);
    expect(() => migrateConfig([])).toThrow();
  });

  test('immutable ids and server-owned parts, unknown categories are a notice', () => {
    const before = configSchema.parse({
      ...validConfig(),
      files: [{ ...file(), uid: 'abcdefgh' }],
    });
    expect(immutableChanges(before, { ...before, id: 'other' })).toHaveLength(1);
    expect(
      immutableChanges(before, { ...before, files: [{ ...file(), uid: 'zzzzzzzz' }] }),
    ).toContain('File main has a uid the server did not assign');
    expect(
      immutableChanges(before, {
        ...before,
        files: [{ ...file(), id: 'renamed', uid: 'abcdefgh' }],
      }),
    ).toEqual([]);
    expect(immutableChanges(before, { ...before, retained: [] })).toEqual([]);
    expect(unknownCategories(validConfig(), ['verbs'])).toEqual([
      'armor-trait-exotic',
      'weapon-frame',
      'weapon-trait',
      'weapon-trait-enhanced',
    ]);
  });
});

// ---------------------------------------------------------------- AC2 stages + references
describe('compiler stages and reference policy (AC2, G-REFS)', () => {
  test('a style runs all 7 stages in order; a legacy preset runs the held path byte for byte', () => {
    expect(compile(refsInput, file(), { catalog }).ran).toEqual([...compileStages]);
    const { input, inventoryItem } = fixtureInput();
    const identical = bungieIdentical(input, inventoryItem as InventoryItems);
    for (const preset of legacyPresets) {
      const plan = compile(input, { id: 'old', formatVersion: 1, preset }, { catalog, identical });
      expect(plan.legacy).toBe(true);
      // The set-bonus type name is the decided cut-over exception (set-bonus.test.ts).
      const text = new TextDecoder().decode(plan.bytes);
      expect(sha256(text.replaceAll('"Armor Set Bonus"', '"armor-set-bonus"'))).toBe(
        expected.fixture.files[preset],
      );
    }
  });

  test('legacy presets refuse base/enhanced pairs; buildLegacy is unchanged', () => {
    expect(() =>
      compile(refsInput, { id: 'old', formatVersion: 1, preset: 'dim' }, { catalog }),
    ).toThrow(/legacy presets refuse/);
  });

  test('category-crossing associations are dropped only when their target is not in the file', () => {
    const both = compile(refsInput, file(), { catalog });
    expect(both.expanded![100].associated).toEqual([101, 102]);
    const only = compile(
      refsInput,
      file({ categories: ['armor-trait-exotic'], sandboxPerks: [] }),
      { catalog },
    );
    expect(only.expanded![100]).not.toHaveProperty('associated');
    expect(Object.keys(only.expanded!)).toEqual(['100']);
  });

  test('sandbox perks are selected by their item category even when the canonical is not', () => {
    const plan = compile(refsInput, file({ categories: [], sandboxPerks: ['weapon-trait'] }), {
      catalog,
    });
    expect(Object.keys(plan.expanded!)).toEqual(['250']);
    const decoded = decodeV1(json(plan.bytes));
    expect(decoded[250].descriptions).toEqual(plan.expanded![250].descriptions);
    const none = compile(refsInput, file({ sandboxPerks: [] }), { catalog });
    expect(none.expanded).not.toHaveProperty('250');
  });

  test('frame aliases of excluded canonicals are their own items; the toggle removes them', () => {
    const plan = compile(
      refsInput,
      file({ categories: ['weapon-trait-enhanced'], sandboxPerks: [] }),
      { catalog },
    );
    expect(Object.keys(plan.expanded!)).toEqual(['201']);
    expect(plan.expanded![201].name).toBe('Trait Enhanced');
    const off = compile(refsInput, file({ frameAliases: false }), { catalog });
    expect(off.expanded).not.toHaveProperty('201');
    expect(off.expanded).not.toHaveProperty('301');
  });

  test('imports across excluded rows and globals still resolve (filters never break imports)', () => {
    const plan = compile(refsInput, file({ categories: ['verbs'] }), { catalog });
    expect(text(plan, 101)).toEqual([
      { linesContent: [{ text: 'Verb one' }] },
      { linesContent: [{ text: 'Imported body' }] },
      { linesContent: [{ text: 'from global' }] },
    ]);
    expect(plan.expanded).not.toHaveProperty('400');
  });

  test('a row with no catalog item or an unknown category is excluded with a notice', () => {
    const plan = compile(refsInput, file(), { catalog });
    expect(plan.expanded).not.toHaveProperty('500');
    expect(plan.notices).toContainEqual({ kind: 'uncategorised', hashes: [500] });
  });

  test('every t index and association resolves; a broken file is refused', () => {
    const plan = compile(refsInput, file(), { catalog });
    expect(() => validateV1(plan.file!)).not.toThrow();
    expect(() => validateV1({ texts: [], items: { 1: { t: 0 } } })).toThrow(/missing text/);
    expect(() => validateV1({ texts: [{}], items: { 1: { t: 0, associated: [2] } } })).toThrow(
      /not in the file/,
    );
  });
});

// ---------------------------------------------------------------- AC3 styles + transforms
describe('styles and symbol transforms (AC3)', () => {
  const sample = (style: (typeof styles)[number], shape?: 'lines' | 'text') =>
    compile(refsInput, file({}, style, shape), { catalog });

  test('structured keeps every symbol, title, and link as structure', () => {
    const plan = sample('structured');
    expect(text(plan, 100)).toEqual([
      {
        linesContent: [
          { text: 'Exotic ' },
          { classNames: ['arc'] },
          { text: 'uses 5 ' },
          { text: 'verbs', classNames: ['bold'] },
        ],
      },
    ]);
    expect(text(plan, 300)).toEqual([
      {
        linesContent: [
          { text: 'Frame ' },
          { text: 'Docs', link: 'https://x.example', classNames: ['link'] },
          { text: ' ' },
          {
            text: 'Help',
            title: [{ linesContent: [{ text: 'Help text' }] }],
            classNames: ['title'],
          },
        ],
      },
    ]);
  });

  test('markdown, discord, and plain', () => {
    expect(text(sample('markdown'), 100)).toBe('Exotic [Arc]uses 5 **verbs**');
    expect(text(sample('discord'), 100)).toBe('Exotic uses 5 **verbs**');
    expect(text(sample('plain'), 100)).toBe('Exotic uses 5 verbs');
    expect(text(sample('markdown'), 300)).toBe('Frame [Docs](https://x.example) Help');
    expect(text(sample('plain'), 300)).toBe('Frame Docs Help');
    expect(text(sample('markdown'), 200)).toBe('Trait base [enh]');
    expect(text(sample('plain'), 200)).toBe('Trait base');
  });

  test('titles inline, line classes, spacers, and absent symbols', () => {
    const base = file({}, 'plain');
    const custom: StyleFile = {
      ...base,
      format: {
        ...base.format,
        titles: { mode: 'inline', pattern: ['', '', ' (', ')'] },
        symbols: { yellow: { mode: 'replace', before: '_', after: '_' } },
        spacer: 'drop',
      },
    };
    const lines = parseMarkup('<yellow/>Line one\n\nSee <title Help [Help] /> <arc/>', {
      variables: '',
      titles: 'title Help (\nInner <bold b />\n)',
    }).lines;
    const notes = emptyNotes();
    expect(transform(lines, custom.format, 'text', notes)).toBe('_Line one_\nSee Help (Inner b)');
    expect([...notes.unchosen].sort()).toEqual(['arc', 'bold']);
    const keepSpacer = { ...custom.format, spacer: 'keep' as const };
    expect(transform(lines, keepSpacer, 'text', emptyNotes())).toBe(
      '_Line one_\n\nSee Help (Inner b)',
    );
    const plan = compile(
      refsInput,
      { ...base, format: { ...base.format, symbols: {} } },
      { catalog },
    );
    expect(plan.notices.find((notice) => notice.kind === 'unchosen-symbol')).toEqual({
      kind: 'unchosen-symbol',
      symbols: ['arc', 'bold', 'enhancedArrow'],
    });
  });

  test('styles only start a file: the compiler reads the file alone', () => {
    const markdown = file({}, 'markdown');
    const asPlain = { ...markdown, format: structuredClone(styleFormats.plain) };
    expect(text(compile(refsInput, asPlain, { catalog }), 100)).toBe('Exotic uses 5 verbs');
  });
});

// ---------------------------------------------------------------- AC5 base/enhanced vs preview
const previewGlobals = (input: LegacyInput, type: string) => {
  const imports: Record<string, string> = {};
  for (const [hash, row] of Object.entries(input.perks)) {
    const target = 'aliasOf' in row ? input.perks[row.aliasOf] : row;
    imports[hash] = (target as { editor: { en?: { main: string } } }).editor.en?.main ?? '';
  }
  return { variables: imports[2], titles: imports[3], imports, type };
};
const all: StyleFile = {
  ...file(),
  format: {
    ...file().format,
    symbols: Object.fromEntries(symbolIds.map((s) => [s, { mode: 'keep' }])),
  },
};
const clean = (lines: MarkupLine[]) => transform(lines, all.format, 'lines', emptyNotes());

describe('base/enhanced pairs resolve per perk exactly as the editor preview (AC5)', () => {
  test('each row picks its own arm: base for the trait and its sandbox perk, enhanced for the enhanced alias', () => {
    const plan = compile(refsInput, file({}, 'plain'), { catalog });
    expect(text(plan, 200)).toBe('Trait base');
    expect(text(plan, 250)).toBe('Trait base');
    expect(text(plan, 201)).toBe('Trait enhanced');
  });

  const cases: [string, Record<number, string>, string][] = [
    ['inline pair', {}, 'Damage {{+10%}{+15%}} #e'],
    ['variables inside arms and around', {}, '{{#C}{20}}suffix and $' + '{{5}{10}} #C'],
    ['math across an arm', {}, '${1+{{2}{3}}}'],
    ['pair in an imported body', { 124: 'Body {{a}{b}}' }, 'Start\nimport main from 124'],
    [
      'nested import of a pair',
      { 124: '{{a}{b}}', 125: 'import main from 124' },
      '#e Other\nimport main from 125',
    ],
    ['pair inside a local title', {}, 'title T (\nInner {{x}{y}}\n)\n<title See [T] />'],
    ['enhanced block next to a pair', {}, 'enhanced (\nOnly enhanced {{p}{q}}\n)\nAlways {{p}{q}}'],
    // Security LOW (base-enh-native-sec-review.md): no raw `{{` anywhere, the pair forms only after
    // the mid-line import is replaced. The preview resolves it; the engine must show the same.
    [
      'mid-line import composes a pair',
      { 5: '{a}{b}}' },
      'x {import main from 5\nimport main from 5',
    ],
  ];
  test.each(cases)('%s', (_name, imports, source) => {
    const rows: Record<string, unknown> = { ...globalsRows };
    for (const [hash, body] of Object.entries(imports)) rows[hash] = perk(Number(hash), body);
    rows[200] = perk(200, source, { type: 'Weapon Trait' });
    rows[201] = {
      hash: 201,
      aliasOf: 200,
      aliasKind: 'frame',
      name: 'E',
      type: 'Weapon Trait Enhanced',
    };
    const input = { perks: rows } as unknown as LegacyInput;
    const items = {
      ...catalog.items,
      5: { categoryId: 'verbs' },
      124: { categoryId: 'verbs' },
      125: { categoryId: 'verbs' },
    };
    const plan = compile(input, all, { catalog: { ...catalog, items } });
    for (const [hash, type] of [
      [200, 'Weapon Trait'],
      [201, 'Weapon Trait Enhanced'],
    ] as const) {
      const preview = parseMarkup(source, previewGlobals(input, type)).lines;
      expect(text(plan, hash)).toEqual(clean(preview));
    }
    expect(JSON.stringify(text(plan, 200))).not.toContain('{{');
  });

  test('the mid-line import case prints the base arm, not literal braces (the preview then imports the line again)', () => {
    const input = {
      perks: {
        ...globalsRows,
        5: perk(5, '{a}{b}}'),
        200: perk(200, 'x {import main from 5\nimport main from 5', { type: 'Weapon Trait' }),
      },
    } as unknown as LegacyInput;
    const plan = compile(input, file({}, 'plain'), {
      catalog: { ...catalog, items: { ...catalog.items, 5: { categoryId: 'verbs' } } },
    });
    expect(text(plan, 200)).toBe('x a\n{a}{b}}');
  });
});

// ---------------------------------------------------------------- determinism, real data, G-SIZE
describe('determinism and real data', () => {
  const realCatalog = JSON.parse(
    gunzipSync(
      readFileSync(new URL('./fixtures/catalog-c3fed8c.json.gz', import.meta.url)),
    ).toString('utf8'),
  ) as Catalog;
  const { input, identical } = editorDataInput();
  const everything = (style: (typeof styles)[number], shape?: 'lines' | 'text') =>
    newStyleFile(
      'all',
      style,
      {
        categories: realCatalog.categories.map((c) => c.id),
        sandboxPerks: realCatalog.categories.map((c) => c.id),
        frameAliases: true,
        languages: [
          'en',
          'de',
          'fr',
          'it',
          'pl',
          'ru',
          'es',
          'es-mx',
          'ko',
          'pt-br',
          'ja',
          'zh-cht',
          'zh-chs',
        ],
        keys: [
          'name',
          'itemHash',
          'itemName',
          'type',
          'lastUpload',
          'uploadedBy',
          'updateTracker',
          'associated',
        ],
        bungieIdentical: false,
      },
      shape,
    );

  test('same input and config give the same bytes, whatever the input key order', () => {
    const a = compile(refsInput, file(), { catalog }).bytes;
    const shuffled = {
      perks: Object.fromEntries(Object.entries(refsInput.perks).reverse()),
    } as LegacyInput;
    expect(compile(refsInput, file(), { catalog }).bytes).toEqual(a);
    expect(compile(shuffled, file(), { catalog }).bytes).toEqual(a);
  });

  test.each(
    styles.flatMap((style) => (['lines', 'text'] as const).map((shape) => [style, shape] as const)),
  )(
    'editor data, %s %s: builds, validates, round-trips through the reference decoder',
    (style, shape) => {
      const plan = compile(input, everything(style, shape), { catalog: realCatalog, identical });
      const parsed = json(plan.bytes);
      expect(() => validateV1(parsed)).not.toThrow();
      // String comparisons: deep equality on thousands of items is slow.
      expect(JSON.stringify(decodeV1(parsed))).toBe(JSON.stringify(plan.expanded));
      expect(Object.keys(parsed.items).length).toBeGreaterThan(2000);
      expect(decoder.decode(plan.bytes)).not.toContain('{{');
      expect(
        sha256(compile(input, everything(style, shape), { catalog: realCatalog, identical }).bytes),
      ).toBe(sha256(plan.bytes));
    },
    60_000,
  );

  test('the published input (i) builds every style as well', () => {
    const live = liveInput();
    for (const style of styles) {
      const plan = compile(live.input, everything(style), {
        catalog: realCatalog,
        identical: live.identical,
      });
      expect(() => validateV1(json(plan.bytes))).not.toThrow();
    }
  }, 60_000);

  test('a structured file of real data matches the editor preview row by row (English)', () => {
    const plan = compile(
      input,
      {
        ...everything('structured'),
        format: all.format,
        data: { ...everything('structured').data, languages: ['en'] },
      },
      { catalog: realCatalog, identical },
    );
    let compared = 0;
    const mismatches: string[] = [];
    const globals = previewGlobals(input, '');
    for (const [hash, item] of Object.entries(plan.expanded!)) {
      const row = input.perks[hash] as { aliasOf?: number; type?: string };
      const target = (row.aliasOf ? input.perks[row.aliasOf] : row) as {
        editor: { en: { main: string } };
        type: string;
      };
      const preview = parseMarkup(target.editor.en.main, {
        ...globals,
        type: row.type ?? target.type,
      }).lines;
      if (JSON.stringify(item.descriptions.en) !== JSON.stringify(clean(preview)))
        mismatches.push(hash);
      compared++;
    }
    expect(mismatches).toEqual([]);
    expect(compared).toBeGreaterThan(2000);
  }, 60_000);
});

describe('project index and legacy bytes', () => {
  test('index.json lists published URLs only', () => {
    const config = configSchema.parse(validConfig());
    const numbers = {
      sha256: 'a'.repeat(64),
      bytes: 10,
      lastUpdate: '2026-11-11T00:00:00Z',
      outcome: 'built' as const,
    };
    const index = projectIndex(config, { 'dim/v1/main.json': numbers });
    expect(index.files).toEqual([
      { id: 'main', formatVersion: 1, path: 'dim/v1/main.json', ...numbers },
    ]);
  });
});

test('the core markup code the engine bundles never evaluates text as code (P1a scan extended)', () => {
  const dir = new URL('../../core/src/markup/', import.meta.url);
  const bundled = [
    'parse',
    'prepare',
    'lines',
    'syntax',
    'baseEnhanced',
    'arithmetic',
    'weaponHeadings',
    'types',
  ];
  for (const name of bundled) {
    const source = readFileSync(new URL(`${name}.ts`, dir), 'utf8');
    expect(`${name}: ${/new\s+Function\b|\beval\s*\(/.test(source)}`).toBe(`${name}: false`);
  }
  const decoderSource = readFileSync(new URL('../decoder/decode-v1.mjs', import.meta.url), 'utf8');
  expect(/new\s+Function\b|\beval\s*\(/.test(decoderSource)).toBe(false);
});

// ---------------------------------------------------------------- code review round 1 (F1-F5)
describe('review fixes', () => {
  const withRow = (rows: Record<number, string>, selected = 101) => {
    const perks: Record<string, unknown> = { ...globalsRows };
    for (const [hash, body] of Object.entries(rows)) perks[hash] = perk(Number(hash), body);
    const items = Object.fromEntries(
      Object.keys(rows).map((hash) => [hash, { categoryId: 'verbs' }]),
    );
    const plan = () =>
      compile(
        { perks } as unknown as LegacyInput,
        file({ categories: ['verbs'], sandboxPerks: [] }),
        {
          catalog: { ...catalog, items: { ...items, [selected]: { categoryId: 'verbs' } } },
        },
      );
    return plan;
  };

  test.each([
    ['a missing import', { 101: 'Before\nimport main from 999\nAfter' }],
    ['a missing named export', { 101: 'import Gone from 102', 102: 'Body' }],
    ['a self-cycle', { 101: 'import main from 101' }],
    ['a nested missing import', { 101: 'import main from 102', 102: 'import main from 999' }],
    ['a missing global export', { 101: 'import Gone from global' }],
    [
      'a missing import inside a local title',
      { 101: 'title T (\nimport main from 999\n)\n<title See [T] />' },
    ],
    ['a malformed base/enhanced pair', { 101: 'Damage {{a}{b}' }],
  ])('F1: %s fails the file with the hash and language', (_name, rows) => {
    expect(withRow(rows)).toThrow(/^Tooltip 101 \(en\): /);
  });

  test('F1: an error in a row the file does not include does not fail it', () => {
    const perks = { ...refsInput.perks, 600: perk(600, 'import main from 999') };
    expect(() =>
      compile({ perks } as LegacyInput, file({ categories: ['verbs'] }), { catalog }),
    ).not.toThrow();
  });

  const owned = (): ExportConfig =>
    configSchema.parse({
      schema: 1,
      id: 'dim',
      name: 'DIM',
      files: [
        { ...file(), id: 'one', uid: 'uidone00' },
        { id: 'two', uid: 'uidtwo00', formatVersion: 1, preset: 'dim' },
      ],
      retained: [
        {
          path: 'dim/v1/old.json',
          uid: 'uidold00',
          formatVersion: 1,
          snapshot: { id: 'old', formatVersion: 1, preset: 'dim' },
          until: '2027-02-11T00:00:00Z',
        },
      ],
    });

  test('F2: URL ownership: strip, swap, takeover, and restore', () => {
    const before = owned();
    const [one, two] = before.files;
    const change = (files: ExportConfig['files']) => ({ ...before, files });
    expect(immutableChanges(before, before)).toEqual([]);
    expect(immutableChanges(before, change([{ ...one, uid: undefined }, two]))).not.toEqual([]);
    expect(
      immutableChanges(
        before,
        change([
          { ...one, uid: two.uid },
          { ...two, uid: one.uid },
        ]),
      ),
    ).not.toEqual([]);
    expect(
      immutableChanges(before, change([{ ...one, id: 'old', uid: undefined }, two])),
    ).not.toEqual([]);
    expect(
      immutableChanges(before, change([{ ...one, id: 'old', uid: one.uid }, two])),
    ).not.toEqual([]);
    const restore = change(
      [one, two]
        .slice(0, 1)
        .concat([{ id: 'old', uid: 'uidold00', formatVersion: 1, preset: 'dim' }]),
    );
    expect(immutableChanges(before, restore)).toContain('Only a maintainer can restore file old');
    expect(immutableChanges(before, restore, { maintainer: true })).toEqual([]);
    expect(immutableChanges(before, change([{ ...one, id: 'renamed' }, two]))).toEqual([]);
    expect(immutableChanges(before, change([one]))).toEqual([]);
    expect(immutableChanges(before, { ...before, retained: [] })).toEqual([
      'Retained URLs are server-owned',
    ]);
    expect(immutableChanges(before, { ...before, retained: [] }, { maintainer: true })).toEqual([]);
  });

  test.each([
    ['a path outside the project', { path: '../other/v1/old.json' }],
    ['an absolute path', { path: '/outside.json' }],
    ['another project', { path: 'other/v1/old.json' }],
    ['a path that is not its snapshot', { path: 'dim/v1/else.json' }],
    [
      'an active URL',
      { path: 'dim/v1/one.json', snapshot: { id: 'one', formatVersion: 1, preset: 'dim' } },
    ],
    [
      'a snapshot with another uid',
      { snapshot: { id: 'old', uid: 'uidelse0', formatVersion: 1, preset: 'dim' } },
    ],
  ])('F3: a retained entry with %s is refused', (_name, patch) => {
    const config = structuredClone(owned()) as Record<string, unknown> & { retained: object[] };
    config.retained = [{ ...config.retained[0], ...patch }];
    expect(configSchema.safeParse(config).success).toBe(false);
  });

  test('F3: two retained entries with one URL are refused', () => {
    const config = structuredClone(owned());
    config.retained = [config.retained![0], { ...config.retained![0], uid: 'uidold01' }];
    expect(configSchema.safeParse(config).success).toBe(false);
  });

  test('F4: a class the parser lists twice applies once', () => {
    const parsed = parseMarkup('<bold/>damage').lines;
    expect(transform(parsed, styleFormats.markdown, 'text', emptyNotes())).toBe('**damage**');
    expect(transform(parsed, styleFormats.structured, 'lines', emptyNotes())).toEqual([
      { classNames: ['bold'], linesContent: [{ text: 'damage' }] },
    ]);
    expect(transform(parsed, styleFormats.plain, 'text', emptyNotes())).toBe('damage');
  });

  test('F5: inline titles keep the spans the file keeps', () => {
    const source =
      'title T (\nBody <arc/> plus <bold strength />\n<yellow/>Second\n)\n<title Label [T] />';
    const parsed = parseMarkup(source).lines;
    const inline = {
      mode: 'inline' as const,
      pattern: ['', ' ', '(', ')'] as [string, string, string, string],
    };
    expect(
      transform(parsed, { ...styleFormats.structured, titles: inline }, 'lines', emptyNotes()),
    ).toEqual([
      {
        linesContent: [
          { text: 'Label (Body ' },
          { classNames: ['arc'] },
          { text: ' plus ' },
          { text: 'strength', classNames: ['bold'] },
          { text: ' ' },
          { text: 'Second', classNames: ['yellow'] },
          { text: ')' },
        ],
      },
    ]);
    expect(
      transform(parsed, { ...styleFormats.markdown, titles: inline }, 'text', emptyNotes()),
    ).toBe('Label (Body [Arc] plus **strength** Second)');
    expect(transform(parsed, { ...styleFormats.plain, titles: inline }, 'text', emptyNotes())).toBe(
      'Label (Body  plus strength Second)',
    );
  });
});
