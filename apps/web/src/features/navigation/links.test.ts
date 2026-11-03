import { describe, expect, it } from 'vitest';
import { links, visibleLinks, workspaceMenu, workspacePath } from './links';

const split = (role: Parameters<typeof workspaceMenu>[0]) => {
  const { primary, more } = workspaceMenu(role);
  return { primary: primary.map(({ to }) => to), more: more.map(({ to }) => to) };
};

describe('workspaceMenu', () => {
  it('lists every workspace page in order, Globals included only as a page', () => {
    expect(links.map(({ to }) => to)).toEqual([
      '/',
      '/review',
      '/compendium',
      '/translations',
      '/drift',
      '/lost-text',
      '/archive',
      '/globals',
      '/admin',
    ]);
  });

  it.each([
    [
      'maintainer',
      {
        primary: ['/', '/review', '/compendium', '/translations'],
        more: ['/drift', '/lost-text', '/archive', '/admin'],
      },
    ],
    [
      'editor',
      {
        primary: ['/', '/review', '/compendium', '/translations'],
        more: ['/drift', '/lost-text', '/archive'],
      },
    ],
    ['trial', { primary: ['/', '/compendium', '/translations', '/drift'], more: [] }],
    ['translator', { primary: ['/', '/translations'], more: [] }],
    [null, { primary: ['/'], more: [] }],
  ] as const)('role %s sees %j', (role, expected) => {
    expect(split({ role })).toEqual(expected);
  });

  it('gives signed-out, loading and role-less visitors the read-only Editor only', () => {
    for (const user of [null, undefined, { role: null }]) {
      expect(split(user)).toEqual({ primary: ['/'], more: [] });
    }
  });

  it('never offers Globals as a tab to anyone', () => {
    for (const role of ['maintainer', 'editor', 'trial', 'translator', null] as const) {
      expect(visibleLinks({ role }).some(({ to }) => to === '/globals')).toBe(false);
    }
  });

  it('keeps labels intact and returns fresh arrays', () => {
    const { primary } = workspaceMenu({ role: 'translator' });
    expect(primary.map(({ label }) => label)).toEqual(['Editor', 'Translations']);
    primary.pop();
    expect(workspaceMenu({ role: 'translator' }).primary).toHaveLength(2);
  });
});

describe('workspacePath', () => {
  it('maps pages to their workspace', () => {
    expect(workspacePath('/t/12')).toBe('/');
    expect(workspacePath('/')).toBe('/');
    expect(workspacePath('/compendium/review')).toBe('/compendium');
    expect(workspacePath('/globals/variable/damage')).toBe('/globals');
  });
});
