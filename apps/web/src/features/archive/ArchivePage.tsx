import { useLayoutEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { languages, removedFromManifest, type Lang } from '@clarity/core';
import { useDataStore } from '../../stores/data';
import { useAuthStore } from '../../stores/auth';
import { useDraftStore } from '../../stores/drafts';
import { useSaveState } from '../../services/save/state';
import { apiUrl } from '../../services/api';
import { TooltipPage } from '../tooltip/TooltipPage';
import { canonicalHash, tooltipFor } from '../navigation/catalog';
import { WordDiff } from '../../ui/diff';
import { archiveIdentity, associateArchive, inactiveArchiveHashes } from './archive';
import styles from './ArchivePage.module.scss';

export function ArchivePage() {
  const { data, status, error } = useDataStore();
  const user = useAuthStore((state) => state.user);
  const { drafts, hydrated, updateDraft, updateDrafts } = useDraftStore();
  const locked = useSaveState((state) => state.locked);
  const [params, setParams] = useSearchParams();
  const [query, setQuery] = useState('');
  const [returned, setReturned] = useState(false);
  const [picking, setPicking] = useState(false);
  const [targetQuery, setTargetQuery] = useState('');
  const [targetHash, setTargetHash] = useState<number>();
  const [selected, setSelected] = useState<Lang[]>([]);
  const [notice, setNotice] = useState('');
  const scroll = useRef(0);
  const selectedHash = params.get('item');
  const listRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!selectedHash && listRef.current) window.scrollTo(0, scroll.current);
    else if (selectedHash) window.scrollTo(0, 0);
  }, [selectedHash]);
  if (status === 'error' || error)
    return (
      <article>
        <h1>Archive</h1>
        <p role="alert">Manifest looks incomplete — archive view paused</p>
        <details>
          <summary>Details</summary>
          {error}
        </details>
      </article>
    );
  if (!data) return <p role="status">Loading Archive…</p>;
  const result = removedFromManifest(
    Object.values(data.bundle.tooltips),
    data.items,
    data.aliases,
    inactiveArchiveHashes(data),
  );
  if (result.paused)
    return (
      <article>
        <h1>Archive</h1>
        <p role="alert">Manifest looks incomplete — archive view paused</p>
      </article>
    );
  const entries = returned ? result.returned : result.removed;
  const base = [...result.removed, ...result.returned].find(
    (entry) => String(entry.hash) === selectedHash,
  );
  const current = base && (drafts[base.hash]?.next ?? base);
  const canAct = Boolean(apiUrl && hydrated && !locked && user?.role === 'maintainer');
  const canRestore = Boolean(
    apiUrl && hydrated && !locked && ['maintainer', 'editor'].includes(user?.role ?? ''),
  );
  const targetBase = targetHash === undefined ? undefined : tooltipFor(targetHash, data);
  const target = targetBase && (drafts[targetBase.hash]?.next ?? targetBase);
  function back() {
    const next = new URLSearchParams(params);
    next.delete('item');
    setParams(next);
    setPicking(false);
    setTargetHash(undefined);
    setNotice('');
  }
  function confirmArchive() {
    if (!base || !current || !canAct) return;
    updateDraft(base, (next) => ({
      ...next,
      archive: {
        removedAt: new Date().toISOString(),
        lastSeen: archiveIdentity(current, data!),
        note: 'Identity from retained catalog evidence; confirmation staged by maintainer.',
      },
    }));
    setNotice('Archive confirmation staged. Review and save the local draft.');
  }
  function associate() {
    if (!canAct || !base || !current || !targetBase || !target || !data!.items[target.hash]) return;
    const change = associateArchive(
      current,
      target,
      selected,
      user!.login,
      new Date().toISOString(),
    );
    updateDrafts([
      { base, update: () => change.source },
      { base: targetBase, update: () => change.target },
    ]);
    setPicking(false);
    setNotice('Successor and copied text staged as local drafts. Review changes and save.');
  }
  return (
    <article className={styles.page}>
      <div ref={listRef} hidden={Boolean(selectedHash)}>
        <h1>Archive</h1>
        <p>
          Removed tooltips appear immediately. Confirmation and reuse use local drafts and normal
          save review.
        </p>
        <label>
          Filter by name or hash
          <input value={query} onChange={(event) => setQuery(event.target.value)} />
        </label>
        <label>
          View
          <select
            value={returned ? 'returned' : 'removed'}
            onChange={(event) => setReturned(event.target.value === 'returned')}
          >
            <option value="removed">Removed</option>
            <option value="returned">Returned</option>
          </select>
        </label>
        {!entries.length && (
          <p>
            {returned
              ? 'No archived tooltips have returned.'
              : 'No tracked tooltips have left the manifest.'}
          </p>
        )}
        <ul>
          {entries
            .filter((tooltip) =>
              `${archiveIdentity(tooltip, data).name} ${tooltip.hash}`
                .toLocaleLowerCase()
                .includes(query.toLocaleLowerCase()),
            )
            .map((tooltip) => {
              const identity = archiveIdentity(tooltip, data);
              return (
                <li key={tooltip.hash} className={styles.card}>
                  <button
                    type="button"
                    onClick={() => {
                      scroll.current = window.scrollY;
                      const next = new URLSearchParams(params);
                      next.set('item', String(tooltip.hash));
                      setParams(next);
                    }}
                  >
                    {identity.name} ({tooltip.hash})
                  </button>
                  <p>
                    {identity.categoryId} · {tooltip.archive?.removedAt ?? 'Removed, unconfirmed'}
                  </p>
                  <p>
                    Languages:{' '}
                    {languages.filter((lang) => tooltip.text[lang]?.text.trim()).join(', ') ||
                      'none'}
                  </p>
                  {tooltip.archive?.successor !== undefined && (
                    <p>Successor: {tooltip.archive.successor}</p>
                  )}
                </li>
              );
            })}
        </ul>
      </div>
      {selectedHash && (
        <>
          <button type="button" onClick={back}>
            Back to Archive
          </button>
          {!base || !current ? (
            <p>This tooltip is no longer in this Archive filter.</p>
          ) : (
            <>
              {notice && <p role="status">{notice}</p>}
              <div className={styles.actions}>
                {!current.archive && !data.items[base.hash] && canAct && (
                  <button type="button" disabled={!canAct} onClick={confirmArchive}>
                    Confirm archival as draft
                  </button>
                )}
                {current.archive && data.items[base.hash] && canRestore && (
                  <button
                    type="button"
                    onClick={() => {
                      updateDraft(base, (next) => {
                        delete next.archive;
                        return next;
                      });
                      setNotice('Restore staged. Review and save the local draft.');
                    }}
                  >
                    Restore
                  </button>
                )}
                {current.archive && !data.items[base.hash] && canAct && (
                  <button
                    type="button"
                    onClick={() => {
                      setPicking(true);
                      setSelected(
                        languages.filter((lang) => Boolean(current.text[lang]?.text.trim())),
                      );
                    }}
                  >
                    Associate with new item…
                  </button>
                )}
              </div>
              {picking ? (
                <section className={styles.picker} aria-label="Associate with new item">
                  <h2>Choose a current manifest item</h2>
                  <p>
                    Name matches are hints only. Choose the destination and review every language
                    before creating drafts.
                  </p>
                  <label>
                    Search items
                    <input
                      value={targetQuery}
                      onChange={(event) => setTargetQuery(event.target.value)}
                    />
                  </label>
                  {targetQuery.trim() && (
                    <ul>
                      {Object.values(data.items)
                        .filter(
                          (item) =>
                            item.hash !== base.hash &&
                            canonicalHash(item.hash, data) === item.hash &&
                            `${item.name} ${item.hash}`
                              .toLocaleLowerCase()
                              .includes(targetQuery.toLocaleLowerCase()),
                        )
                        .slice(0, 100)
                        .map((item) => (
                          <li key={item.hash}>
                            <button type="button" onClick={() => setTargetHash(item.hash)}>
                              {item.name} ({item.hash})
                            </button>
                          </li>
                        ))}
                    </ul>
                  )}
                  {target && (
                    <>
                      <h3>
                        Destination: {data.items[target.hash].name} ({target.hash})
                      </h3>
                      {languages
                        .filter((lang) => current.text[lang]?.text.trim())
                        .map((lang) => (
                          <section key={lang}>
                            <label>
                              <input
                                type="checkbox"
                                checked={selected.includes(lang)}
                                onChange={(event) =>
                                  setSelected((old) =>
                                    event.target.checked
                                      ? [...old, lang]
                                      : old.filter((value) => value !== lang),
                                  )
                                }
                              />
                              Copy {lang}
                            </label>
                            <div className={styles.comparison}>
                              <div>
                                <h4>Archived text</h4>
                                <pre>{current.text[lang]?.text}</pre>
                              </div>
                              <div>
                                <h4>Destination current text</h4>
                                <pre>{target.text[lang]?.text ?? '(empty)'}</pre>
                              </div>
                            </div>
                            <WordDiff
                              before={target.text[lang]?.text ?? ''}
                              after={current.text[lang]?.text ?? ''}
                            />
                          </section>
                        ))}
                      <button
                        type="button"
                        disabled={!canAct || !selected.length}
                        onClick={associate}
                      >
                        Confirm association as drafts
                      </button>
                    </>
                  )}
                  <button type="button" onClick={() => setPicking(false)}>
                    Cancel association
                  </button>
                </section>
              ) : (
                <TooltipPage hashOverride={base.hash} readOnly />
              )}
            </>
          )}
        </>
      )}
    </article>
  );
}
