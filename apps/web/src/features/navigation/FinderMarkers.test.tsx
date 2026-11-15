// @vitest-environment jsdom
import { act, Profiler } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import type { CompendiumData, Tooltip } from '@clarity/core';
import type { EditorData } from '../../stores/data';
import { useDraftStore } from '../../stores/drafts';
import { upcomingStore } from '../tooltip/UpcomingSwitch.store';
import { contrastRatio } from '../compendium/sheetSurface';
import { readFileSync } from 'node:fs';
import { FinderMarkers } from './FinderMarkers';
import {
  Missing,
  Outdated,
  prepareFinderMarkers,
  rollupFinderMarkers,
  savedFinderMarkers,
} from './finderMarkerState';

const cell = { plain: 'text', runs: [{ text: 'text' }] };
const source: CompendiumData = {
  fetchedAt: '2026-11-15T00:00:00Z',
  tabs: [
    {
      gid: '1',
      name: 'Weapon Perks',
      rows: [{ name: 'Test', nameNorm: 'test', rowIndex: 1, cell }],
    },
  ],
};
const text = (value = 'English', updatedAt = '2026-11-15T00:00:00Z') => ({
  text: value,
  updatedAt,
  updatedBy: 'test',
});
const tooltip: Tooltip = {
  hash: 10,
  associated: [],
  text: { en: text(), de: { ...text('Deutsch'), sourceUpdatedAt: '2026-11-14T00:00:00Z' } },
  compendium: {
    gid: '1',
    rowKey: 'Test',
    snapshot: { plain: 'old', runs: [{ text: 'old' }] },
    snapshotAt: '2026-11-14T00:00:00Z',
  },
};
function fixture(): EditorData {
  return {
    categories: [],
    aliases: {},
    items: {
      10: {
        hash: 10,
        name: 'Test',
        categoryId: 'weapon-perk',
        icon: '',
        inGameDescription: 'Effect',
      },
    },
    bundle: { tooltips: {} },
  } as unknown as EditorData;
}
const original = useDraftStore.getState();
afterEach(() => {
  useDraftStore.setState(original);
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

it('uses saved English, and excludes placeholders, empty frames, stat-only parts, and derived pairs', () => {
  const data = fixture();
  expect(savedFinderMarkers(10, data, null, 'en')).toBe(Missing);
  data.bundle.tooltips[10] = { ...tooltip, text: { en: text('  ') } };
  expect(savedFinderMarkers(10, data, null, 'en')).toBe(Missing);
  data.bundle.tooltips[10] = tooltip;
  expect(savedFinderMarkers(10, data, null, 'en')).toBe(0);
  delete data.bundle.tooltips[10];
  for (const categoryId of ['inactive-placeholder', 'weapon-perk-enhanced', 'weapon-frame']) {
    data.items[10] = { ...data.items[10], categoryId, inGameDescription: '' };
    expect(savedFinderMarkers(10, data, null, 'en'), categoryId).toBe(0);
  }
  data.items[10] = { ...data.items[10], categoryId: 'weapon-perk', hiddenFromEditor: true };
  expect(savedFinderMarkers(10, data, null, 'en')).toBe(0);
  data.items[52780822] = {
    hash: 52780822,
    name: 'Balanced Guard',
    categoryId: 'weapon-perk',
    icon: '',
    inGameDescription: 'Sword Guard has balanced overall defenses.',
  };
  expect(savedFinderMarkers(52780822, data, null, 'en')).toBe(0);
});

it('uses Compendium changes for English and the existing translation rule for other languages', () => {
  const data = fixture();
  data.bundle.tooltips[10] = tooltip;
  expect(savedFinderMarkers(10, data, source, 'en')).toBe(Outdated);
  expect(savedFinderMarkers(10, data, { ...source, tabs: [] }, 'en')).toBe(Outdated);
  expect(savedFinderMarkers(10, data, null, 'de')).toBe(Outdated);
  expect(savedFinderMarkers(10, data, source, 'fr')).toBe(0);
  data.bundle.tooltips[10] = {
    ...tooltip,
    compendium: { ...tooltip.compendium!, snapshot: cell },
    text: {
      ...tooltip.text,
      de: { ...tooltip.text.de!, sourceUpdatedAt: tooltip.text.en!.updatedAt },
    },
  };
  expect(savedFinderMarkers(10, data, source, 'en')).toBe(0);
  expect(savedFinderMarkers(10, data, source, 'de')).toBe(0);
});

it('caches its idle index and rolls the same marker kinds up without counts', async () => {
  const data = fixture();
  data.bundle.tooltips[11] = { ...tooltip, hash: 11 };
  const first = prepareFinderMarkers(data, source, 'en');
  expect(prepareFinderMarkers(data, source, 'en')).toBe(first);
  const index = await first;
  expect(rollupFinderMarkers([10, 11], index)).toBe(Missing | Outdated);
  const refreshed = {
    ...data,
    bundle: { ...data.bundle, tooltips: { ...data.bundle.tooltips, 10: tooltip } },
  };
  expect((await prepareFinderMarkers(refreshed, source, 'en')).get(10)).toBe(Outdated);
});

it('updates drafts, save/discard, and scheduled membership while mounted, with no flag-off store work', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const commits = vi.fn();
  const has = (label: string) => !!host.querySelector(`[role="img"][aria-label="${label}"]`);
  try {
    vi.stubEnv('VITE_SCHEDULED_ENABLED', '0');
    useDraftStore.setState({ drafts: {}, hydrated: true });
    await act(async () =>
      root.render(
        <Profiler id="markers" onRender={commits}>
          <FinderMarkers hashes={[10, 11]} flags={Missing | Outdated} />
        </Profiler>,
      ),
    );
    expect(has('Missing tooltip')).toBe(true);
    expect(has('Outdated')).toBe(true);
    expect(has('Scheduled')).toBe(false);
    expect(host.querySelector('[title]')).toBeNull();
    await act(async () => useDraftStore.getState().edit(tooltip, 'en', 'Draft', 'test'));
    expect(has('Unsaved changes')).toBe(true);
    commits.mockClear();
    await act(async () => useDraftStore.getState().edit(tooltip, 'en', 'Second edit', 'test'));
    expect(commits).not.toHaveBeenCalled();
    expect(host.querySelectorAll('[aria-label="Unsaved changes"]')).toHaveLength(1);
    await act(async () => useDraftStore.getState().discard(10));
    expect(has('Unsaved changes')).toBe(false);
    await act(async () =>
      useDraftStore.setState({ drafts: { 11: { base: tooltip, next: tooltip } } }),
    );
    expect(has('Unsaved changes')).toBe(true);
    await act(async () => useDraftStore.setState({ drafts: {} }));
    expect(has('Unsaved changes')).toBe(false);
    vi.stubEnv('VITE_SCHEDULED_ENABLED', '1');
    upcomingStore().setState({
      memberOf: {
        10: {
          id: 'batch',
          name: 'Batch',
          status: 'scheduled',
          hashes: [10],
          notBefore: null,
          revision: 1,
        },
      },
    });
    await act(async () => root.render(<FinderMarkers hashes={[10, 11]} />));
    expect(has('Scheduled')).toBe(true);
    await act(async () => upcomingStore().setState({ memberOf: {} }));
    expect(has('Scheduled')).toBe(false);
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

it('keeps the marker tokens at 3:1 on base, hover, and selected rows in both themes', () => {
  const css = readFileSync('apps/web/src/ui/tokens.scss', 'utf8');
  for (const theme of ['dark', 'light']) {
    const body = css.split(`@mixin ${theme}-tokens {`)[1].split('\n}')[0];
    const tokens = Object.fromEntries(
      [...body.matchAll(/--([\w-]+):\s*(#[\da-f]{6});/g)].map((m) => [m[1], m[2]]),
    );
    for (const fg of ['warn', 'accent-ink', 'text2'])
      for (const bg of ['raised', 'hover', 'sel'])
        expect(
          contrastRatio(tokens[fg], tokens[bg]),
          `${theme}: ${fg} on ${bg}`,
        ).toBeGreaterThanOrEqual(3);
  }
});
