import { beforeEach, expect, it, vi } from 'vitest';
import { publishableHash, type GlobalsInPlaceReview, type Tooltip } from '@clarity/core';
import { bundleSchema } from '../../services/bundleSchema';
import { useAuthStore } from '../../stores/auth';
import { useDataStore, type EditorData } from '../../stores/data';
import { clearSavedOverlay, rememberSaved } from '../../stores/savedOverlay';
import { publishedOf, reviewRows, rowKey, unitCount } from './globalRows';
import { kindOf, localKind, textChanges } from './kinds';
import { pendingTooltips, publishableHashes, publishSelection } from './model';
import { planReviewedPublish, queuePublish } from './publishAction';
import { publishedRows } from './published';
import { publishDriver } from './publisher';
import { queueView, stepRow, type QueueGroup } from './queueModel';
import { acknowledgedGlobals, acknowledgedMarkers, useReviewSession } from './session';

const at = '2026-01-01T00:00:00Z';
const revision = 'a'.repeat(40);
const refill = { id: 'g_refill-0001', name: 'G_refill' };
const scaling = { id: 'g_scaling-001', name: 'CombatantScaling' };
const make = (hash: number, text: string): Tooltip => ({
  hash,
  text: { en: { text, updatedAt: at, updatedBy: 'fixture' } },
  associated: [],
});
const row = (
  causes: GlobalsInPlaceReview['rows'][string]['causes'],
  extra: Partial<GlobalsInPlaceReview['rows'][string]> = {},
): GlobalsInPlaceReview['rows'][string] => ({
  differs: true,
  causes,
  diff: {
    en: { before: { main: 'old', secondary: 'old' }, after: { main: 'new', secondary: 'new' } },
  },
  ...extra,
});

/** 10 and 11: only a global; 12: two globals; 13: own edit and a global; 14: own edit; 15: refused. */
async function state(): Promise<EditorData> {
  const tooltips = [10, 11, 12, 13, 14, 15].map((hash) => make(hash, `Text ${hash}`));
  const library = { ...make(3, 'title G_refill (\nNew\n)'), custom: undefined };
  const pushed: Record<string, string> = { 3: 'f'.repeat(64) };
  for (const tooltip of tooltips)
    pushed[tooltip.hash] = [13, 14].includes(tooltip.hash)
      ? 'e'.repeat(64)
      : await publishableHash(tooltip);
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
      tooltips: Object.fromEntries([library, ...tooltips].map((entry) => [entry.hash, entry])),
      pushed,
      permissions: { users: {} },
      globalsInPlace: {
        revision,
        rows: {
          10: row([refill]),
          11: row([refill]),
          12: row([refill, scaling]),
          13: row([refill]),
          15: row([refill], { refusal: 'Add the translation for G_refill.' }),
        },
      },
    },
  };
}
const view = (rows: ReturnType<typeof reviewRows>, query = '', open: string[] = []) =>
  queueView(rows, query, '', new Set(open), 'hidden');
const groups = (items: ReturnType<typeof view>['items']) =>
  items.filter((item): item is QueueGroup => item.kind === 'group');

beforeEach(() => {
  clearSavedOverlay();
  useReviewSession.setState({ acknowledgments: {}, pushing: false, error: undefined });
});

it('keeps a bundle without the field on the older rows, and refuses a malformed field', async () => {
  const data = await state();
  const { globalsInPlace, ...older } = data.bundle;
  expect((await pendingTooltips({ ...data, bundle: older })).map((e) => e.tooltip.hash)).toEqual([
    13, 14, 3,
  ]);
  expect(bundleSchema.safeParse(older).data?.globalsInPlace).toBeUndefined();
  expect(bundleSchema.safeParse({ ...older, globalsInPlace }).success).toBe(true);
  expect(bundleSchema.safeParse({ ...older, globalsInPlace: { rows: {} } }).success).toBe(false);
});

it('lists a tooltip that only a global changes, never the global files', async () => {
  const entries = await pendingTooltips(await state());
  expect(entries.map(({ tooltip }) => tooltip.hash)).toEqual([10, 11, 12, 13, 14, 15]);
  const only = entries[0]!;
  expect(localKind(only)).toEqual({ kind: 'Global changed' });
  expect(textChanges(only, null)).toEqual([{ lang: 'en', before: 'old', after: 'new' }]);
  expect(publishedOf(only, {})).toEqual({ status: 'ready', tooltip: only.tooltip });
  // Only the two edited tooltips ask the server for their published text.
  expect(publishedRows(entries).map(({ hash }) => hash)).toEqual([13, 14]);
  expect(kindOf(only, publishedOf(only, {}), {})).toEqual({ kind: 'Global changed' });
  expect(localKind(entries[5]!)).toEqual({ kind: 'On hold' });
});

