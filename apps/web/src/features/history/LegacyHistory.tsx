import { SkeletonBoundary } from '../../ui/Skeleton';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Tooltip } from '@clarity/core';
import {
  getLegacyHistory,
  legacyRevisionCache,
  type LegacyHistory as History,
  type LegacyLane,
} from '../../services/legacyHistory';
import { HistoryEntry } from './HistoryEntry';
import { useAuthStore } from '../../stores/auth';
import { useDataStore } from '../../stores/data';
import { useDraftStore } from '../../stores/drafts';
import { replaceDraft } from '../../services/save/drafts';
import { restoreLegacyText } from './revert';
import styles from './History.module.scss';
import { englishScope } from './scope';

/** Prepare every script present in the opened artifact, independent of revision order. */
function prepareFonts(history: History | null) {
  if (!history || !document.fonts) return;
  const text = history.lanes
    .flatMap((lane) => lane.revisions.flatMap((revision) => Object.values(revision.text ?? {})))
    .join('\n');
  const faces: [string, RegExp][] = [
    ['HistoryChinese', /[\u3000-\u303f\u3400-\u4dbf\u4e00-\u9fff\uff00-\uffef]/u],
    ['HistoryKorean', /[\u1100-\u11ff\u3130-\u318f\uac00-\ud7af]/u],
    ['HistorySymbols', /[\u2060\u2190-\u21ff\u2900-\u297f\u{1f800}-\u{1f8ff}]/u],
  ];
  for (const [face, pattern] of faces) {
    const sample = text.match(pattern)?.[0];
    if (sample) void document.fonts.load(`13px "${face}"`, sample).catch(() => undefined);
  }
}

export function LegacyHistorySection({
  hash,
  readOnly = false,
}: {
  hash: number;
  readOnly?: boolean;
}) {
  const user = useAuthStore((state) => state.user);
  const base = useDataStore((state) => state.data?.bundle.tooltips[hash]);
  const draft = useDraftStore((state) => state.drafts[hash]);
  const hydrated = useDraftStore((state) => state.hydrated);
  const current = draft?.next ?? base;
  const canRestore =
    !readOnly && hydrated && Boolean(base && user?.role && user.role !== 'translator');
  const translator = user?.role === 'translator';
  const [notice, setNotice] = useState<string>();
  const onRestore = (version: Tooltip) => {
    if (!base || !current || !user || !canRestore) return;
    replaceDraft(base, restoreLegacyText(current, version, user, version.hash === hash));
    setNotice(
      'Published text loaded as a local draft. Review it and use Save; nothing was saved automatically.',
    );
  };
  const [result, setResult] = useState<{ hash: number; value: History | null }>();
  const history = result?.hash === hash ? result.value : undefined;
  const intent = useRef(true);
  const [error, setError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    setResult(undefined);
    setNotice(undefined);
    setError(false);
    // An open panel may survive fast tooltip navigation. Only fetch the item
    // that the user dwells on; skipped items do not need public history.
    const load = () => {
      void getLegacyHistory(hash, controller.signal).then(
        (value) => {
          if (!active) return;
          prepareFonts(value);
          setResult({ hash, value });
        },
        () => active && setError(true),
      );
    };
    let timer: number | undefined;
    if (intent.current) load();
    else timer = window.setTimeout(load, 150);
    intent.current = false;
    return () => {
      active = false;
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [hash, attempt]);
  return (
    <section aria-label="Published before migration" className={styles.historySection}>
      <h4>Published before migration</h4>
      {notice && <p role="status">{notice}</p>}
      <SkeletonBoundary
        pending={history === undefined}
        error={!!error}
        identity={hash}
        label="Loading published history..."
        shape="rows"
      >
        {error ? (
          <p>
            Published history is unavailable offline or could not be loaded.{' '}
            <button
              type="button"
              onClick={() => {
                intent.current = true;
                setAttempt((n) => n + 1);
              }}
            >
              Retry published history
            </button>
          </p>
        ) : history == null ? (
          <p>No published history available for this tooltip.</p>
        ) : (
          history.lanes.map((lane) => (
            <Lane
              key={`${hash}-${lane.sourceHash}`}
              lane={lane}
              current={current}
              canRestore={canRestore && lane.verified}
              translator={translator}
              onRestore={onRestore}
            />
          ))
        )}
      </SkeletonBoundary>
    </section>
  );
}

function Lane({
  lane,
  current,
  canRestore,
  translator,
  onRestore,
}: {
  lane: LegacyLane;
  current?: Tooltip;
  canRestore: boolean;
  translator: boolean;
  onRestore(version: Tooltip): void;
}) {
  const cache = useMemo(() => legacyRevisionCache(lane), [lane]);
  const commits = cache.peekPage(1)!;
  const [count, setCount] = useState(4);
  return (
    <>
      <p>
        Published source <code>{lane.sourceHash}</code>
        {!lane.verified && ' · Alias history (restore unavailable)'}
      </p>
      <ol className={styles.commits}>
        {commits.slice(0, count).map((entry, index) => (
          <HistoryEntry
            key={entry.commit}
            entry={entry}
            index={index}
            commits={commits}
            page={1}
            hasMore={false}
            cache={cache}
            current={current}
            translator={translator}
            legacy
            scope={{ ...englishScope, fields: [] }}
            canRestore={canRestore}
            onRestore={onRestore}
          />
        ))}
      </ol>
      {count < commits.length && (
        <button type="button" onClick={() => setCount((n) => n + 8)}>
          Load more published revisions
        </button>
      )}
    </>
  );
}
