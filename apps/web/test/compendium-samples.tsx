import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { HashRouter } from 'react-router-dom';
import type { CompendiumData, Tooltip } from '@clarity/core';
import { App } from '../src/App';
import { useAuthStore } from '../src/stores/auth';
import { useDataStore, type EditorData } from '../src/stores/data';
import { useDraftStore } from '../src/stores/drafts';
import { useCompendiumStore } from '../src/features/compendium/store';
import { bundleUrl } from '../src/services/bundle';
import { compendiumDataUrl } from '../src/services/compendium';
import { guidanceResponseSchema } from '../src/features/compendium/guidanceSchema';
import '../src/ui/global.scss';

const nativeFetch = window.fetch.bind(window);
const blocked: string[] = [];
window.fetch = async (input, init) => {
  const url = new URL(
    typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
    window.location.href,
  );
  if (url.origin === window.location.origin && url.pathname === '/__review-guidance')
    return nativeFetch(input, init);
  blocked.push(url.href);
  throw new Error(`Network blocked by sample fixture: ${url.href}`);
};

const timestamp = '2026-11-01T00:00:00Z';
const source: CompendiumData = {
  fetchedAt: timestamp,
  tabs: [{ gid: '1662574278', name: 'Weapon Perks', rows: [] }],
};
const tooltips: Record<number, Tooltip> = {};
const items: EditorData['items'] = {};
const categories: EditorData['categories'] = [];
for (let group = 0; group < 24; group++) {
  const categoryId = group === 0 ? 'weapon-trait' : `fixture-${group}`;
  categories.push({
    id: categoryId,
    label: group === 0 ? 'Synthetic weapon traits' : `Synthetic category ${group + 1}`,
    group: 'Fixture',
    order: group,
  });
  for (let index = 0; index < 12; index++) {
    const hash = 100 + group * 20 + index;
    const name = `Sample ${hash}`;
    const description =
      index === 1
        ? 'When you reload, gain bonus damage.'
        : index === 2
          ? 'Gain 20% damage.'
          : index === 3
            ? 'First line.\nSecond line.'
            : index === 4
              ? 'Long sample mechanics with full content available. '.repeat(40)
              : index === 5
                ? ''
                : 'Simple sample mechanics.';
    tooltips[hash] = {
      hash,
      text: {
        en: {
          text: `Authored text for ${name}.`,
          updatedAt: timestamp,
          updatedBy: 'fixture',
        },
      },
      associated: [],
    };
    items[hash] = {
      hash,
      name,
      categoryId,
      inGameDescription: description,
      icon: '',
      ...(index === 1 ? { owners: [1000, 1001] } : {}),
      ...(index === 2 ? { baseHash: 1000 } : {}),
    };
    if (index !== 6)
      source.tabs[0].rows.push({
        rowIndex: hash,
        name,
        nameNorm: name.toLowerCase(),
        section: index % 2 ? 'Conditional mechanics' : 'General mechanics',
        cell: {
          plain: description || `Source description for ${name}.`,
          runs: [{ text: description || `Source description for ${name}.`, bold: true }],
        },
      });
  }
}
const data: EditorData = {
  categories,
  items,
  aliases: {},
  bundle: {
    sourceCommit: 'synthetic-sample-fixture',
    generatedAt: timestamp,
    tooltips,
    permissions: { users: {} },
    pushed: {},
  },
};

async function disk() {
  const response = await window.fetch('/__review-guidance', { cache: 'no-store' });
  if (!response.ok) throw new Error(`Fixture guidance GET failed: ${response.status}`);
  return guidanceResponseSchema.parse(await response.json());
}
async function write(payload: unknown) {
  const response = await window.fetch('/__review-guidance', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!response.ok) throw new Error(`Fixture guidance POST failed: ${response.status}`);
}
const result = document.getElementById('result')!;
function failure(error: unknown) {
  result.textContent = `FAIL: ${error instanceof Error ? error.message : String(error)}`;
}
async function start() {
  const current = await disk();
  const scope = `${bundleUrl}|${compendiumDataUrl}`;
  if (!current.document) {
    await write({
      revision: current.revision,
      document: {
        version: 1,
        scope,
        baseline: 'legacy-synthetic-baseline',
        categories: {
          'catalog:weapon-trait': {
            id: 'catalog:weapon-trait',
            name: 'Legacy synthetic traits',
            rule: 'Legacy fixture category',
            count: 1,
            hashes: [100],
            active: true,
            comment: 'Synthetic legacy comment: preserve this.',
          },
          'catalog:retired-fixture': {
            id: 'catalog:retired-fixture',
            name: 'Retired synthetic category',
            rule: 'Historical fixture category',
            count: 1,
            hashes: [9999],
            active: false,
            comment: 'Synthetic archived comment: preserve this too.',
          },
        },
      },
    });
  } else if (current.document.scope !== scope || !current.document.baseline.includes('synthetic')) {
    throw new Error('Run this fixture only in a dedicated checkout with synthetic guidance.');
  }
  useDataStore.setState({ data, status: 'ready', load: async () => {} });
  useAuthStore.setState({ user: null, loading: false, load: async () => {} });
  useDraftStore.setState({ hydrated: true, drafts: {}, hydrate: async () => {} });
  useCompendiumStore.setState({ data: source, load: async () => {} });
  Object.assign(window, {
    sampleFixture: {
      readState: () => ({
        draftHashes: Object.keys(useDraftStore.getState().drafts),
        blocked,
        signedOut: useAuthStore.getState().user === null,
      }),
    },
  });
  document.getElementById('change-manifest')!.addEventListener('click', () => {
    const changed = {
      ...data,
      items: Object.fromEntries(
        Object.entries(data.items).map(([hash, item]) => [
          hash,
          {
            ...item,
            inGameDescription: `Changed mechanics. ${item.inGameDescription}\n${'Long changed manifest evidence. '.repeat(80)}`,
          },
        ]),
      ),
    };
    useDataStore.setState({ data: changed });
    result.textContent = 'Manifest changed without changing authored/source baseline';
  });
  document.getElementById('concurrent-edit')!.addEventListener('click', () => {
    void (async () => {
      const latest = await disk();
      if (!latest.document) throw new Error('Missing synthetic guidance');
      latest.document.categories['catalog:weapon-trait'].comment =
        `Synthetic concurrent reviewer comment ${new Date().toISOString()}`;
      await write(latest);
      result.textContent = 'Concurrent synthetic disk edit recorded';
    })().catch(failure);
  });
  createRoot(document.getElementById('root')!).render(
    createElement(HashRouter, null, createElement(App)),
  );
  result.textContent = 'Ready: signed out; only this checkout guidance endpoint is allowed';
}
void start().catch(failure);
