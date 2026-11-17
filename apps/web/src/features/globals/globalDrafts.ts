/**
 * Unsaved global definitions, kept per account and `<stable id>:<lang>` so finder stepping,
 * Back/Forward, and reload never lose one. `revision` is the entry revision the draft started
 * from: a later saved revision marks it stale instead of silently rebasing it.
 */
export interface GlobalDraft {
  body: string;
  revision?: string;
}

const prefix = 'clarity:global-draft:';
const storageKey = (owner: string, key: string) => `${prefix}${owner}:${key}`;

export function readGlobalDraft(owner: string, key: string): GlobalDraft | null {
  try {
    const raw = localStorage.getItem(storageKey(owner, key));
    if (!raw) return null;
    const value = JSON.parse(raw) as unknown;
    if (
      typeof value === 'object' &&
      value !== null &&
      typeof (value as GlobalDraft).body === 'string' &&
      ['string', 'undefined'].includes(typeof (value as GlobalDraft).revision)
    )
      return { body: (value as GlobalDraft).body, revision: (value as GlobalDraft).revision };
  } catch {
    // Storage blocked or a malformed value: the saved definition shows instead.
  }
  return null;
}

/** `null` removes the draft. A failed write keeps the in-memory draft for this session. */
export function writeGlobalDraft(owner: string, key: string, draft: GlobalDraft | null): void {
  try {
    if (draft) localStorage.setItem(storageKey(owner, key), JSON.stringify(draft));
    else localStorage.removeItem(storageKey(owner, key));
  } catch {
    // Quota or privacy mode: the session keeps the draft; reload cannot restore it.
  }
}
