// ELEMENT-TAGS-2 AC1, the publisher template (the bundled core that runs in editor-data
// `.publisher/`): its own exportLegacy, taken from the shipped publisher.mjs bytes, lowers
// element-tagged text exactly as core does, and its PIN declares the capability the Worker checks.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, expect, it } from 'vitest';
import {
  exportLegacy,
  migrateLegacy,
  type LegacyCatalog,
  type Tooltip,
} from '../../packages/core/src/index.js';
import { database, tooltip } from '../../packages/core/test/helpers.js';
import { loweredFixtures, raiseTooltips } from '../../packages/core/test/elementTagCorpus.js';
import { unloweredEntry } from './publisher.js';

const root = 'scripts/publisher/template/.publisher';
const runtime = readFileSync(`${root}/publisher.mjs`, 'utf8');
const temp = mkdtempSync(join(tmpdir(), 'publisher-template-'));
afterAll(() => rmSync(temp, { recursive: true, force: true }));

/** The template's own exportLegacy: its bytes, minus the CLI start, plus one export line. */
async function templateExportLegacy(): Promise<typeof exportLegacy> {
  const section = runtime.indexOf('// packages/core/src/exportLegacy.ts\n');
  const name = /function (exportLegacy\d*)\(/.exec(runtime.slice(section))?.[1];
  const start = runtime.lastIndexOf('main().catch(');
  expect(section).toBeGreaterThan(0);
  expect(name).toBeDefined();
  expect(start).toBeGreaterThan(section);
  const file = join(temp, 'template.mjs');
  writeFileSync(file, `${runtime.slice(0, start)}\nexport { ${name} as exportLegacy };\n`);
  return (await import(pathToFileURL(file).href)).exportLegacy;
}

const unlowered = /<(?:kinetic|arc|solar|void|stasis|strand) [^<>]*\/>/;

it('declares the elementTags and markupBraces capabilities in its PIN', () => {
  const pin = JSON.parse(readFileSync(`${root}/PIN`, 'utf8'));
  expect(pin.capabilities).toEqual([
    'elementTags',
    'sandboxPointers',
    'scheduledBatches',
    'markupBraces',
  ]);
});

it('markupBraces: the template build lowers #{name} and <enhanced/> exactly as core does', async () => {
  const templated = await templateExportLegacy();
  const base = tooltip();
  const make = (text: string): Tooltip => ({ ...base, text: { en: { ...base.text.en!, text } } });
  const braced = make('var d = 3\nDeal #{d}x more, #{d} stacks.\n<enhanced/> Faster reload.');
  const exported = templated([braced], 0);
  expect(JSON.stringify(exported)).toBe(JSON.stringify(exportLegacy([braced], 0)));
  expect(JSON.stringify(exported)).not.toMatch(/#\{|<enhanced\/>/);
  expect(JSON.stringify(exported)).toContain('#e');
  expect(unloweredEntry(exported)).toBeUndefined();
});

it('real data: the template build exports raised tags byte for byte as core exports today', async () => {
  const templated = await templateExportLegacy();
  const live = database('live');
  const original = migrateLegacy(live);
  const { tooltips, raised } = raiseTooltips(original);
  expect(raised).toBeGreaterThan(1000);
  const facts: LegacyCatalog = Object.fromEntries(
    Object.entries(live.perks).map(([hash, perk]) => [hash, { name: perk.name, type: perk.type }]),
  );
  const expected = JSON.stringify(exportLegacy(original, 0, facts));
  const actual = JSON.stringify(templated(tooltips, 0, facts));
  expect(actual).toBe(expected);
  expect(actual).not.toMatch(unlowered);
});

it.each(loweredFixtures)(
  '%s: the template build writes the hand-written lowered form',
  async (_, tagged, lowered) => {
    const templated = await templateExportLegacy();
    const base = tooltip();
    const make = (text: string): Tooltip => ({ ...base, text: { en: { ...base.text.en!, text } } });
    expect(JSON.stringify(templated([make(tagged)], 0))).toBe(
      JSON.stringify(exportLegacy([make(lowered)], 0)),
    );
  },
);

it('fails closed on an export that still holds a tagged span or a preview marker', () => {
  const entry = (main: string) => ({ 42: { hash: 42, editor: { en: { main, secondary: main } } } });
  expect(unloweredEntry(entry('Gain <solar/>Scorch.'))).toBeUndefined();
  expect(unloweredEntry(entry('Gain <solar Scorch />.'))).toBe('42');
  expect(unloweredEntry(entry(`Gain ${String.fromCharCode(0xe000)}Scorch.`))).toBe('42');
});

it('fails closed on an export that still holds #{ or <enhanced/> (markupBraces)', () => {
  const entry = (main: string) => ({ 42: { hash: 42, editor: { en: { main, secondary: '' } } } });
  expect(unloweredEntry(entry('Deal #d#Zb1wx more. #e Faster.'))).toBeUndefined();
  expect(unloweredEntry(entry('Deal #{d} more.'))).toBe('42');
  expect(unloweredEntry(entry('Deal #{ more.'))).toBe('42');
  expect(unloweredEntry(entry('<enhanced/> Faster.'))).toBe('42');
  // Any string anywhere in the entry, not only the main text.
  expect(unloweredEntry({ 7: { stats: [{ name: 'x #{d}' }] } })).toBe('7');
});
