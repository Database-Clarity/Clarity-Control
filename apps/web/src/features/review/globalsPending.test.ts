import { beforeEach, expect, it, vi } from 'vitest';
import { publishableHash, type GlobalsPending, type Tooltip } from '@clarity/core';
import { bundleSchema } from '../../services/bundleSchema';
import { useAuthStore } from '../../stores/auth';
import { useDataStore, type EditorData } from '../../stores/data';
import { clearSavedOverlay, rememberSavedGlobal } from '../../stores/savedOverlay';
import { editorPath, publishedOf, rowKey } from './globalRows';
import {
  globalKey,
  neededGlobals,
  publishedGlobals,
  publishedText,
  publishedCell,
  rowIdentity,
} from './globalsPending';
import { localKind } from './kinds';
import { pendingTooltips, publishableHashes, publishSelection } from './model';
import { planReviewedPublish, queuePublish, withNeededGlobals } from './publishAction';
import { publishedRows } from './published';
import { publishDriver } from './publisher';
import { queueView } from './queueModel';
import { acknowledgedGlobals, acknowledgedMarkers, useReviewSession } from './session';

const at = '2026-01-01T00:00:00Z';
const ids = {
  refill: 'g_refill-0001',
  scaling: 'g_scaling-001',
  gone: 'g_gone-00001',
  fresh: 'g_fresh-0001',
  moved: 'g_moved-0001',
};
const digest = (n: number) => String(n).repeat(64);
const make = (hash: number, text: string): Tooltip => ({
  hash,
  text: { en: { text, updatedAt: at, updatedBy: 'fixture' } },
  associated: [],
});

it('uses the English import language when a nested tooltip lacks a shared translation', async () => {
  const data = await state([]);
  const cell = (text: string) => ({ text, updatedAt: at, updatedBy: '' });
  const importer = {
    ...make(12, ''),
    text: {
      en: cell('English lead\nimport main from 13'),
      de: cell('Deutscher Einstieg\nimport main from 13'),
    },
  };
  const published = {
    ...make(13, ''),
    text: {
      en: cell('Import source <title Details [G_refill] />'),
      de: cell('Quelle <title Details [G_refill] />'),
    },
  };
  const saved = {
    ...published,
    text: {
      en: cell('Unpublished English source'),
      de: cell('Unveröffentlichte Quelle'),
    },
  };
  data.bundle.tooltips[13] = saved;
  data.bundle.globalsReviewImports = { 13: published };
  expect(publishedCell(data, importer, 'de', 'next')).toEqual({
    text: importer.text.en.text,
    language: 'en',
  });
  const fallback = publishedGlobals({ variables: '', titles: '' }, data, 'en');
  expect(fallback.imports?.[13]).toContain('Import source');
  expect(fallback.imports?.[13]).not.toContain('Unpublished');
  const included = new Set([13]);
  expect(publishedCell(data, importer, 'de', 'next', included)).toEqual({
    text: importer.text.de.text,
    language: 'de',
  });
  expect(
    publishedGlobals({ variables: '', titles: '' }, data, 'de', 'next', included).imports?.[13],
  ).toBe('Unveröffentlichte Quelle');
  data.bundle.globalsReviewImports = { 13: saved };
  data.bundle.tooltips[13] = published;
  expect(publishedCell(data, importer, 'de', 'next').language).toBe('de');
});

