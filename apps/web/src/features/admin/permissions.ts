import { permissionsSchema, type Permissions } from '@clarity/core';

export type Access = Permissions['users'][string];
export const roles: Access['role'][] = ['maintainer', 'editor', 'trial', 'translator'];

export function maintainerCount(permissions: Permissions): number {
  return Object.values(permissions.users).filter((user) => user.role === 'maintainer').length;
}

/**
 * A translator's languages and managed languages after a change: managing needs the language
 * (and never English), and an empty managed list is left out (the schema needs at least one).
 */
export function translatorAccess(
  access: Access,
  languages: NonNullable<Access['languages']>,
  manages: NonNullable<Access['manages']> = access.manages ?? [],
): Access {
  const kept = manages.filter((lang) => lang !== 'en' && languages.includes(lang));
  const next: Access = { ...access, languages };
  delete next.manages;
  return kept.length ? { ...next, manages: kept } : next;
}

export function changeAccess(
  permissions: Permissions,
  id: string,
  access: Access | undefined,
): Permissions {
  const users = { ...permissions.users };
  if (access) users[id] = access;
  else delete users[id];
  // Spread first: everything besides `users` (the export `partners` map) is kept as loaded.
  const next = permissionsSchema.parse({ ...permissions, users });
  if (!maintainerCount(next)) throw new Error('At least one maintainer must remain.');
  return next;
}
