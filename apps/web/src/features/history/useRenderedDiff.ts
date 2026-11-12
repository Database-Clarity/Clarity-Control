import { useEffect, useMemo, useState } from 'react';
import type { MarkupGlobals } from '@clarity/core';
import { diagnosticGlobals } from '../editor/diagnosticWorker';
import { renderedDiff } from './renderedDiff';

type Result = ReturnType<typeof renderedDiff>;
let worker: Worker | undefined;
let sequence = 0;
const pending = new Map<number, (result?: Result) => void>();
const cache = new Map<string, Result>();

/** Keep the bounded word alignment off the opening/input path for long descriptions. */
export function useRenderedDiff(before: string, after: string, globals: MarkupGlobals) {
  const large = !!before && !!after && before.length + after.length > 4000;
  const snapshot = useMemo(
    () => (large ? diagnosticGlobals(`${before}\n${after}`, globals) : globals),
    [before, after, globals, large],
  );
  // Serialization is for worker transport/cache identity only. Synchronous
  // comparisons already have stable React dependencies and can read lazy imports.
  const key = useMemo(
    () => (large ? JSON.stringify([before, after, snapshot]) : ''),
    [before, after, snapshot, large],
  );
  const [computed, setComputed] = useState<{ key: string; result?: Result }>();
  const initial = useMemo(
    () => cache.get(key) ?? renderedDiff(before, after, snapshot, !large),
    [key, before, after, snapshot, large],
  );
  const cached = cache.get(key);
  useEffect(() => {
    if (!large || cached || typeof Worker === 'undefined') return;
    const id = ++sequence;
    const finish = (result?: Result) => {
      if (result) {
        cache.set(key, result);
        while (cache.size > 24) cache.delete(cache.keys().next().value!);
      }
      setComputed({ key, result });
    };
    try {
      if (!worker) {
        worker = new Worker(new URL('./renderedDiff.worker.ts', import.meta.url), {
          type: 'module',
        });
        worker.onmessage = (event: MessageEvent<{ id: number; result?: Result }>) => {
          pending.get(event.data.id)?.(event.data.result);
          pending.delete(event.data.id);
        };
        worker.onerror = () => {
          for (const callback of pending.values()) callback();
          pending.clear();
          worker?.terminate();
          worker = undefined;
        };
      }
      pending.set(id, finish);
      worker.postMessage({ id, before, after, globals: snapshot });
    } catch {
      pending.delete(id);
      finish();
    }
    return () => {
      pending.delete(id);
    };
  }, [before, after, snapshot, key, large, cached]);
  return {
    result: cached ?? (computed?.key === key ? computed.result : undefined) ?? initial,
    busy: large && typeof Worker !== 'undefined' && !cached && computed?.key !== key,
  };
}
