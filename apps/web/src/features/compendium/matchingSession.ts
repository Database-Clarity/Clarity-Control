import type { CompendiumData } from '@clarity/core';
import type { EditorData } from '../../stores/data';
import type { Drafts } from '../../services/draftStorage';
import type { GuidanceDocument } from './guidanceSchema';
import type { ReviewProgress } from './reviewProgress';
import type { ReviewProposal } from './rapidReview';
import type { displayMatches } from './displayMatches';
import type { ReviewCategory } from './reviewCategories';
import type { GuidedCategory } from './guidedDecisions';
import { createWorkerBridge, sourceWorkerFor } from './workerBridge';
import { streamInputs } from './streamInputs';
type Display = ReturnType<typeof displayMatches>;
export interface DisplayInput {
  drafts: Drafts;
  progress: ReviewProgress;
  local?: GuidanceDocument;
  scope: string;
}
const sessions = new WeakMap<
  EditorData,
  WeakMap<CompendiumData, ReturnType<typeof createSession>>
>();
let inputToken = 0;
function createSession(editor: EditorData, source: CompendiumData) {
  const retained = sourceWorkerFor(source);
  const bridge =
    retained ??
    createWorkerBridge(
      new Worker(new URL('./proposals.worker.ts', import.meta.url), { type: 'module' }),
    );
  const owner = {};
  const token = ++inputToken;
  let disposed = false;
  function request<T>(payload: object): Promise<T> {
    if (disposed) return Promise.reject(new Error('Compendium inputs changed.'));
    return bridge.request<T>(payload, owner);
  }
  let currentProposals: Map<number, ReviewProposal> | undefined;
  const proposals = streamInputs(
    retained ? { editor } : { editor, source },
    (bytes) => bridge.post({ initialChunk: { token, bytes } }, [bytes]),
    () => disposed,
  )
    .then(() => request<Map<number, ReviewProposal>>({ initialize: { token } }))
    .then((value) => {
      currentProposals = value;
      return value;
    });
  let display: { key: string; promise: Promise<Display> } | undefined;
  return {
    proposals,
    get currentProposals() {
      return currentProposals;
    },
    dispose() {
      disposed = true;
      if (!bridge.disposed) bridge.post({ cancelInit: { token } });
      bridge.cancel(owner);
      if (!retained) bridge.dispose();
    },
    guided(
      document: GuidanceDocument,
      categories: ReviewCategory[],
      baseline: string,
      scope: string,
      categoryId: string,
    ) {
      return proposals.then(() =>
        request<GuidedCategory[]>({
          guide: {
            document,
            baseline,
            scope,
            categoryId,
            statuses: categories.flatMap((c) => c.entries.map((e) => [e.hash, e.status] as const)),
            restored: categories.flatMap((c) =>
              c.entries.filter((e) => e.scopeRestored).map((e) => e.hash),
            ),
          },
        }),
      );
    },
    display(input: DisplayInput) {
      const key = displayInputKey(input);
      if (display?.key === key) return display.promise;
      const promise = proposals.then(() => request<Display>({ input }));
      display = { key, promise };
      return promise;
    },
  };
}
export function displayInputKey(input: DisplayInput) {
  const localCategories = Object.fromEntries(
    Object.entries(input.local?.categories ?? {}).filter(
      ([, category]) => category.comment || Object.keys(category.references ?? {}).length,
    ),
  );
  return JSON.stringify({
    ...input,
    progress: { decisions: input.progress.decisions },
    local: Object.keys(localCategories).length
      ? { ...input.local, categories: localCategories }
      : undefined,
  });
}
let active:
  | { editor: EditorData; source: CompendiumData; session: ReturnType<typeof createSession> }
  | undefined;
export function matchingSession(editor: EditorData, source: CompendiumData) {
  if (active && (active.editor !== editor || active.source !== source)) {
    active.session.dispose();
    sessions.get(active.editor)?.delete(active.source);
    active = undefined;
  }
  let sources = sessions.get(editor);
  if (!sources) sessions.set(editor, (sources = new WeakMap()));
  let session = sources.get(source);
  if (!session) sources.set(source, (session = createSession(editor, source)));
  active = { editor, source, session };
  return session;
}

export function peekMatchingSession(editor: EditorData, source: CompendiumData) {
  return sessions.get(editor)?.get(source);
}
