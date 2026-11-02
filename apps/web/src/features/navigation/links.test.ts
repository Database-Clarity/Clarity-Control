import { describe, expect, it } from 'vitest';
import { links, visibleLinks } from './links';

const paths = (role: Parameters<typeof visibleLinks>[0]) => visibleLinks(role).map(({ to }) => to);
const all = [
  '/',
  '/review',
  '/compendium',
  '/drift',
  '/lost-text',
  '/archive',
  '/translations',
  '/globals',
  '/admin',
];

describe('visibleLinks', () => {
  it('lists every workspace page in order', () => {
    expect(links.map(({ to }) => to)).toEqual(all);
  });

  it.each([
    ['translator', ['/', '/translations', '/globals']],
    ['maintainer', all],
    ['editor', all.filter((to) => to !== '/admin')],
    ['trial', all.filter((to) => to !== '/admin')],
    [null, all.filter((to) => to !== '/admin')],
  ] as const)('role %s sees %j', (role, expected) => {
    expect(paths({ role })).toEqual(expected);
  });

  it('treats signed-out and not-yet-loaded users like a role-less visitor', () => {
    const expected = all.filter((to) => to !== '/admin');
    expect(paths(null)).toEqual(expected);
    expect(paths(undefined)).toEqual(expected);
  });

  it('keeps labels intact and returns a fresh array', () => {
    const result = visibleLinks({ role: 'translator' });
    expect(result.map(({ label }) => label)).toEqual(['Tooltip editor', 'Translations', 'Globals']);
    result.pop();
    expect(visibleLinks({ role: 'translator' })).toHaveLength(3);
  });
});
