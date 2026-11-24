import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { EditorData } from '../../stores/data';
import { authorization, endpoint } from '../../services/apiAuth';
import {
  changeKey,
  changeSizeMemory as memory,
  type ChangeRequest,
  type ChangeSize,
} from './changeSize';
import type { QueueRow } from './queue';

export type { ChangeSize } from './changeSize';

/** Learning a size never moves a row or pulls another unsized row into the viewport. */
export function useSizeOrder(
  rows: readonly QueueRow[],
  sizes: ReadonlyMap<string, ChangeSize>,
  small: boolean,
  refresh: number,
) {
  const latest = useRef(sizes);
  latest.current = sizes;
  return useMemo(
    () => sortBySize(rows, latest.current, small),
    // Refresh is an explicit user request, not a worker completion.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rows, small, refresh],
  );
}

export function sortBySize(
  rows: readonly QueueRow[],
  sizes: ReadonlyMap<string, ChangeSize>,
  small: boolean,
) {
  if (!small) return rows;
  const size = (row: QueueRow) => {
    const value = sizes.get(row.key);
    return value && 'count' in value ? value.count : Infinity;
  };
  return [...rows].sort((a, b) => size(a) - size(b));
}

/** Starts one word comparison; its one reply (or failure) goes to `finish`. */
function changeSizeWorker(request: ChangeRequest, finish: (value: ChangeSize) => void): Worker {
  const message = { ...request, url: endpoint(''), headers: authorization() };
  const worker = new Worker(new URL('./changeSize.worker.ts', import.meta.url), {
    type: 'module',
  });
  worker.onmessage = (event: MessageEvent<ChangeSize>) => finish(event.data);
  worker.onerror = () => finish({ error: 'History unavailable' });
  worker.postMessage(message);
  return worker;
}

function rememberSize(key: string, value: ChangeSize) {
  memory.set(key, value);
  if (memory.size > 1000) memory.delete(memory.keys().next().value!);
}

/** Let a fast scroll (or stepping) settle before starting any history requests. */
const settleMs = 180;

/** The size of one change, once known: the editor's banner shares the list's worker and cache. */
export function useChangeSize(request: ChangeRequest | undefined): number | undefined {
  const key = request && changeKey(request);
  const [, setRevision] = useState(0);
  const latest = useRef(request);
  latest.current = request;
  useEffect(() => {
    if (!key || memory.has(key) || typeof Worker === 'undefined') return;
    let worker: Worker | undefined;
    const timer = setTimeout(() => {
      try {
        worker = changeSizeWorker(latest.current!, (value) => {
          worker?.terminate();
          rememberSize(key, value);
          setRevision((value) => value + 1);
        });
      } catch {
        // No API or no worker: the banner goes without its count.
      }
    }, settleMs);
    return () => {
      clearTimeout(timer);
      worker?.terminate();
    };
  }, [key]);
  const size = key ? memory.get(key) : undefined;
  return size && 'count' in size ? size.count : undefined;
}

/** The virtual list reports strictly visible rows, excluding overscan and offscreen focus. */
export function useChangeSizes(data: EditorData | null, enabled: boolean) {
  const [visible, setVisible] = useState<readonly QueueRow[]>([]);
  const [revision, setRevision] = useState(0);
  const [retry, setRetry] = useState(0);
  const identities = useMemo(() => {
    const result = new Map<string, string>();
    if (data)
      for (const tooltip of Object.values(data.bundle.tooltips))
        for (const [lang, translation] of Object.entries(tooltip.text)) {
          if (translation?.sourceUpdatedAt)
            result.set(
              `${tooltip.hash}:${lang}`,
              changeKey({
                hash: tooltip.hash,
                sourceUpdatedAt: translation.sourceUpdatedAt,
                current: tooltip.text.en?.text ?? '',
              }),
            );
        }
    return result;
  }, [data]);
  const requests = useMemo(() => {
    const result = new Map<string, ChangeRequest>();
    for (const row of visible) {
      const tooltip = data?.bundle.tooltips[row.hash];
      const sourceUpdatedAt = tooltip?.text[row.language]?.sourceUpdatedAt;
      if (row.state === 'outdated' && sourceUpdatedAt)
        result.set(row.key, {
          hash: row.hash,
          sourceUpdatedAt,
          current: tooltip?.text.en?.text ?? '',
        });
    }
    return result;
  }, [data, visible]);
  useEffect(() => {
    if (!enabled || typeof Worker === 'undefined') return;
    const workers = new Set<Worker>();
    let disposed = false;
    const pending = [...requests.values()].filter((request) => !memory.has(changeKey(request)));
    const pump = () => {
      while (!disposed && workers.size < 2 && pending.length) {
        const request = pending.shift()!;
        let worker: Worker;
        try {
          worker = changeSizeWorker(request, (value) => {
            worker.terminate();
            workers.delete(worker);
            if (disposed) return;
            rememberSize(changeKey(request), value);
            setRevision((value) => value + 1);
            pump();
          });
          workers.add(worker);
        } catch {
          for (const worker of workers) worker.terminate();
          workers.clear();
          memory.set(changeKey(request), { error: 'History unavailable' });
          setRevision((value) => value + 1);
        }
      }
    };
    const timer = setTimeout(pump, settleMs);
    return () => {
      disposed = true;
      clearTimeout(timer);
      for (const worker of workers) worker.terminate();
    };
  }, [requests, enabled, retry]);
  const sizes = useMemo(() => {
    const result = new Map<string, ChangeSize>();
    for (const [row, key] of identities) {
      const value = memory.get(key);
      if (value) result.set(row, value);
    }
    return result;
    // Worker replies mutate the shared cache; revision invalidates this snapshot.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [identities, revision]);
  const retryFailed = useCallback(
    (row?: string) => {
      for (const [key, value] of memory)
        if ('error' in value && (!row || identities.get(row) === key)) memory.delete(key);
      setRevision((value) => value + 1);
      setRetry((value) => value + 1);
    },
    [identities],
  );
  return { sizes, onVisible: setVisible, retryFailed };
}