it('previews a translated tooltip with the shared translation selected for the same publish', async () => {
  const translation = {
    ...row(ids.refill, 'titles', 'G_refill', 'changed', 'New note with #Fresh', 'New note with #Fresh'),
    languages: { de: { before: null, after: 'Deutsche Notiz' } },
  };
  const data = await state([translation]);
  const note = data.bundle.globals!.entries[0]!;
  note.definitions.en!.body = 'New note';
  note.definitions.de = { ...note.definitions.en!, body: 'Deutsche Notiz' };
  const tooltip = make(12, 'English <title Details [G_refill] />');
  tooltip.text.de = { ...tooltip.text.en!, text: 'Deutsch <title Details [G_refill] />' };
  const selected = new Set([tooltip.hash, globalKey(ids.refill)]);

  expect(publishedCell(data, tooltip, 'de', 'live', selected).language).toBe('en');
  expect(publishedCell(data, tooltip, 'de', 'next', new Set([tooltip.hash])).language).toBe('en');
  expect(publishedCell(data, tooltip, 'de', 'next', selected)).toMatchObject({
    text: expect.stringContaining('Deutsche Notiz'),
    language: 'de',
  });
});
const row = (
  id: string,
  kind: GlobalsPending[number]['kind'],
  name: string,
  change: GlobalsPending[number]['change'],
  before: string | null,
  after: string | null,
  affected: number[] = [],
): GlobalsPending[number] => ({
  id,
  kind,
  name,
  change,
  digest: digest(1),
  languages: { en: { before, after } },
  affected,
});
const pending = (): GlobalsPending => [
  row(ids.refill, 'titles', 'G_refill', 'changed', 'Old note', 'New note', [10, 11]),
  row(ids.scaling, 'variables', 'Scaling', 'renamed', 'x', 'x', [10]),
  row(ids.gone, 'exports', 'gone', 'removed', 'Old export', null),
  { ...row(ids.fresh, 'variables', 'Fresh', 'new', null, 'Brand new'), refusal: undefined },
  { ...row(ids.moved, 'variables', 'Moved', 'changed', 'a', 'b'), refusal: 'Tooltip 10: no.' },
];

async function state(globalsPending: GlobalsPending | undefined = pending()): Promise<EditorData> {
  const tooltips = [
    make(10, 'Uses [G_refill]'),
    make(12, 'Edited'),
    make(13, 'Edited with #Fresh'),
  ];
  const pushed: Record<string, string> = { 3: 'f'.repeat(64) };
  for (const tooltip of tooltips)
    pushed[tooltip.hash] = tooltip.hash === 10 ? await publishableHash(tooltip) : 'e'.repeat(64);
  const entry = (id: string, kind: string, name: string, body: string) => ({
    version: 1,
    id,
    kind,
    name,
    revision: 'r1',
    definitions: { en: { body, revision: 'r1', updatedAt: at, updatedBy: 'fixture' } },
    nameHistory: [],
    tombstone: false,
  });
  return {
    items: Object.fromEntries(
      tooltips.map(({ hash }) => [
        hash,
        { hash, name: `Perk ${hash}`, categoryId: 'perk', icon: '', inGameDescription: '' },
      ]),
    ) as EditorData['items'],
    categories: [{ id: 'perk', label: 'Perks', group: 'Weapons', order: 1 }],
    aliases: {},
    bundle: {
      sourceCommit: 'abc',
      generatedAt: at,
      tooltips: Object.fromEntries(
        [make(3, 'title G_refill (\nNew note\n)'), ...tooltips].map((t) => [t.hash, t]),
      ),
      pushed,
      permissions: { users: {} },
      globals: {
        entries: [
          entry(ids.refill, 'titles', 'G_refill', 'New note with #Fresh'),
          entry(ids.fresh, 'variables', 'Fresh', 'Brand new'),
        ],
        sync: { status: 'current', causeIds: [], lastFailure: null, causeEntries: {} },
      },
      ...(globalsPending ? { globalsPending } : {}),
    } as unknown as EditorData['bundle'],
  };
}
const names = (entries: { name: string }[]) => entries.map(({ name }) => name);

beforeEach(() => {
  clearSavedOverlay();
  useReviewSession.setState({ acknowledgments: {}, globals: {}, pushing: false, error: undefined });
});

it('filters aggregate rows from a bundle without pending globals, and refuses a malformed field', async () => {
  const { bundle, ...data } = await state();
  const { globalsPending, ...older } = bundle;
  delete older.globals;
  expect(
    (await pendingTooltips({ ...data, bundle: older })).map(({ tooltip }) => tooltip.hash),
  ).toEqual([12, 13]);
  expect(bundleSchema.safeParse({ ...older, globalsPending }).success).toBe(true);
  expect(bundleSchema.safeParse({ ...older, globalsPending: [{}] }).success).toBe(false);
  // Present and empty is the new mode: no file rows.
  const empty = await pendingTooltips({ ...data, bundle: { ...older, globalsPending: [] } });
  expect(empty.map(({ tooltip }) => tooltip.hash)).toEqual([12, 13]);
});

