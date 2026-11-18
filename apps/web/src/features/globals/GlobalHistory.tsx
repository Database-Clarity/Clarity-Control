import { useEffect, useRef, useState } from 'react';
import type { Lang } from '@clarity/core';
import { languageLabel } from '../../languageLabels';
import { Popover } from '../../ui/Popover';
import { WordDiff } from '../../ui/diff/WordDiff';
import { When } from '../../ui/When';
import type { GlobalEntry, GlobalResult } from '../../services/globals';
import {
  globalHistoryPageSize,
  type GlobalHistoryCommit,
  type GlobalHistoryPage,
  type GlobalHistoryVersion,
} from '../../services/globalsHttp';
import styles from './GlobalEntryWorkspace.module.scss';

export interface GlobalHistoryReader {
  history(id: string, page: number): Promise<GlobalResult<GlobalHistoryPage>>;
  historyVersion(id: string, commit: string): Promise<GlobalResult<GlobalHistoryVersion>>;
}

/**
 * Commits that touched one entry, newest first. Restore only loads an older body into the draft:
 * saving it is an ordinary definition save, with the same permissions, Sync pending cause, and
 * impact reviews as any edit.
 */
export function GlobalHistory({
  reader,
  entry,
  lang,
  saved,
  canRestore,
  onRestore,
}: {
  reader: GlobalHistoryReader;
  entry: GlobalEntry;
  lang: Lang;
  saved: string;
  canRestore: boolean;
  onRestore(body: string): void;
}) {
  const list = useRef<HTMLUListElement>(null);
  const [compareWidth, setCompareWidth] = useState(280);
  useEffect(() => {
    const element = list.current;
    if (!element) return;
    const measure = () => setCompareWidth(element.getBoundingClientRect().width);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  // A new revision (a save here or elsewhere) starts the list again from its newest page.
  const key = `${entry.id}:${entry.revision}`;
  const [pages, setPages] = useState({ key, count: 1 });
  if (pages.key !== key) setPages({ key, count: 1 });
  const [state, setState] = useState<{
    key: string;
    commits: GlobalHistoryCommit[];
    more: boolean;
    error: string;
    loading: boolean;
  }>();
  const page = pages.key === key ? pages.count : 1;
  useEffect(() => {
    let active = true;
    setState((previous) => ({
      key,
      commits: previous?.key === key && page > 1 ? previous.commits : [],
      more: false,
      error: '',
      loading: true,
    }));
    void reader.history(entry.id, page).then((result) => {
      if (!active) return;
      setState((previous) => {
        const kept = previous?.key === key ? previous.commits : [];
        return result.kind === 'ok'
          ? {
              key,
              commits: [...kept, ...result.value.commits],
              more: result.value.commits.length === globalHistoryPageSize,
              error: '',
              loading: false,
            }
          : { key, commits: kept, more: page > 1, error: result.message, loading: false };
      });
    });
    return () => {
      active = false;
    };
  }, [reader, entry.id, key, page]);
  const commits = state?.key === key ? state.commits : [];
  return (
    <div className={styles.paneBody}>
      {state?.error && <p role="alert">{state.error}</p>}
      {!commits.length && !state?.loading && !state?.error && <p>No saved versions.</p>}
      <ul ref={list} className={styles.history}>
        {commits.map((commit) => (
          <li key={commit.commit}>
            <span className={styles.historyMeta}>
              {commit.message.split('\n')[0]}
              {commit.login || commit.author ? `, ${commit.login ?? commit.author}` : ''}
              {commit.date && (
                <>
                  , <When value={commit.date} />
                </>
              )}
            </span>
            <Popover
              label="Version of this definition"
              trigger="Compare"
              triggerLabel={`Compare version ${commit.commit.slice(0, 8)}`}
              width={compareWidth}
            >
              {(close) => (
                <HistoryVersion
                  reader={reader}
                  id={entry.id}
                  commit={commit.commit}
                  lang={lang}
                  saved={saved}
                  canRestore={canRestore}
                  onRestore={(body) => {
                    onRestore(body);
                    close(false);
                  }}
                />
              )}
            </Popover>
          </li>
        ))}
      </ul>
      {state?.loading && <p role="status">Loading history…</p>}
      {state?.more && !state.loading && (
        <button type="button" onClick={() => setPages({ key, count: page + 1 })}>
          Older versions
        </button>
      )}
    </div>
  );
}

/** One version, loaded when its popover opens: the body in this language against the saved one. */
function HistoryVersion({
  reader,
  id,
  commit,
  lang,
  saved,
  canRestore,
  onRestore,
}: {
  reader: GlobalHistoryReader;
  id: string;
  commit: string;
  lang: Lang;
  saved: string;
  canRestore: boolean;
  onRestore(body: string): void;
}) {
  const [result, setResult] = useState<GlobalResult<GlobalHistoryVersion>>();
  useEffect(() => {
    let active = true;
    void reader.historyVersion(id, commit).then((value) => {
      if (active) setResult(value);
    });
    return () => {
      active = false;
    };
  }, [reader, id, commit]);
  if (!result) return <p role="status">Loading version…</p>;
  if (result.kind !== 'ok') return <p role="alert">{result.message}</p>;
  const body = result.value.entry.definitions[lang]?.body;
  if (body === undefined) return <p>No {languageLabel(lang)} definition in this version.</p>;
  return (
    <div className={styles.review}>
      {body === saved ? (
        <p>Same as the saved definition.</p>
      ) : (
        <>
          <p className={styles.versionCaption}>From this version to the saved definition</p>
          <WordDiff before={body} after={saved} />
        </>
      )}
      <button
        type="button"
        disabled={!canRestore || body === saved}
        onClick={() => onRestore(body)}
      >
        Restore into draft
      </button>
    </div>
  );
}
