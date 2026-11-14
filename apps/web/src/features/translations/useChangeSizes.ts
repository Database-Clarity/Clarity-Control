import { useCallback, useEffect, useMemo, useState } from 'react';
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
          worker = new Worker(new URL('./changeSize.worker.ts', import.meta.url), {
            type: 'module',
          });
          workers.add(worker);
          const finish = (value: ChangeSize) => {
            worker.terminate();
            workers.delete(worker);
            if (disposed) return;
            memory.set(changeKey(request), value);
            if (memory.size > 1000) memory.delete(memory.keys().next().value!);
            setRevision((value) => value + 1);
            pump();
          };
          worker.onmessage = (event: MessageEvent<ChangeSize>) => finish(event.data);
          worker.onerror = () => finish({ error: 'History unavailable' });
          worker.postMessage({ ...request, url: endpoint(''), headers: authorization() });
        } catch {
          for (const worker of workers) worker.terminate();
          workers.clear();
          memory.set(changeKey(request), { error: 'History unavailable' });
          setRevision((value) => value + 1);
        }
      }
    };
    // Let a fast scroll settle before starting any history requests.
    const timer = setTimeout(pump, 180);
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
  const retryFailed = useCallback(() => {
    for (const [key, value] of memory) if ('error' in value) memory.delete(key);
    setRevision((value) => value + 1);
    setRetry((value) => value + 1);
  }, []);
  return { sizes, onVisible: setVisible, retryFailed };
}