it('lists one ordinary row per pending global, and no tooltip it changes', async () => {
  const entries = await pendingTooltips(await state());
  expect(names(entries)).toEqual([
    'Perk 12',
    'Perk 13',
    'Fresh',
    'G_refill',
    'gone',
    'Moved',
    'Scaling',
  ]);
  const by = Object.fromEntries(entries.map((entry) => [entry.name, entry]));
  expect(rowKey(by.G_refill!)).toBe(ids.refill);
  expect(rowIdentity(by.G_refill!)).toBe('title');
  expect(by.G_refill!.tooltip.hash).toBe(globalKey(ids.refill));
  expect(publishedOf(by.G_refill!, {})).toMatchObject({
    status: 'ready',
    tooltip: { text: { en: { text: 'Old note' } } },
  });
  expect(localKind(by.G_refill!)).toBeUndefined();
  expect(localKind(by.Fresh!)).toEqual({ kind: 'New' });
  expect(localKind(by.gone!)).toEqual({ kind: 'Removed' });
  expect(localKind(by.Scaling!)).toEqual({ kind: 'Renamed' });
  expect(localKind(by.Moved!)).toEqual({ kind: 'On hold' });
  expect(editorPath(by.G_refill!)).toBe(`/globals/${ids.refill}`);
  expect(editorPath(by.gone!)).toBe('/globals');
  // Only whether a translation counts as up to date changed: no claim that nothing changes.
  const availability = pending();
  availability[0]!.languages = { de: { before: 'Notiz', after: 'Notiz' } };
  const [first] = (await pendingTooltips(await state(availability))).filter(
    ({ name }) => name === 'G_refill',
  );
  expect(localKind(first!)).toEqual({ kind: 'Definition changed' });
  // No history request is made for a global.
  expect(publishedRows(entries).map(({ hash }) => hash)).toEqual([12, 13]);
  const groups = queueView(entries, '', '', new Set(), 'hidden').items.filter(
    ({ kind }) => kind === 'group',
  );
  expect(groups).toMatchObject([{ label: 'Perks' }, { label: 'Globals', count: 5 }]);
  // A removed global has no text and still publishes; a refused one waits alone.
  expect(publishableHashes(entries)).not.toContain(globalKey(ids.moved));
  expect(
    publishSelection(new Set(entries.map(({ tooltip }) => tooltip.hash)), entries, new Set()),
  ).toHaveLength(6);
});

it('includes a new global that a chosen text uses, and nothing else', async () => {
  const data = await state();
  const entries = await pendingTooltips(data);
  const pick = (...chosen: string[]) => entries.filter(({ name }) => chosen.includes(name));
  expect(withNeededGlobals(pick('Perk 12'), entries, new Set(), data).picked).toHaveLength(1);
  const { picked, needed } = withNeededGlobals(pick('Perk 13'), entries, new Set(), data);
  expect(names(picked)).toEqual(['Perk 13', 'Fresh']);
  expect([...needed.values()]).toEqual(['Perk 13']);
  // Already chosen: nothing is added. A published global's own pending text is not read.
  expect(neededGlobals(pick('Perk 13', 'Fresh'), entries, data)).toEqual([]);
  const mention = { ...data, bundle: { ...data.bundle, tooltips: { ...data.bundle.tooltips } } };
  mention.bundle.tooltips[12] = make(12, 'Edited Fresh [G_refill]');
  const mentions = await pendingTooltips(mention);
  expect(neededGlobals(mentions.slice(0, 1), mentions, mention)).toEqual([]);
  // A global row that uses the new one needs it too.
  data.bundle.globalsPending![0]!.languages.en!.after = 'New note with #Fresh';
  const again = await pendingTooltips({ ...data });
  expect(
    neededGlobals(
      again.filter(({ name }) => name === 'G_refill'),
      again,
      data,
    ).map(({ global }) => global.name),
  ).toEqual(['Fresh']);
});

