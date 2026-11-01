import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { StaticRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Tooltip } from '@clarity/core';
import { TranslationsPage } from './TranslationsPage';
import { useAuthStore } from '../../stores/auth';
import { useDataStore, type EditorData } from '../../stores/data';
import type { User } from '../../services/api';

vi.mock('./EnglishDiff', () => ({
  EnglishDiff: () => createElement('div', { 'data-diff': '' }),
}));

// Zustand renders its initial state on the server; read the live state instead.
function liveStore<T extends { getState(): unknown }>(store: T) {
  return Object.assign(
    (selector: (state: ReturnType<T['getState']>) => unknown = (state) => state) =>
      selector(store.getState() as ReturnType<T['getState']>),
    store,
  );
}
vi.mock('../../stores/data', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../stores/data')>();
  return { ...actual, useDataStore: liveStore(actual.useDataStore) };
});
vi.mock('../../stores/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../stores/auth')>();
  return { ...actual, useAuthStore: liveStore(actual.useAuthStore) };
});

const stamp = { updatedBy: 'x' };
function tooltip(hash: number, en: string, de?: { text: string; source: string }): Tooltip {
  return {
    hash,
    associated: [],
    text: {
      en: { text: en, updatedAt: '2026-02-01T00:00:00.000Z', ...stamp },
      ...(de
        ? {
            de: {
              text: de.text,
              updatedAt: '2026-01-01T00:00:00.000Z',
              sourceUpdatedAt: de.source,
              ...stamp,
            },
          }
        : {}),
    },
  };
}
const data: EditorData = {
  categories: [],
  items: {
    1: { hash: 1, name: 'Missing Perk', icon: '', categoryId: 'c', inGameDescription: '' },
    2: { hash: 2, name: 'Outdated Perk', icon: '', categoryId: 'c', inGameDescription: '' },
    3: { hash: 3, name: 'Current Perk', icon: '', categoryId: 'c', inGameDescription: '' },
  },
  aliases: {},
  bundle: {
    sourceCommit: 'abc',
    generatedAt: '2026-02-01T00:00:00Z',
    tooltips: {
      1: tooltip(1, 'English one'),
      2: tooltip(2, 'English two', { text: 'Zwei', source: '2026-01-01T00:00:00.000Z' }),
      3: tooltip(3, 'English three', { text: 'Drei', source: '2026-02-01T00:00:00.000Z' }),
    },
    permissions: { users: {} },
    pushed: {},
  },
};

function render(location: string, user: User | null): string {
  useAuthStore.setState({ user, loading: false });
  return renderToStaticMarkup(
    createElement(StaticRouter, { location }, createElement(TranslationsPage)),
  );
}
const person = (role: User['role'], languages?: string[]) =>
  ({ login: 'person', role, languages }) as unknown as User;

describe('TranslationsPage worklist', () => {
  beforeEach(() => useDataStore.setState({ status: 'ready', data }));
  afterEach(() => useAuthStore.setState({ user: null, loading: false }));

  it('defaults to missing entries and links each card to the tooltip in that language', () => {
    const html = render('/translations', person('translator', ['de']));
    expect(html).toContain('Translation worklist');
    expect(html).toContain('href="/t/1?lang=de"');
    expect(html).toContain('Missing Perk');
    expect(html).not.toContain('Outdated Perk');
    expect(html).not.toContain('Current Perk');
    expect(html).toContain('Not translated yet');
    expect(html).toMatch(/aria-pressed="true"[^>]*>Missing \(1\)</);
    expect(html).toContain('Open next');
  });

  it('shows outdated entries with the English diff and "Open next" on the first one', () => {
    const html = render('/translations?status=outdated', person('translator', ['de']));
    expect(html).toContain('href="/t/2?lang=de"');
    expect(html).not.toContain('Missing Perk');
    expect(html).toContain('data-diff');
    expect(html).toContain('31 days behind English');
    expect(html).toMatch(/<a[^>]*href="\/t\/2\?lang=de"[^>]*>Open next/);
  });

  it('shows every state under All but never opens current entries as next', () => {
    const html = render('/translations?status=all', person('translator', ['de']));
    for (const name of ['Missing Perk', 'Outdated Perk', 'Current Perk']) {
      expect(html).toContain(name);
    }
    expect(html).toContain('Up to date');
    expect(html).toMatch(/<a[^>]*href="\/t\/2\?lang=de"[^>]*>Open next/);
    expect(html).toContain('3 translations in this view');
  });

  it('searches by name and shows an empty message without a next link', () => {
    const found = render('/translations?status=all&q=drei', person('translator', ['de']));
    expect(found).toContain('Current Perk');
    expect(found).not.toContain('Outdated Perk');
    expect(found).not.toContain('Open next');
    const none = render('/translations?q=zzz', person('translator', ['de']));
    expect(none).toContain('Nothing to show for these filters.');
  });

  it('limits a translator to assigned languages', () => {
    const html = render('/translations?status=all', person('translator', ['fr']));
    expect(html).toContain('Your assigned languages: French.');
    expect(html).toContain('href="/t/1?lang=fr"');
    expect(html).not.toContain('lang=de');
    expect(html).not.toMatch(/<option value="de"/);
    expect(html).toContain('All assigned languages');
    const unavailable = render('/translations?lang=de', person('translator', ['fr']));
    expect(unavailable).toContain('Unavailable language (German)');
    expect(unavailable).not.toContain('href="/t/1?lang=de"');
  });

  it('tells a translator without languages that nothing can be translated', () => {
    const html = render('/translations', person('translator', []));
    expect(html).toContain('Your assigned languages: none.');
    expect(html).toContain('You have no assigned languages');
    expect(html).not.toContain('Open next');
  });

  it('shows all languages to maintainers, editors and signed-out visitors', () => {
    for (const user of [person('maintainer'), person('editor'), person('trial'), null]) {
      const html = render('/translations', user);
      expect(html).toContain('All languages');
      expect(html).toContain('<option value="de">German</option>');
      expect(html).toContain('<option value="fr">French</option>');
      expect(html).toContain('href="/t/1?lang=de"');
      expect(html).toContain('href="/t/1?lang=fr"');
      expect(html).not.toContain('Your assigned languages');
    }
  });

  it('shows a loading state for the user and nothing without data', () => {
    useAuthStore.setState({ loading: true });
    expect(
      renderToStaticMarkup(
        createElement(StaticRouter, { location: '/' }, createElement(TranslationsPage)),
      ),
    ).toContain('Loading your translation languages');
    useDataStore.setState({ data: null });
    useAuthStore.setState({ loading: false });
    expect(render('/translations', null)).toBe('');
  });
});
