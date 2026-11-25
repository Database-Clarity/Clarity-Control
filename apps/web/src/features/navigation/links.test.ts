import { describe, expect, it, vi } from 'vitest';
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
      '/sandbox-perks',
      '/archive',
      '/globals',
      '/management',
      '/exports',
      '/tooltips',
    ]);
  });

  it.each([
    [
      'maintainer',
      {
        primary: ['/', '/review', '/compendium', '/translations'],
        more: ['/drift', '/lost-text', '/sandbox-perks', '/archive', '/management', '/exports'],
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

  it('gives translators Review only while they can publish their own languages', () => {
    const user = {
      role: 'translator' as const,
      languages: ['de' as const],
      translationPublish: { version: 'translation-publish-v1' as const, partRows: 12 },
    };
    const without = { primary: ['/', '/translations'], more: [] };
    expect(split(user)).toEqual(without); // This build has no publisher.
    vi.stubEnv('VITE_PUBLISHER_ENABLED', '1');
    try {
      expect(split(user)).toEqual({ primary: ['/', '/review', '/translations'], more: [] });
      expect(split({ ...user, translationPublish: undefined })).toEqual(without);
      // The server's capability decides, not the assignments.
      expect(split({ ...user, languages: [] }).primary).toContain('/review');
      expect(split({ ...user, role: 'trial' }).primary).not.toContain('/review');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('gives export partners their project and the published tooltips only', () => {
    expect(split({ role: null, projects: ['dim'] })).toEqual({
      primary: ['/exports', '/tooltips'],
      more: [],
    });
    // An editing role decides; being a partner too adds nothing.
    expect(split({ role: 'editor', projects: ['dim'] }).primary).toContain('/');
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
    expect(workspacePath('/globals/variable/damage')).toBe('/');
    expect(workspacePath('/globals/g_damage0001')).toBe('/');
    expect(workspacePath('/globals')).toBe('/');
  });
});
