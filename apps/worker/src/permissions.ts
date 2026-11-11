import { permissionsSchema, stableStringify, type Permissions, type Tooltip } from '@clarity/core';
import { HttpError } from './http.js';
import type { GitHub } from './github.js';
import type { Identity } from './types.js';

export type Access = Permissions['users'][string];

export async function permissions(github: GitHub, head: string): Promise<Permissions> {
  return permissionsSchema.parse(
    (await github.requiredFile('config/permissions.json', head)).value,
  );
}

export function requireAccess(
  config: Permissions,
  user: Identity,
  roles: Access['role'][],
): Access {
  const access = config.users[String(user.id)];
  if (!access || !roles.includes(access.role)) throw new HttpError(403, 'Permission denied');
  return access;
}

/** Export projects the user is a partner of (spec section 4); empty for everyone else. */
export function partnerProjects(config: Permissions, user: Identity): readonly string[] {
  return config.partners?.[String(user.id)]?.projects ?? [];
}

/**
 * The role `/me` reports. `users` decides; an account listed only in `partners` is a `partner`.
 * `partner` is never accepted by `requireAccess`, so every route that checks `users` denies it
 * by default; only the export routes read `partners`.
 */
export function roleOf(config: Permissions, user: Identity): Access['role'] | 'partner' | null {
  return (
    config.users[String(user.id)]?.role ?? (partnerProjects(config, user).length ? 'partner' : null)
  );
}

export function checkEdit(access: Access, base: Tooltip | null, next: Tooltip): void {
  if (access.role === 'translator' && base === null)
    throw new HttpError(403, 'Translators may not create tooltips');
  if (
    JSON.stringify(base?.archive) !== JSON.stringify(next.archive) &&
    access.role !== 'maintainer' &&
    !(access.role === 'editor' && base?.archive && !next.archive)
  )
    throw new HttpError(403, 'Archive changes require maintainer role');
  const categoryChanged = base?.custom?.categoryId !== next.custom?.categoryId;
  const attachmentCategoryChange = [base?.custom?.categoryId, next.custom?.categoryId].some(
    (category) => category === 'weapon-attachment' || category === 'attachment-effect',
  );
  if (
    categoryChanged &&
    attachmentCategoryChange &&
    !['editor', 'maintainer'].includes(access.role)
  )
    throw new HttpError(403, 'Attachment category changes require editor role or higher');
  if (access.role !== 'translator') return;
  const withoutAllowed = (value: Tooltip) => ({
    ...value,
    text: Object.fromEntries(
      Object.entries(value.text).filter(
        ([lang]) => !access.languages?.includes(lang as keyof Tooltip['text']),
      ),
    ),
  });
  const original = base!;
  if (stableStringify(withoutAllowed(original)) !== stableStringify(withoutAllowed(next))) {
    throw new HttpError(403, 'Translators may change only text in their assigned languages');
  }
}
