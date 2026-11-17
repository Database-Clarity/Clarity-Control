import { useCallback, useEffect, useState } from 'react';
import type { CustomSnippet } from '../../../../../packages/core/src/customSnippets';
import { getPersonalSnippets, savePersonalSnippet } from '../../services/snippets';
import { invalidateSnippetCatalogue } from '../editor/suggest/custom';
import { saveError } from './SnippetFields';
import { SnippetManager } from './SnippetManager';

export interface PersonalEntry {
  snippet: CustomSnippet;
  revision: string;
}

/** Your saved snippets with their revisions, as Settings and "Copy from my snippets" read them. */
export function usePersonalSnippets(enabled: boolean) {
  const [entries, setEntries] = useState<PersonalEntry[] | null>(null);
  const [status, setStatus] = useState({ loading: false, error: null as string | null });
  const reload = useCallback(() => {
    if (!enabled) return;
    setStatus({ loading: true, error: null });
    getPersonalSnippets()
      .then((found) => {
        setEntries(
          found.snippets.flatMap((entry) =>
            entry.snippet && entry.revision
              ? [{ snippet: entry.snippet, revision: entry.revision }]
              : [],
          ),
        );
        setStatus({ loading: false, error: null });
      })
      .catch((error: unknown) =>
        setStatus({ loading: false, error: `Snippets could not load: ${saveError(error)}` }),
      );
  }, [enabled]);
  useEffect(reload, [reload]);
  return { entries, setEntries, status, reload };
}

/**
 * Settings → Snippets: your own snippets (every editor role; account-scoped, never shared).
 * Saved ones show in Ctrl+Space and the typed menu marked "Mine".
 */
export function MySnippets() {
  const { entries, setEntries, status, reload } = usePersonalSnippets(true);
  async function save(current: CustomSnippet | null, next: CustomSnippet | null) {
    const id = (next ?? current)!.id;
    const revision = current
      ? (entries?.find((entry) => entry.snippet.id === current.id)?.revision ?? null)
      : null;
    const saved = await savePersonalSnippet(id, next, revision);
    setEntries((list) => {
      const rest = (list ?? []).filter((entry) => entry.snippet.id !== id);
      return saved.snippet && saved.revision
        ? current
          ? (list ?? []).map((entry) =>
              entry.snippet.id === id
                ? { snippet: saved.snippet!, revision: saved.revision! }
                : entry,
            )
          : [...rest, { snippet: saved.snippet, revision: saved.revision }]
        : rest;
    });
    invalidateSnippetCatalogue();
  }
  return (
    <SnippetManager
      name="Your snippets"
      snippets={entries?.map((entry) => entry.snippet) ?? null}
      limit={50}
      status={status}
      onReload={reload}
      save={save}
      newId={() => `me:${crypto.randomUUID()}`}
    />
  );
}
