import {
  withCompendiumMatchingIndex,
  retainCompendiumMatchingIndex,
  resolveCompendiumLink,
  type CompendiumData,
} from '@clarity/core';
import type { EditorData } from '../../stores/data';
import { proposalFor, type ReviewProposal } from './rapidReview';
import type { displayMatches } from './displayMatches';
import type { DisplayInput } from './matchingSession';
import type { prepareMatchingPlan } from './matchingSessionPlanning';
import { matchingSessionFingerprint } from './matchingSessionFingerprint';
import { compactMatch } from './compactMatches';
import {
  bytesHash,
  cacheWriteActivity,
  cachedComputation,
  cachedValue,
  contentHash,
  storeValue,
} from './workerCache';
import precomputedUrl from './precomputed.v1.json?url';
import compressedUrl from './precomputed.v1.json.gz?url';
import { compressedJson } from './compressedJson';
import { compactDisplay, compactProposal } from './compactMatches';
import { decodePrecomputed, decodeValueNode } from './precomputedCodec';
import type { GuidanceDocument } from './guidanceSchema';
import { matchingInputs } from './matchingInputs';
import {
  replayWorkerResult,
  sendWorkerResultYielding,
  type EncodedReply,
  type WorkerReply,
} from './workerReplies';
const emit = (reply: WorkerReply) =>
  self.postMessage(reply, { transfer: reply.buffer ? [reply.buffer] : [] });
let editor: EditorData;
let source: CompendiumData;
let proposals: Map<number, ReviewProposal>;
let dataKey: string;
let fingerprint: string | undefined;
/** The fetched source's exact bytes, as a cache key (set by every load). */
let sourceKey: string | undefined;
/** Stored identity of the current inputs: their bytes -> dataKey and review fingerprint. */
let identityKey: string | undefined;
/**
 * The worker's own proposals and pristine display for the initialized inputs. After a replayed
 * proposals reply, restoring them waits until something needs them (guidance, a display that is
 * not stored) or the display reply is out: its stored read must not queue behind this one.
 */
let proposalsReady: Promise<void> = Promise.resolve();
let startProposals: (() => Promise<void>) | undefined;
function ensureProposals() {
  const start = startProposals;
  if (start) {
    startProposals = undefined;
    proposalsReady = start();
    void proposalsReady.catch(() => undefined);
  }
  return proposalsReady;
}
let latestGuide = 0;
let latestDisplay = 0;
let latestPriority = 0;
let lastDisplay: ReturnType<typeof displayMatches> | undefined;
let lastDisplayInputKey: string | undefined;
let precomputedDisplay: ReturnType<typeof displayMatches> | undefined;
let initialized = false;
let modelToken: number | undefined;
let failedToken: number | undefined;
let priority: (NonNullable<Request['priority']> & { id: number }) | undefined;
let priorityPlan: { key: string; plan: ReturnType<typeof prepareMatchingPlan> } | undefined;
const priorityProposals = new Map<number, ReviewProposal>();
let loadingAsset: ReturnType<typeof loadPreparedAsset> | undefined;
type PreparedAsset = {
  key: string;
  proposals: [number, ReviewProposal][];
  display: Omit<ReturnType<typeof displayMatches>, 'matches'> & {
    matches: [number, NonNullable<ReviewProposal['match']> & { status: 'ok'; changed: boolean }][];
  };
};