it('waits with a reason when the new global cannot publish', async () => {
  const list = pending();
  list[3]!.refusal = 'Fresh holds a whole tooltip.';
  const data = await state(list);
  const entries = await pendingTooltips(data);
  const chosen = entries.filter(({ name }) => name === 'Perk 13');
  expect(() => withNeededGlobals(chosen, entries, new Set(), data)).toThrow(
    "Perk 13 uses the new global Fresh, which can't be published yet. Fresh holds a whole tooltip.",
  );
  list[3]!.refusal = undefined;
  expect(() =>
    withNeededGlobals(
      chosen.map((entry) => ({ ...entry })),
      entries.map((entry) => ({ ...entry, unpublishable: undefined })),
      new Set([globalKey(ids.fresh)]),
      data,
    ),
  ).toThrow('which is being published');
});

it('publishes globals by id and digest next to the tooltips', async () => {
  const data = await state();
  useDataStore.setState({ data });
  useAuthStore.setState({ user: { id: 1, login: 'fixture', role: 'maintainer' } });
  const create = vi.spyOn(publishDriver, 'create').mockResolvedValue({} as never);
  const entries = await pendingTooltips(data);
  const chosen = entries.filter(({ name }) => ['Perk 12', 'G_refill'].includes(name));
  const inputs = planReviewedPublish(chosen, entries, data);
  expect(inputs.map(({ hash }) => hash)).toEqual([12]);
  expect(await queuePublish(inputs, chosen, data, () => true)).toBe(true);
  expect(create).toHaveBeenLastCalledWith(
    [expect.objectContaining({ hash: 12 })],
    [{ id: ids.refill, expected: digest(1), name: 'G_refill' }],
    true,
  );
  expect(await queuePublish([], chosen.slice(1), data, () => true)).toBe(true);
  expect(create).toHaveBeenLastCalledWith([], [expect.objectContaining({ id: ids.refill })], true);
});

it('clears a published global until the bundle caught up or holds another definition', async () => {
  const data = await state();
  const listed = async (value: EditorData) =>
    names(await pendingTooltips(value, acknowledgedMarkers(value), acknowledgedGlobals(value)));
  useReviewSession.setState({ globals: { [ids.refill]: digest(1) } });
  expect(await listed(data)).not.toContain('G_refill');
  expect(await listed({ ...data, bundle: { ...data.bundle } })).not.toContain('G_refill');
  const newer = pending();
  newer[0]!.digest = digest(2);
  expect(await listed({ ...data, bundle: { ...data.bundle, globalsPending: newer } })).toContain(
    'G_refill',
  );
  // Retired: the first definition can become pending again.
  expect(useReviewSession.getState().globals).toEqual({});
  expect(await listed(data)).toContain('G_refill');
});

it('holds a global saved after its row was built', async () => {
  const data = await state();
  const saved = { ...data.bundle.globals!.entries[0]!, revision: 'r2' };
  // Compared before the save: a save changes no loaded data, and must still hold the row.
  expect(
    (await pendingTooltips(data)).every(
      ({ name, unpublishable }) => name === 'Moved' || !unpublishable,
    ),
  ).toBe(true);
  rememberSavedGlobal(saved, 'newer-head');
  const entries = await pendingTooltips(data);
  expect(entries.find(({ name }) => name === 'G_refill')?.unpublishable).toContain('Refresh');
  expect(entries.find(({ name }) => name === 'Fresh')?.unpublishable).toBeUndefined();
});

it('finds the renamed dependency by kind and ignores names introduced by published bodies', async () => {
  const data = await state();
  const { entries } = data.bundle.globals!;
  const define = (id: string, kind: string, name: string, body: string) =>
    entries.push({
      ...structuredClone(entries[0]!),
      id,
      kind,
      name,
      definitions: { en: { ...entries[0]!.definitions.en!, body } },
    } as never);
  // Published "Selector" names the new title: the text never spells it out.
  define('g_select-001', 'variables', 'Selector', '<title Details [Detail] />');
  define('g_detail-001', 'titles', 'Detail', 'A new note');
  define(ids.scaling, 'variables', 'Scaling', 'x');
  data.bundle.globalsPending!.push(
    row('g_detail-001', 'titles', 'Detail', 'new', null, 'A new note'),
    row('g_scaling-title', 'titles', 'Scaling', 'new', null, 'A note with the same name'),
  );
  data.bundle.tooltips[12] = make(12, '#Selector');
  data.bundle.tooltips[13] = make(13, 'Scales with #Scaling');
  const listed = await pendingTooltips(data);
  const needs = (name: string) =>
    neededGlobals(
      listed.filter((entry) => entry.name === name),
      listed,
      data,
    ).map(({ global }) => global.name);
  expect(needs('Perk 12')).toEqual([]);
  expect(needs('Perk 13')).toEqual(['Scaling']);
});

