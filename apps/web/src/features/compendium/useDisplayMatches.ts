import { useEffect, useMemo, useState } from 'react';
import type { CompendiumData } from '@clarity/core';
import type { EditorData } from '../../stores/data';
import type { Drafts } from '../../services/draftStorage';
import { apiUrl } from '../../services/api';
import { bundleUrl } from '../../services/bundle';
import { compendiumDataUrl } from '../../services/compendium';
import { readProgress, reviewStorageKey } from './reviewProgress';
import { guidanceCacheSchema, guidanceResponseSchema } from './guidanceSchema';
import { matchingSession } from './matchingSession';
import type { displayMatches } from './displayMatches';

type Value = ReturnType<typeof displayMatches>;
const memory = new WeakMap<EditorData, WeakMap<CompendiumData, { key: string; value: Value }>>();
function remember(editor: EditorData, source: CompendiumData, key: string, value: Value) {
  let sources = memory.get(editor);
  if (!sources) memory.set(editor, (sources = new WeakMap()));
  sources.set(source, { key, value });
}

const evidenceByDrafts = new WeakMap<Drafts, string>();
const evidenceByEntry = new WeakMap<Drafts[string], string>();
function draftEvidence(drafts: Drafts) {
  const existing = evidenceByDrafts.get(drafts);
  if (existing !== undefined) return existing;
  const parts: string[] = [];
  for (const [hash, draft] of Object.entries(drafts)) {
    if (!(draft.base.compendium || draft.next.compendium || draft.base.custom || draft.next.custom))
      continue;
    let part = evidenceByEntry.get(draft);
    if (part === undefined) {
      // Only link/classification metadata affects matching. In particular, never serialize
      // all saved translations/snapshots from every unchanged draft on each keystroke.
      const project = (value: typeof draft.base) => ({
        hash: value.hash,
        text: {},
        associated: [],
        compendium: value.compendium,
        custom: value.custom,
      });
      part = JSON.stringify([hash, { base: project(draft.base), next: project(draft.next) }]);
      evidenceByEntry.set(draft, part);
    }
    parts.push(part);
  }
  const value = `[${parts.join(',')}]`;
  evidenceByDrafts.set(drafts, value);
  return value;
}

export function useDisplayMatches(
  editor: EditorData | null,
  source: CompendiumData | null,
  drafts: Drafts,
  userId?: string | number,
) {
  const evidence = draftEvidence(drafts);
  const matchingDrafts = useMemo(
    () => Object.fromEntries(JSON.parse(evidence)) as Drafts,
    [evidence],
  );
  const memoryKey = `${userId ?? 'anonymous'}|${evidence}`;
  const remembered = editor && source ? memory.get(editor)?.get(source) : undefined;
  const [revision, refresh] = useState(0);
  const [result, setResult] = useState<{
    editor: EditorData;
    source: CompendiumData;
    evidence: string;
    userId: typeof userId;
    value?: ReturnType<typeof displayMatches>;
    error?: string;
  }>();
  useEffect(() => {
    const invalidate = () => refresh((value) => value + 1);
    window.addEventListener('storage', invalidate);
    window.addEventListener('focus', invalidate);
    return () => {
      window.removeEventListener('storage', invalidate);
      window.removeEventListener('focus', invalidate);
    };
  }, []);
  useEffect(() => {
    if (!editor || !source) return;
    let cancelled = false;
    void (async () => {
      const scope = `${bundleUrl}|${compendiumDataUrl}`;
      const raw = localStorage.getItem(`clarity-review-guidance:v1:${encodeURIComponent(scope)}`);
      const cached = raw ? guidanceCacheSchema.parse(JSON.parse(raw)) : undefined;
      let local = cached?.document;
      if (import.meta.env.DEV) {
        const response = await fetch(
          new URL(`${import.meta.env.BASE_URL}__review-guidance`, window.location.href),
        );
        if (!response.ok) throw new Error('Cannot load local Compendium guidance.');
        const disk = guidanceResponseSchema.parse(await response.json());
        if (cached?.pending && cached.revision !== disk.revision)
          throw new Error('Local Compendium guidance conflicts with disk.');
        local = cached?.pending ? local : (disk.document ?? local);
      }
      const progress = readProgress(
        localStorage,
        reviewStorageKey(`${scope}|${apiUrl ?? 'read-only'}`, userId),
      );
      const value = await matchingSession(editor, source).display({
        drafts: matchingDrafts,
        progress,
        local,
        scope,
      });
      remember(editor, source, memoryKey, value);
      if (!cancelled) setResult({ editor, source, evidence, userId, value });
    })().catch((error: unknown) => {
      if (!cancelled)
        setResult({
          editor,
          source,
          evidence,
          userId,
          error: `Cannot match Compendium: ${error instanceof Error ? error.message : String(error)}`,
        });
    });
    return () => {
      cancelled = true;
    };
  }, [editor, source, matchingDrafts, evidence, userId, revision, memoryKey]);
  const current =
    result?.editor === editor &&
    result?.source === source &&
    result?.evidence === evidence &&
    result?.userId === userId
      ? result
      : undefined;
  const value = current?.error
    ? undefined
    : (current?.value ?? (remembered?.key === memoryKey ? remembered.value : undefined));
  return {
    prepared: value,
    matches: value?.matches,
    decisions: value?.decisions,
    loading: !!editor && !!source && !current && !value,
    error: current?.error,
  };
}
