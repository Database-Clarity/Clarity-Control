import type { User } from '../../services/api';

export interface NavLink {
  to: string;
  label: string;
}

export const links: readonly NavLink[] = [
  { to: '/', label: 'Tooltip editor' },
  { to: '/review', label: 'Review changes' },
  { to: '/compendium', label: 'Compendium' },
  { to: '/drift', label: 'Bungie drift' },
  { to: '/lost-text', label: 'Lost-tooltip checker' },
  { to: '/archive', label: 'Archive' },
  { to: '/translations', label: 'Translations' },
  { to: '/globals', label: 'Globals' },
  { to: '/admin', label: 'Administration' },
];

const translatorLinks = new Set(['/', '/translations', '/globals']);

/**
 * Workspace pages offered to this user. Translators only get the pages they can act on;
 * everyone else keeps the full list, with Administration limited to maintainers.
 * Hiding a link is a convenience, not access control: routes and the Worker still enforce roles.
 */
export function visibleLinks(user: Pick<User, 'role'> | null | undefined): NavLink[] {
  if (user?.role === 'translator') return links.filter(({ to }) => translatorLinks.has(to));
  return links.filter(({ to }) => to !== '/admin' || user?.role === 'maintainer');
}
