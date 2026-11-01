import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { HashRouter } from 'react-router-dom';
import type { Tooltip } from '@clarity/core';
import { App } from '../src/App';
import { useAuthStore } from '../src/stores/auth';
import { useDataStore, type EditorData } from '../src/stores/data';
import { useDraftStore } from '../src/stores/drafts';
import '../src/ui/global.scss';

window.fetch = async () => {
  throw new Error('Network blocked by translator regression fixture');
};

const tooltips: Record<number, Tooltip> = {};
const items: EditorData['items'] = {};
for (let hash = 10; hash <= 70; hash++) {
  tooltips[hash] = {
    hash,
    text: {
      en: { text: `English ${hash}`, updatedAt: '2026-10-27T00:00:00Z', updatedBy: 'fixture' },
      fr: {
        text: `French ${hash}`,
        updatedAt: '2025-01-01T00:00:00Z',
        updatedBy: 'fixture',
        sourceUpdatedAt: '2025-01-01T00:00:00Z',
      },
    },
    associated: [],
  };
  items[hash] = {
    hash,
    name: `Fixture ${hash}`,
    icon: '',
    categoryId: 'fixture',
    inGameDescription: '',
  };
}
const data: EditorData = {
  categories: [{ id: 'fixture', label: 'Fixture', group: 'Fixture', order: 1 }],
  items,
  aliases: { 40: { to: 10, kind: 'sandbox' } },
  bundle: {
    sourceCommit: 'fixture',
    generatedAt: '2026-10-27T00:00:00Z',
    tooltips,
    permissions: { users: {} },
    pushed: {},
  },
};
useDataStore.setState({ data, status: 'ready', load: async () => {} });
useAuthStore.setState({
  user: { id: 1, login: 'fixture', role: 'translator', languages: ['de', 'fr'] },
  loading: false,
  load: async () => {},
});
useDraftStore.setState({
  hydrated: true,
  drafts: { 10: { base: tooltips[10], next: tooltips[10] } },
  hydrate: async () => {},
});

const result = document.getElementById('result')!;
const root = document.getElementById('root')!;
window.location.hash = '#/translations?lang=fr&status=outdated';
createRoot(root).render(createElement(HashRouter, null, createElement(App)));

async function waitFor(predicate: () => boolean, description: string) {
  const deadline = performance.now() + 5000;
  while (!predicate()) {
    if (performance.now() > deadline) throw new Error(`Timed out: ${description}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function button(text: string): HTMLButtonElement {
  const found = [...document.querySelectorAll<HTMLButtonElement>('main button')].find((item) =>
    item.textContent?.includes(text),
  );
  if (!found) throw new Error(`Missing button: ${text}`);
  return found;
}

function size(
  label: string,
  element: Element | null,
  measurements: Record<string, { width: number; height: number }>,
) {
  if (!element) throw new Error(`Missing control: ${label}`);
  const { width, height } = element.getBoundingClientRect();
  measurements[label] = { width, height };
  if (width < 44 || height < 44)
    throw new Error(`${label}: ${width}x${height}px, expected at least 44x44px`);
}

async function run() {
  if (window.innerWidth > 700) throw new Error('Run this regression at a width of 700px or less');
  const measurements: Record<string, { width: number; height: number }> = {};
  await waitFor(
    () =>
      document.querySelectorAll('main .cm-content').length === 0 &&
      document.querySelector('main input[type="search"]') !== null,
    'worklist',
  );
  size('worklist language', document.querySelector('main select'), measurements);
  size('worklist search', document.querySelector('main input[type="search"]'), measurements);
  const openNext = [...document.querySelectorAll<HTMLAnchorElement>('main a')].find(
    (item) => item.textContent?.trim() === 'Open next',
  );
  size('Open next', openNext ?? null, measurements);
  for (const text of ['Missing', 'Outdated', 'All', 'Show more', 'Show English changes']) {
    size(text, button(text), measurements);
  }
  button('Show English changes').click();
  await waitFor(
    () => document.body.textContent?.includes('Retry history') === true,
    'history error',
  );
  size('Retry history', button('Retry history'), measurements);
  size('Hide English changes', button('Hide English changes'), measurements);

  window.location.hash = '#/t/40?lang=fr&line=3&variant=40';
  await waitFor(
    () =>
      window.location.hash === '#/t/10?lang=fr' &&
      document.querySelector('main .cm-content') !== null,
    'translator alias redirect',
  );
  const language = document.querySelector<HTMLSelectElement>('main article header select');
  if (
    language?.value !== 'fr' ||
    !document.querySelector('main .cm-content')?.textContent?.includes('French 10')
  ) {
    throw new Error('Translator alias did not retain the French editor');
  }
  size('tooltip language', language, measurements);
  size('discard draft', button("Discard this tooltip's draft"), measurements);

  window.location.hash = '#/t/40?lang=en';
  await waitFor(
    () =>
      window.location.hash === '#/t/10?lang=en' &&
      document.body.textContent?.includes('Switch to de') === true,
    'read-only shortcut',
  );
  size('read-only shortcut', button('Switch to de'), measurements);

  useAuthStore.setState({ user: { id: 2, login: 'fixture-editor', role: 'editor' } });
  window.location.hash = '#/t/40?lang=fr';
  await waitFor(
    () =>
      window.location.hash === '#/t/10?lang=fr' &&
      document.querySelector<HTMLSelectElement>('main article header select')?.value === 'fr',
    'editor alias redirect',
  );
  if (!document.querySelector('main .cm-content')?.textContent?.includes('French 10')) {
    throw new Error('Editor alias did not retain the French editor');
  }
  result.textContent = `PASS ${JSON.stringify(measurements)}`;
}

void run().catch((error: unknown) => {
  result.textContent = `FAIL ${error instanceof Error ? error.stack : String(error)}`;
});
