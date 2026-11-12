import type { User } from '../../services/api';

export interface NavLink {
  to: string;
  label: string;
}

/** Every workspace page, for titles and lookups. What a user is offered is `workspaceMenu`. */
export const links: readonly NavLink[] = [
  { to: '/', label: 'Editor' },
  { to: '/review', label: 'Review changes' },
  { to: '/compendium', label: 'Compendium' },
  { to: '/translations', label: 'Translations' },
  { to: '/drift', label: 'Bungie drift' },
  { to: '/lost-text', label: 'Lost text' },
  { to: '/archive', label: 'Archive' },
  { to: '/globals', label: 'Globals' },
  { to: '/management', label: 'Management' },
  { to: '/exports', label: 'Exports' },
  { to: '/tooltips', label: 'Tooltips' },
];

const link = (to: string) => links.find((candidate) => candidate.to === to)!;
const pick = (...paths: string[]) => paths.map(link);

/** The account fields the menu reads; `projects` names an export partner's projects. */
export type MenuUser = Pick<User, 'role'> & Partial<Pick<User, 'projects'>>;

export interface WorkspaceMenu {
  /** Header tabs. */
  primary: NavLink[];
  /** Behind the "More" menu. */
  more: NavLink[];
}

/**
 * The workspaces this user is offered, by role (need to access: what a role cannot use is hidden,
 * not disabled). Globals is a category in the editor's finder, never a workspace tab. Signed-out
 * visitors and accounts without an editing role get the read-only Editor only; so does the
 * moment before the login status is known.
 * Hiding a link is a convenience, not access control: routes and the Worker still enforce roles.
 */
export function workspaceMenu(user: MenuUser | null | undefined): WorkspaceMenu {
  switch (user?.role) {
    case 'maintainer':
      return {
        primary: pick('/', '/review', '/compendium', '/translations'),
        more: pick('/drift', '/lost-text', '/archive', '/management', '/exports'),
      };
    case 'editor':
      return {
        primary: pick('/', '/review', '/compendium', '/translations'),
        more: pick('/drift', '/lost-text', '/archive'),
      };
    case 'trial':
      return { primary: pick('/', '/compendium', '/translations', '/drift'), more: [] };
    case 'translator':
      return { primary: pick('/', '/translations'), more: [] };
    default:
      // Export partners (no editing role, spec section 8): their project and the published tooltips.
      if (user?.projects?.length) return { primary: pick('/exports', '/tooltips'), more: [] };
      return { primary: pick('/'), more: [] };
  }
}

/** Every workspace offered to this user, tabs first. */
export function visibleLinks(user: MenuUser | null | undefined): NavLink[] {
  const { primary, more } = workspaceMenu(user);
  return [...primary, ...more];
}

/** The workspace a pathname belongs to ('/' for tooltip pages); used for tabs and remembered routes. */
export function workspacePath(pathname: string): string {
  if (pathname.startsWith('/t/')) return '/';
  if (pathname.startsWith('/compendium')) return '/compendium';
  if (pathname === '/') return '/';
  return `/${pathname.split('/')[1]}`;
}
