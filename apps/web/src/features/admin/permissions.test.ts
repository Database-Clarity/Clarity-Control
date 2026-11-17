import { expect, it } from 'vitest';
import type { Permissions } from '@clarity/core';
import { changeAccess, translatorAccess } from './permissions';

const initial: Permissions = { users: { 1: { login: 'owner', role: 'maintainer' } } };

it('cannot delete or demote the last maintainer', () => {
  expect(() => changeAccess(initial, '1', undefined)).toThrow('maintainer');
  expect(() => changeAccess(initial, '1', { login: 'owner', role: 'editor' })).toThrow(
    'maintainer',
  );
  expect(initial.users[1].role).toBe('maintainer');
});

it('allows edits/removal once another maintainer remains without mutating the input', () => {
  const next = changeAccess(initial, '2', { login: 'second', role: 'maintainer' });
  expect(changeAccess(next, '1', undefined).users).toEqual({
    2: { login: 'second', role: 'maintainer' },
  });
  expect(initial.users[2]).toBeUndefined();
  expect(
    changeAccess(next, '1', {
      login: 'owner',
      role: 'translator',
      languages: ['de', 'fr'],
    }).users[1].languages,
  ).toEqual(['de', 'fr']);
});

it('keeps the export partners map on every change (spec section 4)', () => {
  const partners = { 42: { login: 'partner', projects: ['dim'] } };
  const withPartners: Permissions = { ...initial, partners };
  const added = changeAccess(withPartners, '2', { login: 'second', role: 'editor' });
  expect(added.partners).toEqual(partners);
  expect(changeAccess(added, '2', undefined)).toEqual(withPartners);
  expect(changeAccess(initial, '2', { login: 'second', role: 'editor' })).not.toHaveProperty(
    'partners',
  );
});

it('keeps managed languages within the assigned ones (translation managers)', () => {
  const access = {
    login: 'erin',
    role: 'translator' as const,
    languages: ['de' as const, 'fr' as const],
    manages: ['de' as const],
  };
  expect(translatorAccess(access, ['de', 'fr'], ['de', 'fr'])).toEqual({
    ...access,
    manages: ['de', 'fr'],
  });
  // Unassigning a managed language drops it; an empty list is left out (the schema needs one).
  const plain = { login: access.login, role: access.role, languages: access.languages };
  expect(translatorAccess(access, ['fr'])).toEqual({ ...plain, languages: ['fr'] });
  const config = changeAccess(initial, '5', translatorAccess(access, ['fr']));
  expect(config.users[5]).toEqual({ ...plain, languages: ['fr'] });
});
