import { useEffect, useState } from 'react';
import type { CompendiumData, Tooltip } from '@clarity/core';
import type { EditorData } from '../../stores/data';
import type { Drafts } from '../../services/draftStorage';
import { apiUrl } from '../../services/api';
import { bundleUrl } from '../../services/bundle';
import { compendiumDataUrl } from '../../services/compendium';
import { readProgress, reviewStorageKey } from './reviewProgress';
import {
  guidanceCacheSchema,
  guidanceResponseSchema,
  type GuidanceDocument,
} from './guidanceSchema';
import type { paneMatch } from './paneMatch';

export function usePaneMatch(
  base: Tooltip,
  editor: EditorData | null,
  source: CompendiumData | null,
  drafts: Drafts,
  userId?: string | number,
) {
  const [revision, refresh] = useState(0);
  const [result, setResult] = useState<{
    base: Tooltip;
    editor: EditorData;
    source: CompendiumData;
    drafts: Drafts;
    userId: typeof userId;
    revision: number;
    match: ReturnType<typeof paneMatch>;
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
    if (!editor || !source || base.compendium || drafts[base.hash]?.next.compendium) return;
    let cancelled = false;
    // No persistence owner: reading pending guidance must never start an autosave from this pane.
    const timer = setTimeout(() => {
      void (async () => {
        const { paneMatch } = await import('./paneMatch');
        if (cancelled) return;
        const scope = `${bundleUrl}|${compendiumDataUrl}`;
        const raw = localStorage.getItem(`clarity-review-guidance:v1:${encodeURIComponent(scope)}`);
        const cached = raw ? guidanceCacheSchema.parse(JSON.parse(raw)) : undefined;
        let document: GuidanceDocument = cached?.document ?? {
          version: 1,
          scope,
          baseline: '',
          categories: {},
        };
        if (document.scope !== scope) return;
        if (import.meta.env.DEV) {
          try {
            const response = await fetch(
              new URL(`${import.meta.env.BASE_URL}__review-guidance`, window.location.href),
            );
            if (!response.ok) return;
            const disk = guidanceResponseSchema.parse(await response.json());
            if (cached?.pending && cached.revision !== disk.revision) return;
            document = cached?.pending ? document : (disk.document ?? document);
          } catch {
            return;
          }
        }
        if (cancelled) return;
        const progress = readProgress(
          localStorage,
          reviewStorageKey(`${scope}|${apiUrl ?? 'read-only'}`, userId),
        );
        const match = paneMatch(base, editor, source, drafts, progress, document, scope);
        if (!cancelled) setResult({ base, editor, source, drafts, userId, revision, match });
      })().catch(() => {
        /* Invalid evidence keeps the ordinary picker fallback. */
      });
    }, 0);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [base, editor, source, drafts, userId, revision]);
  return result?.base === base &&
    result.editor === editor &&
    result.source === source &&
    result.drafts === drafts &&
    result.userId === userId &&
    result.revision === revision
    ? result.match
    : undefined;
}
