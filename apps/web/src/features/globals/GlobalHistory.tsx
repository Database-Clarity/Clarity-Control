import { useEffect, useState } from 'react';
import type { Lang } from '@clarity/core';
import { languageLabel } from '../../languageLabels';
import { Popover } from '../../ui/Popover';
import { WordDiff } from '../../ui/diff/WordDiff';
import type { GlobalEntry, GlobalResult } from '../../services/globals';
import type { GlobalHistoryPage, GlobalHistoryVersion } from '../../services/globalsHttp';
import styles from './GlobalEntryWorkspace.module.scss';

export type GlobalHistoryReader = (
  id: string,
  cursor: string,
) => Promise<GlobalResult<GlobalHistoryPage>>;

const operationLabel: Record<GlobalHistoryVersion['operation'], string> = {
  create: 'Created',
  edit: 'Edited',
  rename: 'Renamed',
  remove: 'Removed',
  restore: 'Restored',
};

/**
 * Saved versions of one entry, newest first. Restore only loads an older body into the draft:
 * saving it is an ordinary definition save, with the same permissions, Sync pending cause, and
 * impact reviews as any edit.
 */
export function GlobalHistory({
  read,
  entry,
  lang,
  saved,
  canRestore,
  onRestore,
}: {
  read: GlobalHistoryReader;
  entry: GlobalEntry;
  lang: Lang;
  saved: string;
  canRestore: boolean;
  onRestore(body: string): void;
}) {
  const [state, setState] = useState<{
    key: string;
    versions: GlobalHistoryVersion[];
    next: string | null;
    error: string;
    loading: boolean;
  }>();
  const key = `${entry.id}:${entry.revision}`;
  const [cursor, setCursor] = useState({ key, value: 'p0' });
  if (cursor.key !== key) setCursor({ key, value: 'p0' });
  useEffect(() => {
    let active = true;
    const page = cursor.key === key ? cursor.value : 'p0';
    setState((previous) => ({
      key,
      versions: previous?.key === key && page !== 'p0' ? previous.versions : [],
      next: null,
      error: '',
      loading: true,
    }));
    void read(entry.id, page).then((result) => {
      if (!active) return;
      setState((previous) => ({
        key,
        versions:
          result.kind === 'ok'
            ? [...(previous?.key === key ? previous.versions : []), ...result.value.versions]
            : (previous?.versions ?? []),
        next: result.kind === 'ok' ? result.value.nextCursor : (previous?.next ?? null),
        error: result.kind === 'ok' ? '' : result.message,
        loading: false,
      }));
    });
    return () => {
      active = false;
    };
  }, [read, entry.id, key, cursor]);
  const versions = state?.key === key ? state.versions : [];
  return (
    <div className={styles.paneBody}>
      {state?.error && <p role="alert">{state.error}</p>}
      {!versions.length && !state?.loading && !state?.error && <p>No saved versions.</p>}
      <ul className={styles.history}>
        {versions.map((version) => {
          const body = version.lang === lang ? version.body : null;
          return (
            <li key={`${version.revision}:${version.lang ?? ''}`}>
              <span className={styles.historyMeta}>
                {operationLabel[version.operation]}
                {version.lang ? `, ${languageLabel(version.lang)}` : ''}, {version.by},{' '}
                <time dateTime={version.at}>{new Date(version.at).toLocaleString()}</time>
              </span>
              {body !== null && body !== saved && (
                <span className={styles.historyActions}>
                  <Popover label="Version changes" trigger="Changes">
                    <WordDiff before={body} after={saved} />
                  </Popover>
                  <button
                    type="button"
                    disabled={!canRestore}
                    onClick={() => onRestore(body)}
                    title="Loads this version into the draft; Save definition records it."
                  >
                    Restore
                  </button>
                </span>
              )}
            </li>
          );
        })}
      </ul>
      {state?.loading && <p role="status">Loading history…</p>}
      {state?.next && !state.loading && (
        <button type="button" onClick={() => setCursor({ key, value: state.next! })}>
          Older versions
        </button>
      )}
    </div>
  );
}
