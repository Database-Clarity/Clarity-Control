import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { StaticRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Layout } from './Layout';
import { useAuthStore } from '../../stores/auth';
import type { User } from '../../services/api';

vi.mock('../../services/save/SavePanel', () => ({
  SavePanel: () => null,
  SaveController: () => null,
}));
vi.mock('../compendium/CompendiumBadge', () => ({
  CompendiumBadge: () => null,
  CompendiumWarmup: () => null,
  useCompendiumCount: () => ({ state: 'ready', count: 0 }),
}));
// Zustand renders its initial state on the server; read the live state instead.
vi.mock('../../stores/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../stores/auth')>();
  return {
    ...actual,
    useAuthStore: Object.assign(
      (selector: (state: ReturnType<typeof actual.useAuthStore.getState>) => unknown = (s) => s) =>
        selector(actual.useAuthStore.getState()),
      actual.useAuthStore,
    ),
  };
});

function tabs(user: User | null, loading = false): { labels: string[]; more: boolean } {
  useAuthStore.setState({ user, loading });
  const html = renderToStaticMarkup(
    createElement(StaticRouter, { location: '/' }, createElement(Layout)),
  );
  const nav = /<nav aria-label="Workspaces"[^>]*>(.*?)<\/nav>/s.exec(html)?.[1] ?? '';
  return {
    labels: [...nav.matchAll(/<a [^>]*>(.*?)(?:<span|<\/a>)/g)].map((match) => match[1]),
    more: nav.includes('aria-haspopup="menu"'),
  };
}
const person = (role: User['role']) => ({ login: 'p', role, languages: ['de'] }) as unknown as User;

describe('Layout workspace tabs per role', () => {
  afterEach(() => useAuthStore.setState({ user: null, loading: false }));

  it('gives maintainers and editors four tabs and a More menu', () => {
    for (const role of ['maintainer', 'editor'] as const) {
      expect(tabs(person(role))).toEqual({
        labels: ['Editor', 'Review changes', 'Compendium', 'Translations'],
        more: true,
      });
    }
  });

  it('gives trial editors Bungie drift as a tab and no More menu', () => {
    expect(tabs(person('trial'))).toEqual({
      labels: ['Editor', 'Compendium', 'Translations', 'Bungie drift'],
      more: false,
    });
  });

  it('offers translators only the pages they can act on', () => {
    expect(tabs(person('translator'))).toEqual({ labels: ['Editor', 'Translations'], more: false });
  });

  it('shows signed-out visitors, role-less accounts and the loading moment the read-only Editor only', () => {
    for (const [user, loading] of [
      [null, false],
      [null, true],
      [person(null), false],
    ] as const) {
      expect(tabs(user, loading)).toEqual({ labels: ['Editor'], more: false });
    }
  });

  it('does not render a Globals tab for any role', () => {
    for (const role of ['maintainer', 'editor', 'trial', 'translator'] as const) {
      expect(tabs(person(role)).labels).not.toContain('Globals');
    }
  });
});
