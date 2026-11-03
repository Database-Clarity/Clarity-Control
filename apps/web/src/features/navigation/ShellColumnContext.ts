import { createContext, useContext } from 'react';

/**
 * The left column as the Layout runs it, offered to the page rendered beside it. A page that finds
 * no column (a phone, or a page rendered on its own) lays everything out inline instead.
 */
export interface ShellColumn {
  /** Hidden by the user, or by default in compact windows. Its content stays mounted. */
  collapsed: boolean;
  /** Expands the column if needed and moves focus into it. */
  show(): void;
  toggle(): void;
}

export const ShellColumnContext = createContext<ShellColumn | null>(null);

export function useShellColumn(): ShellColumn | null {
  return useContext(ShellColumnContext);
}
