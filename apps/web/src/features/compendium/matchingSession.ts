import type { CompendiumData } from '@clarity/core';
import type { EditorData } from '../../stores/data';
import type { Drafts } from '../../services/draftStorage';
import type { GuidanceDocument } from './guidanceSchema';
import type { ReviewProgress } from './reviewProgress';
import type { ReviewProposal } from './rapidReview';
import type { displayMatches } from './displayMatches';
import type { ReviewCategory } from './reviewCategories';
import type { GuidedCategory } from './guidedDecisions';
import { receiveWorkerResult, type WorkerReply } from './workerReplies';
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
function createSession(editor: EditorData, source: CompendiumData) {
  const worker = new Worker(new URL('./proposals.worker.ts', import.meta.url), { type: 'module' });
  let serial = 0;
  let failed: Error | undefined;
  const waiting = new Map<
    number,
    {
      resolve(value: unknown): void;
      reject(error: Error): void;
      receive: ReturnType<typeof receiveWorkerResult>;
    }
  >();
  worker.onmessage = ({ data }: MessageEvent<WorkerReply>) => {
    const job = waiting.get(data.id);
    if (!job) return;
    if (data.error) {
      waiting.delete(data.id);
      job.reject(new Error(data.error));
      return;
    }
    try {
      const result = job.receive(data);
      if (result.done) {
        waiting.delete(data.id);
        job.resolve(result.value);
      }
    } catch (error) {
      waiting.delete(data.id);
      job.reject(error instanceof Error ? error : new Error(String(error)));
    }
  };
  worker.onerror = () => {
    failed = new Error('Compendium matching failed. Reload to retry.');
    for (const job of waiting.values())
      job.reject(new Error('Compendium matching failed. Reload to retry.'));
    waiting.clear();
  };
  function request<T>(payload: object): Promise<T> {
    if (failed) return Promise.reject(failed);
    return new Promise((resolve, reject) => {
      const id = ++serial;
      waiting.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        receive: receiveWorkerResult(),
      });
      worker.postMessage({ ...payload, id });
    });
  }
  let currentProposals: Map<number, ReviewProposal> | undefined;
  const proposals = request<Map<number, ReviewProposal>>({ editor, source }).then((value) => {
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
      failed = new Error('Compendium inputs changed.');
      worker.terminate();
      for (const job of waiting.values()) job.reject(failed);
      waiting.clear();
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
      const localCategories = Object.fromEntries(
        Object.entries(input.local?.categories ?? {}).filter(
          ([, c]) => c.comment || Object.keys(c.references ?? {}).length,
        ),
      );
      const key = JSON.stringify({
        ...input,
        progress: { decisions: input.progress.decisions },
        local: Object.keys(localCategories).length
          ? { ...input.local, categories: localCategories }
          : undefined,
      });
      if (display?.key === key) return display.promise;
      const promise = proposals.then(() => request<Display>({ input }));
      display = { key, promise };
      return promise;
    },
  };
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
