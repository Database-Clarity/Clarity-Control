import type { CompendiumData } from '@clarity/core';
import type { EditorData } from '../../stores/data';
import type { ReviewProposal } from './rapidReview';
import type { displayMatches } from './displayMatches';
import type { DisplayInput } from './matchingSession';
import { cachedComputation, contentHash } from './workerCache';
import precomputedUrl from './precomputed.v1.json?url';
import compressedUrl from './precomputed.v1.json.gz?url';
import { compressedJson } from './compressedJson';
import { compactMatch, compactProposal } from './compactMatches';
import { decodePrecomputed } from './precomputedCodec';
import type { GuidanceDocument } from './guidanceSchema';
import { matchingInputs } from './matchingInputs';
import { sendWorkerResult, type WorkerReply } from './workerReplies';
const emit = (reply: WorkerReply) => self.postMessage(reply);
let editor: EditorData;
let source: CompendiumData;
let proposals: Map<number, ReviewProposal>;
let dataKey: string;
let latestGuide = 0;
let latestDisplay = 0;
let lastDisplay: ReturnType<typeof displayMatches> | undefined;
let precomputedDisplay: ReturnType<typeof displayMatches> | undefined;
type Request = {
  id?: number;
  load?: { url: string };
  initialChunk?: { token: number; bytes: ArrayBuffer };
  cancelInit?: { token: number };
  initialize?: { token: number };
  input?: DisplayInput;
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
  if (data.guide) latestGuide = data.id ?? 0;
  if (data.input) latestDisplay = data.id ?? 0;
  // A source's worker survives editor reloads. Keep each initialized editor consistent
  // through async cache reads; a later generation never mutates an in-flight model.
  queue = queue.then(() => process(data));
};
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
      source = await (
        await import('../../services/compendiumSource')
      ).fetchCompendiumSource(data.load.url);
      sendWorkerResult(emit, id, source);
    } else if (data.initialize) {
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
      dataKey = await contentHash(matchingInputs(editor, source));
      proposals = await cachedComputation(`${import.meta.url}:proposals:${dataKey}`, async () => {
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
            precomputedDisplay = {
              ...precomputed.display,
              matches: new Map(precomputed.display.matches),
            };
            const restore = (match: ReviewProposal['match']) =>
              match && {
                ...match,
                tab: source.tabs.find((tab) => tab.gid === match.tab.gid) ?? match.tab,
              };
            return new Map(
              precomputed.proposals.map(([hash, p]) => [
                hash,
                { ...p, match: restore(p.match), candidates: p.candidates.map((m) => restore(m)!) },
              ]),
            );
          }
        }
        const [{ reviewEvidence }, { proposalFor }] = await Promise.all([
          import('./reviewQueue'),
          import('./rapidReview'),
        ]);
        return new Map(
          reviewEvidence(editor, source, {}, '')
            .filter((entry) => !entry.valid)
            .map((entry) => [entry.hash, proposalFor(entry.base, editor, source)]),
        );
      });
      sendWorkerResult(
        emit,
        id,
        new Map([...proposals].map(([hash, proposal]) => [hash, compactProposal(proposal)])),
      );
    } else if (data.guide) {
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
      const groups = Object.keys(document.categories).length
        ? (await import('./guidedDecisions'))
            .guidedDecisions(document, categories, proposals, source, baseline, scope)
            .filter((g) => g.id === categoryId)
        : [];
      sendWorkerResult(emit, id, groups);
    } else if (data.input) {
      if (id !== latestDisplay) throw new Error('Superseded Compendium display request.');
      const { drafts, progress, local, scope } = data.input;
      const pristine =
        !Object.keys(drafts).length &&
        !Object.keys(progress.decisions).length &&
        (!local ||
          !Object.values(local.categories).some(
            (c) => c.comment || Object.keys(c.references ?? {}).length,
          ));
      const key = `${import.meta.url}:display:${dataKey}:${pristine ? 'pristine' : `${editor.bundle.sourceCommit}|${await contentHash(data.input)}`}`;
      const result = await cachedComputation(key, async () =>
        pristine && precomputedDisplay
          ? precomputedDisplay
          : (await import('./displayMatches')).displayMatches(
              editor,
              source,
              drafts,
              progress,
              local,
              scope,
              proposals,
            ),
      );
      lastDisplay = result;
      sendWorkerResult(emit, id, {
        ...result,
        matches: new Map([...result.matches].map(([hash, match]) => [hash, compactMatch(match)])),
      });
    }
  } catch (error) {
    self.postMessage({
      id: data.id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
