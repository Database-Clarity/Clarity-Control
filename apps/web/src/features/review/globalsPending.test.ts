import { beforeEach, expect, it, vi } from 'vitest';
import { publishableHash, type GlobalsPending, type Tooltip } from '@clarity/core';
import { bundleSchema } from '../../services/bundleSchema';
import { useAuthStore } from '../../stores/auth';
import { useDataStore, type EditorData } from '../../stores/data';
import { clearSavedOverlay, rememberSavedGlobal } from '../../stores/savedOverlay';
import { editorPath, publishedOf, reviewRows, rowKey } from './globalRows';
import { globalKey, neededGlobals, publishedGlobals, rowIdentity } from './globalsPending';
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

it('keeps a bundle without the field on the older rows, and refuses a malformed field', async () => {
  const { bundle, ...data } = await state();
  const { globalsPending, ...older } = bundle;
  delete older.globals;
  expect(
    (await pendingTooltips({ ...data, bundle: older })).map(({ tooltip }) => tooltip.hash),
  ).toEqual([12, 13, 3]);
  expect(bundleSchema.safeParse({ ...older, globalsPending }).success).toBe(true);
  expect(bundleSchema.safeParse({ ...older, globalsPending: [{}] }).success).toBe(false);
  // Present and empty is the new mode: no file rows.
  const empty = await pendingTooltips({ ...data, bundle: { ...older, globalsPending: [] } });
  expect(empty.map(({ tooltip }) => tooltip.hash)).toEqual([12, 13]);
});

it('lists one ordinary row per pending global, and no tooltip it changes', async () => {
  const entries = await pendingTooltips(await state());
  expect(reviewRows(entries, {})).toBe(entries);
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
  );
  expect(await queuePublish([], chosen.slice(1), data, () => true)).toBe(true);
  expect(create).toHaveBeenLastCalledWith([], [expect.objectContaining({ id: ids.refill })]);
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
  rememberSavedGlobal(saved, 'newer-head');
  const entries = await pendingTooltips(data);
  expect(entries.find(({ name }) => name === 'G_refill')?.unpublishable).toContain('Refresh');
  expect(entries.find(({ name }) => name === 'Fresh')?.unpublishable).toBeUndefined();
});

it('renders tooltips with the published globals, whatever is pending', () => {
  const imports = new Proxy<Record<string, string>>(
    {},
    { get: (_, key) => `import ${String(key)}` },
  );
  const globals = { variables: 'var Moved = b', titles: 'title G_refill (\nNew note\n)', imports };
  const result = publishedGlobals(globals, pending(), 'en');
  expect(result.variables).toBe('var Moved = b\nvar Moved = a');
  expect(result.titles).toContain('title G_refill (\nOld note\n)');
  expect(result.imports!['global']).toContain('export gone (\nOld export\n)');
  expect(result.imports!['42']).toBe('import 42');
  expect(publishedGlobals(globals, [], 'en')).toBe(globals);
});
