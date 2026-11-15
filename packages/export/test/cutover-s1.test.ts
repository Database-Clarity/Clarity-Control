import { describe, expect, test } from 'vitest';
import { parseMarkup } from '@clarity/core/markup/parse';
import {
  buildLegacy, compile, legacyPresets, newStyleFile, styles,
  type LegacyInput, type LegacyPreset,
} from '../src/index.js';
import { descriptionFilter } from '../src/converter/descriptionFilter.js';
import { expandAliases } from '../src/converter/index.js';
import { prismaticAssets, assertPrismaticReady } from '../src/converter/prismatic.js';
import { emptyNotes, transform } from '../src/v1/transform.js';
import { fixtureInput, liveInput, editorDataInput, expected, sha256 } from './helpers.js';

const json = (bytes: Uint8Array) => JSON.parse(new TextDecoder().decode(bytes));
const perk = (hash: number, main: string, type = 'Weapon Trait') => ({
  hash, name: String(hash), type, editor: { en: { main, secondary: main } },
  uploadedBy: '', lastUpload: 1, updateTracker: { descriptions: {} },
  inLiveDatabase: true, uploadToLive: true,
});
const inputOf = (source: string, extra: Record<string, unknown> = {}): LegacyInput => ({
  perks: {
    1: perk(1, 'export Shared (\nGlobal {{base}{enhanced}}\n)'),
    2: perk(2, 'var N = 2\nvar Pair = {{3}{4}}\nvar e = 🡅'),
    3: perk(3, 'title Help (\nGlobal title {{base}{enhanced}}\n)'),
    100: perk(100, source),
    101: { hash: 101, aliasOf: 100, aliasKind: 'frame', type: 'Weapon Trait Enhanced' },
    102: { hash: 102, aliasOf: 100, aliasKind: 'sandbox' },
    ...extra,
  },
} as unknown as LegacyInput);
const catalog = {
  items: Object.fromEntries([100, 101, 102, 200, 201].map((hash) => [hash, { categoryId: 'trait' }])),
  categories: [{ id: 'trait' }],
};
const custom = (style: (typeof styles)[number]) => newStyleFile('test', style, {
  categories: ['trait'], sandboxPerks: ['trait'], languages: ['en'], keys: ['name'],
  frameAliases: true, bungieIdentical: true,
});

