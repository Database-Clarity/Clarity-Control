import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from 'react';
import type { Lang } from '@clarity/core';

type Choice = readonly [Lang | undefined, Dispatch<SetStateAction<Lang | undefined>>];
export const WorkspaceLanguageContext = createContext<Choice | null>(null);

/** Shared by the shell finder and its workspace; never stored across page loads. */
export function WorkspaceLanguageProvider({ children }: { children: ReactNode }) {
  const [remembered, setRemembered] = useState<Lang>();
  const choice = useMemo(() => [remembered, setRemembered] as const, [remembered]);
  return (
    <WorkspaceLanguageContext.Provider value={choice}>{children}</WorkspaceLanguageContext.Provider>
  );
}

/** Embedded/standalone workspaces keep their own choice, as before. */
export function useRememberedWorkspaceLanguage(share: boolean) {
  const shared = useContext(WorkspaceLanguageContext);
  const local = useState<Lang>();
  const setShared = shared?.[1];
  useEffect(
    () => () => {
      // Match the original workspace-local state's lifetime, even though the shell outlives it.
      if (share) setShared?.(undefined);
    },
    [share, setShared],
  );
  return share && shared ? shared : local;
}
