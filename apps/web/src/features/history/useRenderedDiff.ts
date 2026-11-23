import { useEffect, useMemo, useRef, useState } from 'react';
import type { MarkupGlobals } from '@clarity/core';
import { diagnosticGlobals } from '../editor/diagnosticWorker';
import { compareDiffOutput, presentDiff, renderedDiff } from './renderedDiff';
import type { SourceAnalysis } from './sourceOnlyChanges';
import type { RenderedDiffReply, RenderedDiffRequest } from './renderedDiff.worker';

type Result = NonNullable<RenderedDiffReply['result']> & { sourceAnalysis?: SourceAnalysis };
let worker: Worker | undefined;
let sequence = 0;
// Per request: called with each reply, or with nothing when the worker died.
const pending = new Map<number, (reply?: RenderedDiffReply) => void>();
// Complete results only (diff and source check): a cancelled check never caches.
const cache = new Map<string, Result>();
const post = (request: RenderedDiffRequest) => worker?.postMessage(request);
function startWorker() {
  if (worker) return;
  worker = new Worker(new URL('./renderedDiff.worker.ts', import.meta.url), { type: 'module' });
  worker.onmessage = (event: MessageEvent<RenderedDiffReply>) =>
    pending.get(event.data.id)?.(event.data);
  worker.onerror = () => {
    for (const callback of pending.values()) callback();
    pending.clear();
    worker?.terminate();
    worker = undefined;
  };
}

/**
 * Whether two saved texts render differently (Base and Enhanced), off the main thread. Review
 * asks this for every waiting change in the background; undefined when the check failed.
 */
export function classifyRendered(
  before: string,
  after: string,
  globals: MarkupGlobals,
  beforeGlobals = globals,
): Promise<NonNullable<RenderedDiffReply['classified']> | undefined> {
  const text = `${before}\n${after}`;
  const snapshot = diagnosticGlobals(text, globals);
  const beforeSnapshot =
    beforeGlobals === globals ? snapshot : diagnosticGlobals(text, beforeGlobals);
  if (typeof Worker === 'undefined')
    return Promise.resolve().then(() => {
      try {
        return compareDiffOutput(before, after, snapshot, beforeSnapshot);
      } catch {
        return undefined;
      }
    });
  return new Promise((resolve) => {
    const id = ++sequence;
    try {
      startWorker();
      pending.set(id, (reply) => {
        pending.delete(id);
        resolve(reply?.classified);
      });
      post({ id, before, after, globals: snapshot, beforeGlobals: beforeSnapshot, classify: true });
    } catch {
      pending.delete(id);
      resolve(undefined);
    }
  });
}

/** Keep the bounded word alignment off the opening/input path for long descriptions. */
export function useRenderedDiff(
  before: string,
  after: string,
  globals: MarkupGlobals,
  beforeGlobals = globals,
) {
  const large = !!before && !!after && before.length + after.length > 4000;
  const snapshot = useMemo(
    () => diagnosticGlobals(`${before}\n${after}`, globals),
    [before, after, globals],
  );
  const beforeSnapshot = useMemo(
    () =>
      beforeGlobals === globals
        ? snapshot
        : diagnosticGlobals(`${before}\n${after}`, beforeGlobals),
    [before, after, globals, beforeGlobals, snapshot],
  );
  // Capture only reachable imports for the worker's bounded source checks.
  const key = useMemo(
    () =>
      JSON.stringify([
        before,
        after,
        snapshot,
        ...(beforeSnapshot === snapshot ? [] : [beforeSnapshot]),
      ]),
    [before, after, snapshot, beforeSnapshot],
  );
  const [computed, setComputed] = useState<{
    key: string;
    result?: Result;
    sourceFailed?: boolean;
  }>();
  const initial = useMemo<Result>(
    () =>
      cache.get(key) ?? presentDiff(renderedDiff(before, after, snapshot, !large, beforeSnapshot)),
    [key, before, after, snapshot, beforeSnapshot, large],
  );
  const cached = cache.get(key);
  const opening = useRef(true);
  useEffect(() => {
    const initialOpening = opening.current;
    opening.current = false;
    if ((before === after && beforeSnapshot === snapshot) || cached) return;
    if (typeof Worker === 'undefined') return;
    const id = ++sequence;
    // The diff paints first; the complete source check lands after it. A short
    // text's opening diff is already exact, so only a long text's provisional
    // diff is replaced (and its skeleton released) before the check finishes.
    let diff: Result | undefined;
    const finish = (reply?: RenderedDiffReply) => {
      if (reply?.result) {
        diff = reply.result;
        if (large) setComputed({ key, result: diff });
        return;
      }
      pending.delete(id);
      if (reply?.sourceAnalysis && diff) {
        const result = { ...diff, sourceAnalysis: reply.sourceAnalysis };
        cache.set(key, result);
        while (cache.size > 24) cache.delete(cache.keys().next().value!);
        setComputed({ key, result });
        return;
      }
      setComputed({ key, result: diff, sourceFailed: true });
    };
    const run = () => {
      try {
        startWorker();
        pending.set(id, finish);
        post({ id, before, after, globals: snapshot, beforeGlobals: beforeSnapshot });
      } catch {
        pending.delete(id);
        finish();
      }
    };
    // A pinned comparison may receive editor snapshots while typing. Only its
    // opening runs immediately; subsequent snapshots must settle first.
    const timer = initialOpening ? undefined : window.setTimeout(run, 200);
    if (initialOpening) run();
    return () => {
      if (timer !== undefined) window.clearTimeout(timer);
      // A newer diff or a closed view drops the old check in the worker too.
      if (pending.delete(id)) post({ cancel: id });
    };
  }, [before, after, snapshot, beforeSnapshot, key, large, cached]);
  return {
    result: cached ?? (computed?.key === key ? computed.result : undefined) ?? initial,
    sourceAnalysis:
      cached?.sourceAnalysis ??
      (computed?.key === key ? computed.result?.sourceAnalysis : undefined),
    sourceUnavailable:
      typeof Worker === 'undefined' ||
      (computed?.key === key && (!computed.result || !!computed.sourceFailed)),
    busy: large && typeof Worker !== 'undefined' && !cached && computed?.key !== key,
  };
}