function loadPreparedAsset() {
  const compressed = typeof DecompressionStream !== 'undefined';
  let prepared:
    { encoded: { nodes: unknown[]; root: number }; key: string; fingerprint: string } | undefined;
  const response = fetch(compressed ? compressedUrl : precomputedUrl, { priority: 'low' })
    .then(async (response) => {
      if (response.ok) {
        const encoded = (await (compressed ? compressedJson(response) : response.json())) as {
          nodes: unknown[];
          root: number;
        };
        // Read only the two metadata records while source loading is pending.
        // Expanding the complete catalog here delayed source delivery itself.
        const read = (id: number) => encoded.nodes[id];
        const fields = decodeValueNode(read(encoded.root), read) as {
          key: string;
          display: unknown;
        };
        const display = decodeValueNode(fields.display, read) as { fingerprint: string };
        prepared = { encoded, key: fields.key, fingerprint: display.fingerprint };
      }
      return { prepared };
    })
    .catch((error: unknown) => ({ error }));
  return {
    response,
    get prepared() {
      return prepared;
    },
  };
}
type Request = {
  id?: number;
  load?: { url: string };
  initialChunk?: { token: number; bytes: ArrayBuffer };
  cancelInit?: { token: number };
  initialize?: { token: number };
  input?: DisplayInput;
  priority?: { token: number; hash: number; input: DisplayInput; matchesOnly?: boolean };
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
let planning: Promise<typeof import('./matchingSessionPlanning')> | undefined;
const planningModules = () =>
  (planning ??= Promise.all([
    // Every plan needs these facts. Discover the leaf alongside its consumers,
    // so a late worker-module fetch cannot serialize behind source parsing.
    import('./manifest-facts.json'),
    import('./matchingSessionPlanning'),
  ]).then(([, module]) => module));
function measured<T>(name: string, compute: () => T): T {
  const start = performance.now();
  const value = compute();
  performance.measure(`compendium:${name}`, { start, end: performance.now() });
  performance.clearMeasures(`compendium:${name}`);
  return value;
}
self.onmessage = ({ data }: MessageEvent<Request>) => {
  if (data.priority) {
    if (data.priority.token === failedToken) {
      self.postMessage({ id: data.id, error: 'Compendium initialization has not completed.' });
      return;
    }
    if (priority)
      self.postMessage({ id: priority.id, error: 'Superseded Compendium priority request.' });
    latestPriority = data.id ?? 0;
    priority = { ...data.priority, id: latestPriority };
    void cacheWriteActivity(servePriority());
    return;
  }
  if (data.guide) latestGuide = data.id ?? 0;
  if (data.input) latestDisplay = data.id ?? 0;
  // A source's worker survives editor reloads. Keep each initialized editor consistent
  // through async cache reads; a later generation never mutates an in-flight model.
  queue = cacheWriteActivity(queue.then(() => process(data)));
};
/**
 * Send a result, or replay its stored encoding. Encoding a catalog took longer than the
 * matching it replays on a reopen: an unchanged result is encoded once per content key.
 */
async function sendCachedResult(
  id: number,
  key: string,
  value: () => Promise<unknown>,
  partial?: (value: unknown) => unknown,
) {
  const replyKey = `${key}:reply`;
  const stored = await cachedValue<EncodedReply>(replyKey);
  if (stored) {
    replayWorkerResult(emit, id, stored);
    return;
  }
  const result = await value();
  const capture: EncodedReply = [];
  await sendWorkerResultYielding(
    emit,
    id,
    result,
    partial?.(result),
    yieldBackgroundReply,
    capture,
  );
  storeValue(replyKey, capture);
}
function rememberIdentity() {
  if (identityKey) storeValue(identityKey, { dataKey, fingerprint });
}
async function servePriority() {
  const request = priority;
  if (!request || request.token !== modelToken) return;
  priority = undefined;
  try {
    if (
      request.matchesOnly &&
      lastDisplay &&
      lastDisplayInputKey === JSON.stringify(request.input)
    ) {
      // The complete plan already validated this exact input revision. Publish
      // its current row before continuing to encode the background catalog.
      const match = lastDisplay.matches.get(request.hash);
      self.postMessage({
        id: request.id,
        value: new Map(match ? [[request.hash, compactMatch(match)]] : []),
      });
      return;
    }
    const { prepareMatchingPlan, matchingPlanSteps } = await planningModules();
    // A replacement generation may have arrived during module loading.
    if (request.token !== modelToken) throw new Error('Compendium inputs changed.');
    if (request.id !== latestPriority) throw new Error('Superseded Compendium priority request.');
    const result = withCompendiumMatchingIndex(source, () => {
      const key = `${request.hash}:${JSON.stringify(request.input)}`;
      if (priorityPlan?.key !== key)
        priorityPlan = {
          key,
          plan: measured('priority-prepare', () =>
            prepareMatchingPlan(
              editor,
              source,
              request.input,
              new Map(),
              undefined,
              request.hash,
              (fingerprint ??= matchingSessionFingerprint(source.tabs)),
            ),
          ),
        };
      if (!priorityProposals.has(request.hash)) {
        const entry = priorityPlan.plan.evidence.find((entry) => entry.hash === request.hash);
        const saved =
          entry?.base.compendium && resolveCompendiumLink(entry.base.compendium, source);
        if (entry && !(saved && ['ok', 'changed', 'moved'].includes(saved.status)))
          priorityProposals.set(
            request.hash,
            measured('priority-proposal', () => proposalFor(entry.base, editor, source)),
          );
      }
      const steps = matchingPlanSteps(priorityPlan.plan, source, priorityProposals, request.hash);
      const selected = measured('priority-guide', () => {
        let next = steps.next();
        while (!next.done) next = steps.next();
        return next.value;
      });
      const matches = new Map(
        [...selected.matches].map(([hash, match]) => [hash, compactMatch(match)]),
      );
      // The pane needs just this tooltip's validated match, not review evidence,
      // candidates, or a second copy of the catalog's encoded value table.
      if (request.matchesOnly) return matches;
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
        decision: selected.decisions.find((decision) => decision.hash === request.hash),
        matches,
      };
    });
    // Native clone preserves Map/undefined/shared cells without a JS graph decoder.
    // Only selected-entry results use it; large background results stay transferable
    // and are decoded in yielding slices by the bridge.
    self.postMessage({ id: request.id, value: result });
  } catch (error) {
    self.postMessage({
      id: request.id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
/** Restore or compute this generation's proposals and pristine display (sliced). */
async function prepareProposals(
  preparedKey: string,
  key: string,
  asset: ReturnType<typeof loadPreparedAsset>,
  matchingYield: () => Promise<void>,
) {
  const prepared = await cachedComputation<{
    proposals: Map<number, ReviewProposal>;
    display?: ReturnType<typeof displayMatches>;
  }>(preparedKey, async () => {
    const preparedAsset = await asset.response;
    // A cache hit needs no asset; preserve the original failure behaviour on
    // a miss without leaving an early prefetch rejection unhandled.
    if ('error' in preparedAsset) throw preparedAsset.error;
    const { prepared: metadata } = preparedAsset;
    if (metadata?.key === key) {
      const precomputed = decodePrecomputed(
        metadata.encoded.nodes,
        metadata.encoded.root,
      ) as PreparedAsset;
      const display = {
        ...precomputed.display,
        matches: new Map(precomputed.display.matches),
      };
      return {
        display,
        proposals: new Map(precomputed.proposals),
      };
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
        // Amortize resolver-index construction while bounding navigation's wait.
        const end = performance.now() + 32;
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
}
async function yieldBackgroundReply() {
  await new Promise<void>((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      channel.port1.close();
      channel.port2.close();
      resolve();
    };
    channel.port2.postMessage(null);
  });
  await servePriority();
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
    // A generation never replaces inputs under the previous one's background restore.
    if (data.load || data.initialize) {
      startProposals = undefined;
      await proposalsReady.catch(() => undefined);
    }
    if (data.load) {
      initialized = false;
      modelToken = undefined;
      // Begin planning-module I/O while the source is on the network. The handler
      // is already installed, so top-level awaits cannot drop incoming messages.
      void planningModules().catch(() => undefined);
      const fetchingSource = (
        await import('../../services/compendiumSource')
      ).fetchCompendiumSource(data.load.url);
      // Uniform catalog prefetch overlaps source I/O instead of serializing it
      // after priority planning. A selected reply never waits for this asset.
      loadingAsset = loadPreparedAsset();
      const fetched = await fetchingSource;
      sourceKey = fetched.key;
      fingerprint = undefined;
      let restored: CompendiumData | undefined;
      const restore = async () => (restored = await fetched.read());
      // A stored reply goes out before this worker restores its own copy.
      await sendCachedResult(id, `${import.meta.url}:${fetched.key}`, restore);
      source = restored ?? (await restore());
      // The worker replaces, never edits, its source: keep one lookup index for
      // every sliced matching call instead of rebuilding it per slice.
      retainCompendiumMatchingIndex(source);
    } else if (data.initialize) {
      initialized = false;
      failedToken = undefined;
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
      // Identical input bytes have the same matching key: a reload does not re-serialize them.
      const identity = await bytesHash(bytes);
      const input = measured('inputs-parse', () => JSON.parse(new TextDecoder().decode(bytes))) as {
        editor: EditorData;
        source?: CompendiumData;
      };
      editor = input.editor;
      if (input.source) source = input.source;
      if (!source) throw new Error('Compendium source is not loaded.');
      retainCompendiumMatchingIndex(source);
      const asset = loadingAsset ?? loadPreparedAsset();
      loadingAsset = undefined;
      precomputedDisplay = undefined;
      lastDisplay = undefined;
      lastDisplayInputKey = undefined;
      priorityPlan = undefined;
      priorityProposals.clear();
      if (input.source) fingerprint = undefined;
      // The stored identity names these exact bytes plus the exact source bytes, so its key
      // and fingerprint are the ones the full serialization below would compute again.
      identityKey =
        input.source || sourceKey
          ? `${import.meta.url}:identity:${identity}:${input.source ? 'inline' : sourceKey}`
          : undefined;
      const known = identityKey
        ? await cachedValue<{ dataKey: string; fingerprint?: string }>(identityKey)
        : undefined;
      // The prepared asset already contains the exact review fingerprint. Reuse it
      // only after validating every matching input, including styled source cells.
      // Never wait for the asset here: an uncached/changed source keeps the same
      // independent current-tooltip path while background preparation continues.
      dataKey = known?.dataKey ?? (await contentHash(matchingInputs(editor, source)));
      if (asset.prepared?.key === dataKey) fingerprint = asset.prepared.fingerprint;
      else fingerprint ??= known?.fingerprint;
      const key = dataKey;
      modelToken = data.initialize.token;
      // Install the message handler before loading modules with top-level await.
      // Otherwise a worker can drop the source request during module initialization.
      const planningStart = performance.now();
      const { matchingYield } = await planningModules();
      performance.measure('compendium:planner-wait', {
        start: planningStart,
        end: performance.now(),
      });
      performance.clearMeasures('compendium:planner-wait');
      // Let the current pane run before cache reads and the full catalog.
      await matchingYield();
      await servePriority();
      const preparedKey = `${import.meta.url}:prepared:${key}`;
      const storedReply = await cachedValue<EncodedReply>(`${preparedKey}:reply`);
      startProposals = () => prepareProposals(preparedKey, key, asset, matchingYield);
      if (storedReply) replayWorkerResult(emit, id, storedReply);
      else {
        await ensureProposals();
        const capture: EncodedReply = [];
        await sendWorkerResultYielding(
          emit,
          id,
          new Map([...proposals].map(([hash, proposal]) => [hash, compactProposal(proposal)])),
          undefined,
          yieldBackgroundReply,
          capture,
        );
        storeValue(`${preparedKey}:reply`, capture);
      }
      rememberIdentity();
      initialized = true;
    } else if (data.guide) {
      if (!initialized) throw new Error('Compendium initialization has not completed.');
      // Coalesce queued navigation/search requests before any expensive planning work.
      await new Promise((resolve) => setTimeout(resolve, 0));
      if (id !== latestGuide) throw new Error('Superseded Compendium planning request.');
      await ensureProposals();
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
      const { completeMatchingSteps } = await planningModules();
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
                categoryId,
              ),
            )
          ).filter((g) => g.id === categoryId)
        : [];
      await sendWorkerResultYielding(emit, id, groups, undefined, yieldBackgroundReply);
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
      // A stored reply for the same content key goes out before this worker restores the
      // value it keeps for guidance and the current pane.
      const resolve = async () => {
        const value = await cachedComputation(key, async () => {
          await ensureProposals();
          if (pristine && precomputedDisplay) return precomputedDisplay;
          const { finishMatchingPlan, prepareMatchingPlan } = await planningModules();
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
        lastDisplay = value;
        lastDisplayInputKey = JSON.stringify(data.input);
        return value;
      };
      let resolved = false;
      await sendCachedResult(
        id,
        key,
        async () => {
          const value = await resolve();
          resolved = true;
          await yieldBackgroundReply();
          return compactDisplay(value);
        },
        // The current pane can use the validated match map before review metadata
        // finishes transferring. Every entry in this map has passed the same gates.
        (compact) => (compact as ReturnType<typeof compactDisplay>).matches,
      );
      if (!resolved) await resolve();
      rememberIdentity();
      // Guidance and later displays use the worker's own proposals: restore them now.
      void ensureProposals();
    }
  } catch (error) {
    if (data.initialize || data.load) modelToken = undefined;
    if (data.initialize) {
      failedToken = data.initialize.token;
      if (priority?.token === failedToken) {
        self.postMessage({
          id: priority.id,
          error: 'Compendium initialization has not completed.',
        });
        priority = undefined;
      }
    }
    self.postMessage({
      id: data.id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
