import { startTransition, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { CompendiumData } from '@clarity/core';
import type { EditorData } from '../../stores/data';
import type { Drafts } from '../../services/draftStorage';
import { apiUrl } from '../../services/api';
import { bundleUrl } from '../../services/bundle';
import { pendingCompendiumWorker, compendiumDataUrl } from '../../services/compendium';
import { guidanceResponseSchema } from './guidanceSchema';
import { matchingSession, prewarmMatchingSession } from './matchingSession';
import type { displayMatches } from './displayMatches';
import { storedInputs, type StoredInputs } from './storedInputs';

type Value = ReturnType<typeof displayMatches>;
type Remembered = {
  evidence: string;
  userId?: string | number;
  inputs: StoredInputs;
  value: Value;
};
const memory = new WeakMap<EditorData, WeakMap<CompendiumData, Remembered>>();
function remember(editor: EditorData, source: CompendiumData, entry: Remembered) {
  let sources = memory.get(editor);
  if (!sources) memory.set(editor, (sources = new WeakMap()));
  sources.set(source, entry);
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
  priorityHash?: number,
) {
  const typingUntil = useRef(0);
  useEffect(() => {
    const input = (event: Event) => {
      if (event.target instanceof Element && event.target.closest('.cm-content'))
        typingUntil.current = performance.now() + 300;
    };
    document.addEventListener('beforeinput', input, true);
    document.addEventListener('input', input, true);
    return () => {
      document.removeEventListener('beforeinput', input, true);
      document.removeEventListener('input', input, true);
    };
  }, []);
  const evidence = draftEvidence(drafts);
  const matchingDrafts = useMemo(
    () => Object.fromEntries(JSON.parse(evidence)) as Drafts,
    [evidence],
  );
  const scope = `${bundleUrl}|${compendiumDataUrl}`;
  const inputsStore = useMemo(
    () => storedInputs(scope, apiUrl ?? 'read-only', userId),
    [scope, userId],
  );
  const inputs = useSyncExternalStore(
    inputsStore.subscribe,
    inputsStore.getSnapshot,
    inputsStore.getSnapshot,
  );
  const remembered = editor && source ? memory.get(editor)?.get(source) : undefined;
  const cacheValid =
    remembered?.evidence === evidence &&
    remembered.userId === userId &&
    remembered.inputs.key === inputs.key;
  const [revision, refresh] = useState(0);
  const [earlyMatches, setEarlyMatches] = useState<{
    editor: EditorData;
    source: CompendiumData;
    evidence: string;
    userId: typeof userId;
    inputs: StoredInputs;
    revision: number;
    matches: Value['matches'];
    priorityHash?: number;
  }>();
  const [result, setResult] = useState<{
    editor: EditorData;
    source: CompendiumData;
    evidence: string;
    userId: typeof userId;
    inputs: StoredInputs;
    revision: number;
    value?: ReturnType<typeof displayMatches>;
    error?: string;
  }>();
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    // Dev disk guidance may be changed by an external tool. Production browser inputs
    // use the shared content store and never reparse/rematch unchanged focus events.
    const invalidate = () => refresh((value) => value + 1);
    window.addEventListener('focus', invalidate);
    return () => {
      window.removeEventListener('focus', invalidate);
    };
  }, []);
  useEffect(() => {
    if (!editor) return;
    const bridge = !source ? pendingCompendiumWorker() : undefined;
    if (!source && (!bridge || priorityHash === undefined)) return;
    const previous = source ? memory.get(editor)?.get(source) : undefined;
    if (
      !import.meta.env.DEV &&
      previous?.evidence === evidence &&
      previous.userId === userId &&
      previous.inputs.key === inputs.key
    )
      return;
    let cancelled = false;
    let idlePublication: number | undefined;
    let quietPublication: ReturnType<typeof setTimeout> | undefined;
    const publishWhenQuiet = (update: () => void) => {
      if (cancelled) return;
      if (idlePublication !== undefined) cancelIdleCallback(idlePublication);
      if (quietPublication !== undefined) clearTimeout(quietPublication);
      const commit = () => {
        idlePublication = undefined;
        if (cancelled) return;
        const remaining = typingUntil.current - performance.now();
        const pending = (
          navigator as Navigator & { scheduling?: { isInputPending(): boolean } }
        ).scheduling?.isInputPending();
        if (remaining > 0 || pending) {
          quietPublication = setTimeout(schedule, Math.max(16, remaining));
          return;
        }
        startTransition(update);
      };
      const schedule = () => {
        quietPublication = undefined;
        if (cancelled) return;
        const remaining = typingUntil.current - performance.now();
        // Publishing ready matches also triggers text layout. Keep that work
        // after a pause in real editor input, uniformly for every tooltip.
        if (remaining > 0) quietPublication = setTimeout(schedule, remaining);
        else if (typeof requestIdleCallback === 'function')
          idlePublication = requestIdleCallback(commit, { timeout: 50 });
        else commit();
      };
      schedule();
    };
    void (async () => {
      if (inputs.error) throw new Error(inputs.error);
      const cached = inputs.cached;
      let local = inputs.local;
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
      const session = source
        ? matchingSession(editor, source)
        : bridge && prewarmMatchingSession(editor, bridge);
      if (!session) return;
      const input = { drafts: matchingDrafts, progress: inputs.progress, local, scope };
      // Queue intent while the source is still hydrating on the main thread.
      // The retained worker already owns the complete source and editor inputs.
      if (!source) {
        if (priorityHash !== undefined)
          void session.prioritize(input, priorityHash).catch(() => undefined);
        return;
      }
      const publish = (matches: Value['matches']) =>
        publishWhenQuiet(() =>
          setEarlyMatches({
            editor,
            source,
            evidence,
            userId,
            inputs,
            revision,
            matches,
            priorityHash,
          }),
        );
      if (priorityHash !== undefined)
        void session
          .prioritize(input, priorityHash)
          .then(publish)
          .catch(() => {
            // The full request owns errors; superseded priority requests are expected.
          });
      const value = await session.display(input, publish);
      publishWhenQuiet(() => {
        remember(editor, source, { evidence, userId, inputs, value });
        setResult({ editor, source, evidence, userId, inputs, revision, value });
      });
    })().catch((error: unknown) => {
      if (!cancelled && source)
        setResult({
          editor,
          source,
          evidence,
          userId,
          inputs,
          revision,
          error: `Cannot match Compendium: ${error instanceof Error ? error.message : String(error)}`,
        });
    });
    return () => {
      cancelled = true;
      if (idlePublication !== undefined) cancelIdleCallback(idlePublication);
      if (quietPublication !== undefined) clearTimeout(quietPublication);
    };
  }, [editor, source, matchingDrafts, evidence, userId, revision, inputs, scope, priorityHash]);
  const current =
    result?.editor === editor &&
    result?.source === source &&
    result?.evidence === evidence &&
    result?.userId === userId &&
    result.inputs.key === inputs.key &&
    result.revision === revision
      ? result
      : undefined;
  const value = current?.error
    ? undefined
    : (current?.value ?? (cacheValid ? remembered?.value : undefined));
  // Factual review evidence remains usable while local decisions or link edits recompute.
  // The review projection separately validates changed local links against the same source.
  // The authoritative matches/decisions above are withheld until the new inputs validate.
  const reviewPrepared =
    value ??
    (result?.editor === editor && result.source === source && result.userId === userId
      ? result.value
      : remembered?.userId === userId
        ? remembered?.value
        : undefined);
  const partial =
    !current?.error &&
    earlyMatches?.editor === editor &&
    earlyMatches.source === source &&
    earlyMatches.evidence === evidence &&
    earlyMatches.userId === userId &&
    earlyMatches.inputs.key === inputs.key &&
    earlyMatches.revision === revision &&
    earlyMatches.priorityHash === priorityHash
      ? earlyMatches.matches
      : undefined;
  return {
    prepared: value,
    reviewPrepared,
    matches: value?.matches ?? partial,
    decisions: value?.decisions,
    loading: !!editor && !!source && !current && !value && (priorityHash === undefined || !partial),
    error: current?.error,
  };
}