describe('S1 native consumer output in importer context', () => {
  const cases: [string, string, Record<string, unknown>?][] = [
    ['inline arms', 'Damage {{10}{20}}'],
    ['opaque math boundary', '${1+{{2}{3}}}'],
    ['local and global variables', 'var L = 5\n{{#L}{#N}} and #Pair'],
    ['global export', 'import Shared from global'],
    ['nested named export and alias import', 'import Part from 201', {
      200: perk(200, 'export Part (\nimport Shared from global\n)'),
      201: { hash: 201, aliasOf: 200, aliasKind: 'frame', type: 'Weapon Trait Enhanced' },
    }],
    ['mid-line splice composes a pair', 'x {import main from 5\nimport main from 5', {
      5: perk(5, '{a}{b}}'),
    }],
    ['local title', 'title Local (\nTitle {{x}{y}} #Pair\n)\n<title Label [Local] />'],
    ['global title', '<title Label [Help] />'],
    ['native imported through a global title', '<title Label [Help] />', {
      3: perk(3, 'title Help (\nimport main from 5\n)'), 5: perk(5, 'Title {{x}{y}}'),
    }],
    ['late title import after variable substitution', 'title T (\n#Import\n)\n{{b}{e}} <title See [T] />', {
      1: perk(1, ''), 2: perk(2, 'var Import = import main from 200'), 3: perk(3, ''),
      200: perk(200, 'Imported {{x}{y}}'),
    }],
    ['native only in a late title import', 'title T (\n#Import\n)\n<title See [T] />', {
      1: perk(1, ''), 2: perk(2, 'var Import = import main from 200'), 3: perk(3, ''),
      200: perk(200, 'Imported {{x}{y}}'),
    }],
    ['pair assembled by a late title import', 'title T (\nx {#Import\n#Import\n)\n<title See [T] />', {
      1: perk(1, ''), 2: perk(2, 'var Import = import main from 5'), 3: perk(3, ''),
      5: perk(5, '{a}{b}}'),
    }],
    ['condition and arrows', 'enhanced (\nOnly {{base}{enhanced}} <enhanced/>\n)\n{{x}{y}} <arrow/>'],
  ];
  test.each(cases)('%s matches the real preview for all eight presets and both variants', (_name, source, extra) => {
    const input = inputOf(source, extra);
    // Library pairs apply to every case, including ones that have no literal pair themselves.
    const lookup = expandAliases(input.perks);
    const imports = Object.fromEntries(Object.entries(lookup).map(([hash, row]) => [hash, row.editor.en?.main ?? '']));
    for (const preset of legacyPresets) {
      const output = json(buildLegacy(input, preset));
      for (const [hash, type] of [[100, 'Weapon Trait'], [101, 'Weapon Trait Enhanced']] as const) {
        const legacySource = source.replaceAll('<arrow/>', preset === 'clarityV2' ? '<arrow/>' : '🠚');
        const preview = parseMarkup(legacySource, {
          imports, variables: imports[2], titles: imports[3], type,
        });
        expect(preview.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
        expect(output[hash].descriptions.en, `${preset}/${hash}`).toEqual(
          descriptionFilter(structuredClone(preview.lines), preset),
        );
      }
      if (preset !== 'clarityV2') expect(output[102]).toBeUndefined();
      expect(JSON.stringify(output)).not.toContain('{{');
    }
    for (const style of styles) {
      const file = custom(style);
      if (_name.includes('late title import'))
        file.format.titles = { mode: 'inline', pattern: ['', '', ' (', ')'] };
      const plan = compile(input, file, { catalog });
      expect(JSON.stringify(plan.expanded)).not.toContain('{{');
      for (const [hash, type] of [[100, 'Weapon Trait'], [101, 'Weapon Trait Enhanced']] as const) {
        const preview = parseMarkup(source, { imports, variables: imports[2], titles: imports[3], type });
        expect(plan.expanded?.[hash].descriptions.en).toEqual(
          transform(preview.lines, file.format, file.shape, emptyNotes()),
        );
      }
    }
  });

  test.each([
    ['malformed pair', '{{base}{enhanced}'],
    ['deleted import', '{{b}{e}}\nimport main from 999'],
    ['cyclic import', '{{b}{e}}\nimport main from 100'],
    ['missing global export', '{{b}{e}}\nimport Missing from global'],
    ['missing import inside a title', 'title T (\n{{b}{e}}\nimport main from 999\n)\n<title See [T] />'],
  ])('%s fails closed in presets and custom styles', (_name, source) => {
    const input = inputOf(source);
    for (const preset of legacyPresets) expect(() => buildLegacy(input, preset)).toThrow();
    for (const style of styles) expect(() => compile(input, custom(style), { catalog })).toThrow();
  });

  test('native maths format by language, while exact English fallbacks retain dot spelling', () => {
    const input = inputOf('Value {{1.5}{2.5}} ${1.5+2}');
    const base = input.perks[100] as typeof input.perks[100] & { editor: { de?: { main: string; secondary: string } } };
    base.editor.de = { main: 'Wert {{1.5}{2.5}} ${1.5+2}', secondary: 'Wert {{1.5}{2.5}} ${1.5+2}' };
    for (const preset of legacyPresets.filter((p) => p !== 'vaultZero')) {
      const out = json(buildLegacy(input, preset));
      expect(JSON.stringify(out[100].descriptions.de)).toContain('Wert 1,5 3,5');
      expect(JSON.stringify(out[101].descriptions.de)).toContain('Wert 2,5 3,5');
    }
    base.editor.de = { main: 'Value {{1.5}{2.5}} ${1.5+2}', secondary: 'Value {{1.5}{2.5}} ${1.5+2}' };
    expect(JSON.stringify(json(buildLegacy(input, 'dim'))[100].descriptions.de)).toContain('Value 1.5 3.5');
  });

  test('native secondary self imports retain importer type, and equal variants stay references', () => {
    const input = inputOf('Damage {{10}{20}}');
    const base = input.perks[100] as ReturnType<typeof perk>;
    base.editor.en.secondary = 'import self';
    const output = json(buildLegacy(input, 'dim'));
    expect(JSON.stringify(output[100].descriptions.en)).toContain('Damage 10');
    expect(JSON.stringify(output[101].descriptions.en)).toContain('Damage 20');
    const identical = json(buildLegacy(inputOf('Same text'), 'clarityV2'));
    expect(identical[101]).toEqual({ hash: 101, aliasOf: 100 });
  });
});

describe('CUTOVER-PRISMATIC', () => {
  test('the named readiness gate fails while the two owner-supplied assets are TODO', () => {
    expect(prismaticAssets.dim).toBe('\u{F0156}');
    expect(prismaticAssets.vaultZero).toBe('[Prismatic]');
    expect(prismaticAssets.braytech).toBeNull();
    expect(prismaticAssets.crayon).toBeNull();
    expect(() => assertPrismaticReady()).toThrow('CUTOVER-PRISMATIC: missing verified assets: braytech, crayon');
  });

  test('known mappings and structured allowlists preserve the icon and adjacent text', () => {
    const input = inputOf('Before <prismatic Facet /> after');
    const outputs = Object.fromEntries(legacyPresets.map((p) => [p, json(buildLegacy(input, p))[100].descriptions.en]));
    expect(outputs.dim).toEqual([{ linesContent: [{ text: 'Before ' }, { text: '\u{F0156}' }, { text: 'Facet after' }] }]);
    expect(outputs.vaultZero).toBe('Before [Prismatic]Facet after');
    for (const preset of ['clarity', 'foundry', 'clarityV2'])
      expect(JSON.stringify(outputs[preset])).toContain('"prismatic"');
    // Pending assets never block or alter today's text output in these consumers.
    expect(outputs.braytech).toBe('Before Facet after');
    expect(outputs.crayon).toBe('Before Facet after');
  });

  test('custom tagged text is opt-in, including imported and title text', () => {
    const input = inputOf('import main from 200\n<title Label [Help] />', {
      200: perk(200, 'Before <prismatic Facet /> after'),
      3: perk(3, 'title Help (\n<prismatic Transcendence /> nearby\n)'),
    });
    const file = custom('structured');
    const normal = compile(input, file, { catalog });
    expect(JSON.stringify(normal.expanded)).not.toContain('elementText');
    file.format.elementTags = true;
    const tagged = compile(input, file, { catalog });
    const text = JSON.stringify(tagged.expanded);
    expect(text).toContain('"text":"Facet","classNames":["elementText","prismatic"]');
    expect(text).toContain('Transcendence');
    expect(text).not.toMatch(/[\uE000\uE001]/);
    expect(input.perks[200]).toEqual(perk(200, 'Before <prismatic Facet /> after'));
  });

  test.each(styles)('%s: tagged text never repeats the standalone icon replacement', (style) => {
    const input = inputOf('Before <prismatic Facet /> after');
    const file = custom(style);
    const normal = compile(input, file, { catalog });
    file.format.elementTags = true;
    const tagged = compile(input, file, { catalog });
    if (style === 'structured') {
      const lines = tagged.expanded![100].descriptions.en;
      expect(JSON.stringify(lines)).toContain('"classNames":["elementText","prismatic"]');
    } else expect(tagged.bytes).toEqual(normal.bytes);
    if (style === 'markdown')
      expect(tagged.expanded![100].descriptions.en).toBe('Before [Prismatic]Facet after');
  });
});

// Decided deltas: native arm selection, Prismatic recognition/verified mappings, opted-in tagged
// text, and the existing Armor Set Bonus rename. Every other control byte stays pinned.
test.each(['live', 'editorData'] as const)('%s real-data control: seven files stay byte-identical', (name) => {
  const { input, identical } = name === 'live' ? liveInput() : editorDataInput();
  for (const preset of legacyPresets)
    expect(sha256(buildLegacy(input, preset, { identical }))).toBe(expected[name].files[preset]);
}, 120_000);

test('synthetic fixture census classifies Prismatic as the sole new legacy delta', () => {
  const { input } = fixtureInput();
  const text = JSON.stringify(input);
  expect((text.match(/<prismatic/g) ?? []).length).toBe(4);
  const control: LegacyInput = JSON.parse(text.replaceAll('<prismatic', '<unverifiedElement'));
  for (const preset of ['crayon', 'braytech'] as LegacyPreset[])
    // Their unresolved mapping is a release gate, not a change to current bare-icon output.
    expect(json(buildLegacy(control, preset))[1001]).toEqual(json(buildLegacy(input, preset))[1001]);
});
