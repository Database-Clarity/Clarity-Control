import type { CompendiumData } from '@clarity/core';
import type { EditorData } from '../../stores/data';
import type { ReviewProposal } from './rapidReview';
import type { displayMatches } from './displayMatches';
import type { DisplayInput } from './matchingSession';
import type { prepareMatchingPlan } from './matchingSessionPlanning';
import { matchingSessionFingerprint } from './matchingSessionFingerprint';
import { compactMatch } from './compactMatches';
import { cachedComputation, contentHash } from './workerCache';
import precomputedUrl from './precomputed.v1.json?url';
import compressedUrl from './precomputed.v1.json.gz?url';
import { compressedJson } from './compressedJson';
import { compactDisplay, compactProposal } from './compactMatches';
import { decodePrecomputed } from './precomputedCodec';
import type { GuidanceDocument } from './guidanceSchema';
import { matchingInputs } from './matchingInputs';
import { sendWorkerResult, type WorkerReply } from './workerReplies';
const emit = (reply: WorkerReply) =>
  self.postMessage(reply, { transfer: reply.buffer ? [reply.buffer] : [] });
let editor: EditorData;
let source: CompendiumData;
let proposals: Map<number, ReviewProposal>;
let dataKey: string;
let fingerprint: string | undefined;
let latestGuide = 0;
let latestDisplay = 0;
let latestPriority = 0;
let lastDisplay: ReturnType<typeof displayMatches> | undefined;
let precomputedDisplay: ReturnType<typeof displayMatches> | undefined;
let initialized = false;
let modelToken: number | undefined;
let priority: (NonNullable<Request['priority']> & { id: number }) | undefined;
let priorityPlan: { key: string; plan: ReturnType<typeof prepareMatchingPlan> } | undefined;
const priorityProposals = new Map<number, ReviewProposal>();
type Request = {
  id?: number;
  load?: { url: string };
  initialChunk?: { token: number; bytes: ArrayBuffer };
  cancelInit?: { token: number };
  initialize?: { token: number };
  input?: DisplayInput;
  priority?: { token: number; hash: number; input: DisplayInput };
  guide?: {
    document: GuidanceDocument;
    baseline: string;
    scope: string;
    categoryId: string;
    statuses: [number, import('./reviewCategories').ReviewSample['status']][];
    restored: number[];
  };
};
const initialChunks = new Map<number, Uint8Array[]>();
let queue = Promise.resolve();
self.onmessage = ({ data }: MessageEvent<Request>) => {
  if (data.priority) {
    if (priority)
      self.postMessage({ id: priority.id, error: 'Superseded Compendium priority request.' });
    latestPriority = data.id ?? 0;
    priority = { ...data.priority, id: latestPriority };
    void servePriority();
    return;
  }
  if (data.guide) latestGuide = data.id ?? 0;
  if (data.input) latestDisplay = data.id ?? 0;
  // A source's worker survives editor reloads. Keep each initialized editor consistent
  // through async cache reads; a later generation never mutates an in-flight model.
  queue = queue.then(() => process(data));
};
async function servePriority() {
  const request = priority;
  if (!request || request.token !== modelToken) return;
  priority = undefined;
  try {
    const [
      { proposalFor },
      { withCompendiumMatchingIndex },
      { prepareMatchingPlan, matchingPlanSteps },
    ] = await Promise.all([
      import('./rapidReview'),
      import('@clarity/core'),
      import('./matchingSessionPlanning'),
    ]);
    // A replacement generation may have arrived during module loading.
    if (request.token !== modelToken) throw new Error('Compendium inputs changed.');
    if (request.id !== latestPriority) throw new Error('Superseded Compendium priority request.');
    const result = withCompendiumMatchingIndex(source, () => {
      const key = `${request.hash}:${JSON.stringify(request.input)}`;
      if (priorityPlan?.key !== key)
        priorityPlan = {
          key,
          plan: prepareMatchingPlan(
            editor,
            source,
            request.input,
            new Map(),
            undefined,
            request.hash,
            (fingerprint ??= matchingSessionFingerprint(source.tabs)),
          ),
        };
      if (!priorityProposals.has(request.hash)) {
        const entry = priorityPlan.plan.evidence.find((entry) => entry.hash === request.hash);
        if (entry && !entry.valid)
          priorityProposals.set(request.hash, proposalFor(entry.base, editor, source));
      }
      const steps = matchingPlanSteps(priorityPlan.plan, source, priorityProposals, request.hash);
      let next = steps.next();
      while (!next.done) next = steps.next();
      return {
        hash: request.hash,
        fingerprint: priorityPlan.plan.fingerprint,
        baseline: priorityPlan.plan.baseline,
        entry: priorityPlan.plan.categories
          .flatMap((category) => category.entries)
          .find((entry) => entry.hash === request.hash),
        proposal: priorityProposals.has(request.hash)
          ? compactProposal(priorityProposals.get(request.hash)!)
          : undefined,
        decision: next.value.decisions.find((decision) => decision.hash === request.hash),
        matches: new Map(
          [...next.value.matches].map(([hash, match]) => [hash, compactMatch(match)]),
        ),
      };
    });
    sendWorkerResult(emit, request.id, result);
  } catch (error) {
    self.postMessage({
      id: request.id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
async function process(data: Request) {
  try {
    if (data.initialChunk) {
      const { token, bytes } = data.initialChunk;
      const chunks = initialChunks.get(token) ?? [];
      chunks.push(new Uint8Array(bytes));
      initialChunks.set(token, chunks);
      return;
    }
    if (data.cancelInit) {
      initialChunks.delete(data.cancelInit.token);
      return;
    }
    const id = data.id ?? 0;
    if (data.load) {
      initialized = false;
      modelToken = undefined;
      source = await (
        await import('../../services/compendiumSource')
      ).fetchCompendiumSource(data.load.url);
      sendWorkerResult(emit, id, source);
    } else if (data.initialize) {
      initialized = false;
      modelToken = undefined;
      const chunks = initialChunks.get(data.initialize.token);
      initialChunks.delete(data.initialize.token);
      if (!chunks) throw new Error('Compendium inputs were superseded.');
      const bytes = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
      let at = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, at);
        at += chunk.length;
      }
      const input = JSON.parse(new TextDecoder().decode(bytes)) as {
        editor: EditorData;
        source?: CompendiumData;
      };
      editor = input.editor;
      if (input.source) source = input.source;
      if (!source) throw new Error('Compendium source is not loaded.');
      precomputedDisplay = undefined;
      lastDisplay = undefined;
      priorityPlan = undefined;
      priorityProposals.clear();
      fingerprint = undefined;
      modelToken = data.initialize.token;
      // Install the message handler before loading modules with top-level await.
      // Otherwise a worker can drop the source request during module initialization.
      const { matchingYield } = await import('./matchingSessionPlanning');
      // Let the current pane run before hashing, assets, caches, and the full catalog.
      await matchingYield();
      await servePriority();
      dataKey = await contentHash(matchingInputs(editor, source));
      const prepared = await cachedComputation<{
        proposals: Map<number, ReviewProposal>;
        display?: ReturnType<typeof displayMatches>;
      }>(`${import.meta.url}:prepared:${dataKey}`, async () => {
        const compressed = typeof DecompressionStream !== 'undefined';
        const response = await fetch(compressed ? compressedUrl : precomputedUrl);
        if (response.ok) {
          const encoded = (await (compressed ? compressedJson(response) : response.json())) as {
            nodes: unknown[];
            root: number;
          };
          const precomputed = decodePrecomputed(encoded.nodes, encoded.root) as {
            key: string;
            proposals: [number, ReviewProposal][];
            display: Omit<ReturnType<typeof displayMatches>, 'matches'> & {
              matches: [
                number,
                NonNullable<ReviewProposal['match']> & { status: 'ok'; changed: boolean },
              ][];
            };
          };
          if (precomputed.key === dataKey) {
            const display = {
              ...precomputed.display,
              matches: new Map(precomputed.display.matches),
            };
            return {
              display,
              proposals: new Map(precomputed.proposals),
            };
          }
        }
        const [{ reviewEvidence }, { proposalFor }, { withCompendiumMatchingIndex }] =
          await Promise.all([
            import('./reviewQueue'),
            import('./rapidReview'),
            import('@clarity/core'),
          ]);
        const entries = reviewEvidence(editor, source, {}, '').filter((entry) => !entry.valid);
        const computed = new Map<number, ReviewProposal>();
        let index = 0;
        while (index < entries.length) {
          withCompendiumMatchingIndex(source, () => {
            const end = performance.now() + 8;
            do {
              const entry = entries[index++];
              const proposal =
                priorityProposals.get(entry.hash) ?? proposalFor(entry.base, editor, source);
              priorityProposals.set(entry.hash, proposal);
              computed.set(entry.hash, compactProposal(proposal));
            } while (index < entries.length && performance.now() < end);
          });
          await matchingYield();
        }
        return { proposals: computed };
      });
      // Cache the two halves together. A proposals-only cache hit used to lose
      // its pristine display model and rerun all guidance on an immediate reload.
      const tabs = new Map(source.tabs.map((tab) => [tab.gid, tab]));
      const restore = (match: ReviewProposal['match']) =>
        match && {
          ...match,
          tab: tabs.get(match.tab.gid) ?? match.tab,
        };
      // Persist locations rather than a second copy of the entire source grid.
      // Matching still receives the complete, current source tabs after a hit.
      proposals = new Map(
        [...prepared.proposals].map(([hash, proposal]) => [
          hash,
          {
            ...proposal,
            match: restore(proposal.match),
            candidates: proposal.candidates.map((match) => restore(match)!),
          },
        ]),
      );
      for (const [hash, proposal] of proposals) priorityProposals.set(hash, proposal);
      precomputedDisplay = prepared.display;
      sendWorkerResult(
        emit,
        id,
        new Map([...proposals].map(([hash, proposal]) => [hash, compactProposal(proposal)])),
      );
      initialized = true;
    } else if (data.guide) {
      if (!initialized) throw new Error('Compendium initialization has not completed.');
      // Coalesce queued navigation/search requests before any expensive planning work.
      await new Promise((resolve) => setTimeout(resolve, 0));
      if (id !== latestGuide) throw new Error('Superseded Compendium planning request.');
      const { document, baseline, scope, categoryId, restored, statuses } = data.guide;
      const currentStatuses = new Map(statuses);
      if (!lastDisplay) throw new Error('Compendium evidence is still loading.');
      const restoredHashes = new Set(restored);
      const categories = lastDisplay.categories.map((c) => ({
        ...c,
        entries: c.entries.map((e) => ({
          ...e,
          status: currentStatuses.get(e.hash) ?? e.status,
          scopeRestored: restoredHashes.has(e.hash),
        })),
      }));
      const { completeMatchingSteps } = await import('./matchingSessionPlanning');
      const groups = Object.keys(document.categories).length
        ? (
            await completeMatchingSteps(
              source,
              (await import('./guidedDecisions')).guidedDecisionSteps(
                document,
                categories,
                proposals,
                source,
                baseline,
                scope,
                undefined,
                lastDisplay.fingerprint,
              ),
            )
          ).filter((g) => g.id === categoryId)
        : [];
      sendWorkerResult(emit, id, groups);
    } else if (data.input) {
      if (!initialized) throw new Error('Compendium initialization has not completed.');
      if (id !== latestDisplay) throw new Error('Superseded Compendium display request.');
      const { drafts, progress, local } = data.input;
      const pristine =
        !Object.keys(drafts).length &&
        !Object.keys(progress.decisions).length &&
        (!local ||
          !Object.values(local.categories).some(
            (c) => c.comment || Object.keys(c.references ?? {}).length,
          ));
      const key = `${import.meta.url}:display:${dataKey}:${pristine ? 'pristine' : `${editor.bundle.sourceCommit}|${await contentHash(data.input)}`}`;
      const result = await cachedComputation(key, async () => {
        if (pristine && precomputedDisplay) return precomputedDisplay;
        const { finishMatchingPlan, prepareMatchingPlan } =
          await import('./matchingSessionPlanning');
        return finishMatchingPlan(
          prepareMatchingPlan(
            editor,
            source,
            data.input!,
            proposals,
            undefined,
            undefined,
            (fingerprint ??= matchingSessionFingerprint(source.tabs)),
          ),
          source,
          proposals,
        );
      });
      lastDisplay = result;
      const compact = compactDisplay(result);
      // The current pane can use the validated match map before review metadata
      // finishes transferring. Every entry in this map has passed the same gates.
      sendWorkerResult(emit, id, compact, compact.matches);
    }
  } catch (error) {
    if (data.initialize || data.load) modelToken = undefined;
    self.postMessage({
      id: data.id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