it('counts a leftover whose global changed as a change', async () => {
  const data = await state();
  const alias: EditorData = { ...data, aliases: { 99: { to: 10, kind: 'frame' } } };
  const entries = await pendingTooltips(alias);
  expect(entries.find(({ tooltip }) => tooltip.hash === 10)).toMatchObject({
    markerOnly: false,
    globals: { causes: [refill] },
  });
});

it('groups each global closed, lists own edits apart, and never ticks them in bulk', async () => {
  const entries = await pendingTooltips(await state());
  const rows = reviewRows(entries, {});
  expect(rows.map(rowKey)).toEqual([
    13,
    14,
    '12:g_scaling-001',
    '10:g_refill-0001',
    '11:g_refill-0001',
    '12:g_refill-0001',
    '15:g_refill-0001',
    '13:g_refill-0001',
  ]);
  expect(unitCount(rows)).toBe(6);
  const closed = view(rows);
  expect(groups(closed.items)).toMatchObject([
    { id: 'perk', publishable: [13, 14], collapsed: false },
    { label: 'CombatantScaling', count: 1, publishable: [12], collapsed: true },
    { label: 'G_refill', count: 5, publishable: [10, 11, 12], collapsed: true },
    { label: '1 also has its own edit', publishable: [], collapsed: true },
  ]);
  // Arrow keys stay in what is shown, until a group is opened.
  expect(stepRow(closed, 1, 1)).toBe(1);
  expect(rowKey(closed.ordered[stepRow(closed, 3, 1)]!)).toBe('11:g_refill-0001');
  const open = view(rows, '', ['~global:g_refill-0001']);
  expect(rowKey(open.ordered[stepRow(open, 1, 1)]!)).toBe('10:g_refill-0001');
  // Find opens the groups it matches in, and "Include all" there still leaves own edits out.
  const found = view(rows, 'g_refill');
  expect(groups(found.items).every(({ collapsed }) => !collapsed)).toBe(true);
  expect(publishableHashes(found.ordered)).toEqual([10, 11, 12]);
  // One tick per tooltip, whichever group it was ticked in.
  expect(publishSelection(new Set([12, 15]), entries, new Set())).toHaveLength(1);
});

it('waits for no tooltip that only a global changes', async () => {
  const data = await state();
  data.bundle.tooltips[14] = make(14, 'import main from 10\nimport main from 13');
  const entries = await pendingTooltips(data);
  const pick = (...hashes: number[]) =>
    entries.filter(({ tooltip }) => hashes.includes(tooltip.hash));
  expect(() => planReviewedPublish(pick(14), entries, data)).toThrow('Include Perk 13');
  expect(planReviewedPublish(pick(13, 14), entries, data)).toHaveLength(2);
});

it('publishes with the reviewed definitions', async () => {
  const data = await state();
  useDataStore.setState({ data });
  useAuthStore.setState({ user: { id: 1, login: 'fixture', role: 'maintainer' } });
  const create = vi.spyOn(publishDriver, 'create').mockResolvedValue({} as never);
  const entries = await pendingTooltips(data);
  const inputs = planReviewedPublish(entries.slice(0, 1), entries, data);
  expect(await queuePublish(inputs, data, () => true)).toBe(true);
  expect(create).toHaveBeenCalledWith(
    [expect.objectContaining({ hash: 10, digest: data.bundle.pushed[10] })],
    revision,
  );
});

it('clears a published row until the bundle knows, then trusts the bundle again', async () => {
  const data = await state();
  const marker = data.bundle.pushed[10]!;
  const published = { digest: marker, previous: marker, globalsRevision: revision };
  const pending = async (value: EditorData) =>
    (await pendingTooltips(value, acknowledgedMarkers(value), acknowledgedGlobals(value))).map(
      ({ tooltip }) => tooltip.hash,
    );
  useReviewSession.setState({ acknowledgments: { 10: published } });
  expect(await pending(data)).toEqual([11, 12, 13, 14, 15]);
  // A reload that still predates the publish keeps it cleared.
  expect(await pending({ ...data, bundle: { ...data.bundle } })).toEqual([11, 12, 13, 14, 15]);
  const inPlace = data.bundle.globalsInPlace!;
  const newer = { ...inPlace, revision: 'b'.repeat(40) };
  // Newer definitions are a new change.
  expect(await pending({ ...data, bundle: { ...data.bundle, globalsInPlace: newer } })).toContain(
    10,
  );
  expect(useReviewSession.getState().acknowledgments).toEqual({});
});

it('holds a tooltip saved after its comparison was built', async () => {
  const data = await state();
  const saved = make(13, 'Saved just now');
  rememberSaved([saved]);
  data.bundle.tooltips[13] = saved;
  const entries = await pendingTooltips(data);
  expect(entries.find(({ tooltip }) => tooltip.hash === 13)?.unpublishable).toContain('Refresh');
  expect(entries.find(({ tooltip }) => tooltip.hash === 14)?.unpublishable).toBeUndefined();
});