it('shows tooltips with the published globals, whatever is pending', async () => {
  const data = await state([
    row(ids.refill, 'titles', 'G_refill', 'changed', 'Old note', 'New note'),
    row(ids.gone, 'exports', 'gone', 'removed', 'Old export', null),
    {
      ...row(ids.moved, 'variables', 'Moved', 'renamed', 'old text', 'new text'),
      previousName: 'Was',
      languages: {
        en: { before: 'old text', after: 'new text' },
        de: { before: null, after: 'neuer Text' },
      },
    },
    row(ids.fresh, 'variables', 'Fresh', 'new', null, 'Brand new'),
  ]);
  const base = data.bundle.globals!.entries[0]!;
  data.bundle.globals!.entries.push({
    ...base,
    id: ids.moved,
    kind: 'variables',
    name: 'Moved',
    definitions: {
      en: { ...base.definitions.en!, body: 'new text' },
      de: { ...base.definitions.en!, body: 'neuer Text' },
    },
    nameHistory: [{ name: 'Was', revision: 'r0' }],
  } as never);
  const shown = (text: Record<string, string>, lang: 'en' | 'de', side: 'live' | 'next') =>
    publishedText(
      data,
      {
        ...make(12, ''),
        text: Object.fromEntries(
          Object.entries(text).map(([key, value]) => [
            key,
            { text: value, updatedAt: at, updatedBy: '' },
          ]),
        ),
      },
      lang,
      side,
    );
  expect(shown({ en: '<title a [G_refill] />' }, 'en', 'next')).toContain('Old note');
  expect(shown({ en: 'import gone from global' }, 'en', 'live')).toBe('Old export');
  // The published name of a renamed global; no published German means English as a whole.
  const translated = { en: 'English #Was', de: 'Deutsch #Was' };
  expect(shown(translated, 'de', 'live')).toBe('English old text');
  expect(shown(translated, 'en', 'live')).toBe('English old text');
  // A new global shows only on the side that publishes along with it.
  expect(shown({ en: '#Fresh' }, 'en', 'next')).toBe('Brand new');
  expect(shown({ en: '#Fresh' }, 'en', 'live')).toBe('#Fresh');
  const imports = new Proxy<Record<string, string>>(
    {},
    { get: (_, key) => `import ${String(key)}` },
  );
  const globals = {
    variables: 'var Moved = new text',
    titles: 'title G_refill (\nNew note\n)',
    imports,
  };
  const library = publishedGlobals(globals, data, 'de');
  expect(library.variables).toBe('var e = 🡅');
  expect(library.titles).toBe('');
  expect(library.imports!['global']).toBeUndefined();
  expect(library.imports!['42']).toBeUndefined();
  // Nothing pending is the switched mode too; only an absent field is the older one.
  const empty = await state([]);
  const german: Tooltip = {
    ...make(12, ''),
    text: {
      en: { text: 'English <title a [G_refill] />', updatedAt: at, updatedBy: '' },
      de: { text: 'Deutsch <title a [G_refill] />', updatedAt: at, updatedBy: '' },
    },
  };
  expect(publishedText(empty, german, 'de', 'next')).toContain('English');
  const older = { ...empty.bundle };
  delete older.globalsPending;
  const absent = { ...empty, bundle: older };
  expect(publishedText(absent, german, 'de', 'next')).toBe('Deutsch <title a [G_refill] />');
  expect(publishedGlobals(globals, absent, 'en')).toBe(globals);
});
