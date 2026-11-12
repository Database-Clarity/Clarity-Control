import { SkeletonBoundary } from '../../ui/Skeleton';
import { useEffect, useState } from 'react';
import { diffWords, type WordChange } from '../../ui/diff';
import styles from '../../ui/diff/WordDiff.module.scss';

let worker: Worker | undefined;
let sequence = 0;
const pending = new Map<number, (parts: WordChange[] | null) => void>();
const results = new Map<string, WordChange[]>();
const coarse = (before: string, after: string): WordChange[] =>
  before === after
    ? [{ kind: 'equal', text: before }]
    : [
        { kind: 'delete', text: before },
        { kind: 'insert', text: after },
      ];

/** Small diffs stay synchronous; large ones cannot block opening or scrolling history. */
export function HistoryWordDiff({ before, after }: { before: string; after: string }) {
  const key = JSON.stringify([before, after]);
  const large = before.length + after.length > 4000;
  const [computed, setComputed] = useState<{ key: string; parts: WordChange[] }>();
  const cached = results.get(key);
  useEffect(() => {
    if (!large || cached || typeof Worker === 'undefined') return;
    const id = ++sequence;
    try {
      if (!worker) {
        worker = new Worker(new URL('./diff.worker.ts', import.meta.url), { type: 'module' });
        worker.onmessage = (event: MessageEvent<{ id: number; parts: WordChange[] }>) => {
          pending.get(event.data.id)?.(event.data.parts);
          pending.delete(event.data.id);
        };
        worker.onerror = () => {
          for (const finish of pending.values()) finish(null);
          pending.clear();
          worker?.terminate();
          worker = undefined;
        };
      }
      pending.set(id, (parts) => {
        if (parts) {
          results.set(key, parts);
          while (results.size > 24) results.delete(results.keys().next().value!);
        }
        setComputed({ key, parts: parts ?? coarse(before, after) });
      });
      worker.postMessage({ id, before, after });
    } catch {
      pending.delete(id);
      setComputed({ key, parts: coarse(before, after) });
    }
    return () => {
      pending.delete(id);
    };
  }, [before, after, key, large, cached]);
  const parts =
    cached ??
    (computed?.key === key ? computed.parts : undefined) ??
    (large ? coarse(before, after) : diffWords(before, after));
  return (
    <SkeletonBoundary
      pending={large && typeof Worker !== 'undefined' && !cached && computed?.key !== key}
      identity={key}
      label="Preparing word diff…"
      text={after || before}
    >
      <div
        className={styles.diff}
        aria-busy={
          (large && typeof Worker !== 'undefined' && !cached && computed?.key !== key) || undefined
        }
        aria-label="Word diff: removed text struck through, added text underlined"
      >
        {parts.map((part, index) =>
          part.kind === 'delete' ? (
            <del key={index}>{part.text}</del>
          ) : part.kind === 'insert' ? (
            <ins key={index}>{part.text}</ins>
          ) : (
            <span key={index}>{part.text}</span>
          ),
        )}
        {!before && !after && <span>No text</span>}
      </div>
    </SkeletonBoundary>
  );
}
