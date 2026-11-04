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
type Bridge = ReturnType<typeof createWorkerBridge>;
const warming = new WeakMap<EditorData, WeakMap<Bridge, ReturnType<typeof createSession>>>();
function createSession(
  editor: EditorData,
  source?: CompendiumData,
  earlyBridge?: Bridge,
  onDispose?: () => void,
) {
  const retained = earlyBridge ?? (source && sourceWorkerFor(source));
  const bridge =
    retained ??
    createWorkerBridge(
      new Worker(new URL('./proposals.worker.ts', import.meta.url), { type: 'module' }),
    );
  const owner = {};
  const token = ++inputToken;
  let disposed = false;
  function request<T>(payload: object, progress?: (value: unknown) => void): Promise<T> {
    if (disposed) return Promise.reject(new Error('Compendium inputs changed.'));
    return bridge.request<T>(payload, owner, progress);
  }
  let currentProposals: Map<number, ReviewProposal> | undefined;
  const initialized = streamInputs(
    retained ? { editor } : { editor, source },
    (bytes) => bridge.post({ initialChunk: { token, bytes } }, [bytes]),
    () => disposed,
  )
    // The worker serializes initialization and display requests. Queue display
    // once inputs are sent, while the independent proposal reply is hydrating.
    .then(() => ({ response: request<Map<number, ReviewProposal>>({ initialize: { token } }) }));
  const proposals = initialized
    .then(({ response }) => response)
    .then((value) => {
      currentProposals = value;
      return value;
    });
  type Matches = Display['matches'];
  let display:
    | {
        key: string;
        promise: Promise<Display>;
        matches?: Matches;
        listeners: Set<(matches: Matches) => void>;
      }
    | undefined;
  return {
    proposals,
    get currentProposals() {
      return currentProposals;
    },
    dispose() {
      disposed = true;
      onDispose?.();
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
    display(input: DisplayInput, onMatches?: (matches: Matches) => void) {
      const key = displayInputKey(input);
      if (display?.key === key) {
        if (onMatches) {
          if (display.matches) onMatches(display.matches);
          else display.listeners.add(onMatches);
        }
        return display.promise;
      }
      const pending: NonNullable<typeof display> = {
        key,
        listeners: new Set(onMatches ? [onMatches] : []),
        matches: undefined as Matches | undefined,
        promise: initialized.then(() =>
          request<Display>({ input }, (value) => {
            pending.matches = value as Matches;
            for (const listener of pending.listeners) listener(pending.matches);
            pending.listeners.clear();
          }),
        ),
      };
      display = pending;
      return pending.promise;
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
  if (!session) {
    const bridge = sourceWorkerFor(source);
    session = (bridge && warming.get(editor)?.get(bridge)) ?? createSession(editor, source);
    sources.set(source, session);
  }
  active = { editor, source, session };
  return session;
}

/** Stream editor inputs while the source is fetching/decoding, rather than after it. */
export function prewarmMatchingSession(editor: EditorData, bridge: Bridge) {
  if (bridge.disposed) return;
  let byBridge = warming.get(editor);
  if (!byBridge) warming.set(editor, (byBridge = new WeakMap()));
  if (byBridge.has(bridge)) return;
  const cache = byBridge;
  const session = createSession(editor, undefined, bridge, () => cache.delete(bridge));
  cache.set(bridge, session);
  void session.proposals.catch(() => cache.delete(bridge));
}

export function peekMatchingSession(editor: EditorData, source: CompendiumData) {
  return sessions.get(editor)?.get(source);
}
