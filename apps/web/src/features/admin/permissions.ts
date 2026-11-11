import { permissionsSchema, type Permissions } from '@clarity/core';

export type Access = Permissions['users'][string];
export const roles: Access['role'][] = ['maintainer', 'editor', 'trial', 'translator'];

export function maintainerCount(permissions: Permissions): number {
  return Object.values(permissions.users).filter((user) => user.role === 'maintainer').length;
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
