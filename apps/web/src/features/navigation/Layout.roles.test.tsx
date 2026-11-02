import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { StaticRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Layout } from './Layout';
import { useAuthStore } from '../../stores/auth';
import type { User } from '../../services/api';

vi.mock('../../services/save/SavePanel', () => ({
  SavePanel: ({ className }: { className?: string }) =>
    createElement('div', { className, 'data-testid': 'save-dock' }),
}));
vi.mock('../compendium/CompendiumBadge', () => ({
  CompendiumBadge: () => createElement('div', { 'data-testid': 'compendium-badge' }),
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

function workspaceOptions(user: User | null, location = '/'): string[] {
  useAuthStore.setState({ user, loading: false });
  const html = renderToStaticMarkup(
    createElement(StaticRouter, { location }, createElement(Layout)),
  );
  const select = /<select[^>]*>(.*?)<\/select>/s.exec(html)?.[1] ?? '';
  return [...select.matchAll(/<option[^>]*>(.*?)<\/option>/g)].map((match) => match[1]);
}
const person = (role: User['role']) => ({ login: 'p', role, languages: ['de'] }) as unknown as User;

describe('Layout workspace links per role', () => {
  afterEach(() => useAuthStore.setState({ user: null, loading: false }));

  it('offers translators only the pages they can act on', () => {
    expect(workspaceOptions(person('translator'))).toEqual([
      'Tooltip editor',
      'Translations',
      'Globals',
    ]);
  });

  it('keeps the other roles unchanged, with Administration for maintainers only', () => {
    const full = [
      'Tooltip editor',
      'Review changes',
      'Compendium',
      'Bungie drift',
      'Archive',
      'Translations',
      'Globals',
    ];
    expect(workspaceOptions(person('maintainer'))).toEqual([...full, 'Administration']);
    for (const user of [person('editor'), person('trial'), null]) {
      expect(workspaceOptions(user)).toEqual(full);
    }
  });
  it('keeps exactly one measured save dock and the Compendium badge in the mobile shell', () => {
    useAuthStore.setState({ user: person('translator'), loading: false });
    const html = renderToStaticMarkup(
      createElement(StaticRouter, { location: '/translations' }, createElement(Layout)),
    );
    expect(html.match(/data-testid="save-dock"/g)).toHaveLength(1);
    expect(html).toMatch(/class="[^"]*saveDock[^"]*" data-testid="save-dock"/);
    expect(html.match(/data-testid="compendium-badge"/g)).toHaveLength(1);
    expect(html).toContain('aria-controls="sidebar"');
  });
});
