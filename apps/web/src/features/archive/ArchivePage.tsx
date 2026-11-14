import { SkeletonBoundary } from '../../ui/Skeleton';
import { ReadingTooltip } from '../preview/ReadingTooltip';
import { useLayoutEffect, useRef, useState } from 'react';
import { Link, useLocation, useSearchParams } from 'react-router-dom';
import { languages, removedFromManifest, type Lang } from '@clarity/core';
import { useDataStore } from '../../stores/data';
import { useAuthStore } from '../../stores/auth';
import { useDraftStore } from '../../stores/drafts';
import { useSaveState } from '../../services/save/state';
import { apiUrl } from '../../services/api';
import { TooltipPage } from '../tooltip/TooltipPage';
import { canonicalHash, tooltipFor } from '../navigation/catalog';
import { HistoryWordDiff } from '../history/HistoryWordDiff';
import { RenderedWordDiff } from '../history/RenderedWordDiff';
import { RawDiffToggle } from '../history/RawDiffToggle';
import { useRawDiff } from '../history/diffPreference';
import { languageLabel } from '../../languageLabels';
import { tooltipPath } from '../navigation/stepping';
import {
  archiveCategoryLabel,
  archiveIdentity,
  associateArchive,
  inactiveArchiveHashes,
} from './archive';
import { When } from '../../ui/When';
import type { ArchiveRestore } from '../queue/sources';
import { archiveItem } from '../queue/rows';
import { returnedState, useRestoredScroll, WorkThroughBar } from '../queue/WorkThroughBar';
import { WorkThroughControl } from '../queue/QueueControl';
import { useWorkThrough } from '../queue/useQueue';
import bar from '../queue/WorkThroughBar.module.scss';
import styles from './ArchivePage.module.scss';

export function ArchivePage() {
  const { data, status, error } = useDataStore();
  return (
    <SkeletonBoundary
      pending={!data}
      error={status === 'error' || !!error}
      label="Loading Archive…"
      shape="rows"
    >
      <ArchiveContents />
    </SkeletonBoundary>
  );
}

function ArchiveContents() {
  const [rawDiff] = useRawDiff();
  const { data, status, error, load } = useDataStore();
  const user = useAuthStore((state) => state.user);
  const { drafts, hydrated, updateDraft, updateDrafts } = useDraftStore();
  const locked = useSaveState((state) => state.locked);
  const [params, setParams] = useSearchParams();
  // Leave from a work-through queue brings the view, filter, selection, and scroll back.
  const { state: routeState } = useLocation();
  const restored = returnedState<ArchiveRestore>(routeState);
  // A work-through queue of Archive items: its control sits in the detail's top row (on phones the
  // detail opens on its preview, where the editor's pane header is out of view).
  const workThrough = useWorkThrough(routeState, false);
  const work =
    workThrough?.mode === 'active' && workThrough.queue.source === 'archive' ? workThrough : null;
  const [query, setQuery] = useState(restored?.query ?? '');
  const [returned, setReturned] = useState(restored?.returned ?? false);
  const [picked, setPicked] = useState<ReadonlySet<number>>(
    () => new Set(restored?.selected ?? []),
  );
  const barAnchor = useRef<HTMLDivElement>(null);
  const [picking, setPicking] = useState(false);
  const [targetQuery, setTargetQuery] = useState('');
  const [targetHash, setTargetHash] = useState<number>();
  const [selected, setSelected] = useState<Lang[]>([]);
  const [notice, setNotice] = useState('');
  // Consent to overwrite a draft is tied to the destination it was given for.
  const [replaceFor, setReplaceFor] = useState<number>();
  const scroll = useRef(0);
  const selectedHash = params.get('item');
  const listRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    // Any navigation to another archived item (or back to the list) discards the picker state,
    // including a destination and replace-draft consent left over from browser Back.
    setPicking(false);
    setTargetHash(undefined);
    setTargetQuery('');
    setReplaceFor(undefined);
    setNotice('');
  }, [selectedHash]);
  useLayoutEffect(() => {
    if (!selectedHash && listRef.current) window.scrollTo(0, scroll.current);
    else if (selectedHash) window.scrollTo(0, 0);
  }, [selectedHash]);
  useRestoredScroll(barAnchor, restored?.scroll, Boolean(data) && !selectedHash);
  if (status === 'error' || error)
    return (
      <article className={styles.page}>
        <h1>Archive</h1>
        <p role="alert">
          Couldn't load data — retry{' '}
          <button type="button" onClick={() => void load()}>
            Retry data loading
          </button>
        </p>
        <details>
          <summary>Details</summary>
          {error}
        </details>
      </article>
    );
  if (!data) return null;
  const result = removedFromManifest(
    Object.values(data.bundle.tooltips),
    data.items,
    data.aliases,
    inactiveArchiveHashes(data),
  );
  if (result.paused)
    return (
      <article className={styles.page}>
        <h1>Archive</h1>
        <p role="alert">Manifest looks incomplete — archive view paused</p>
        <p>
          The generated item list is empty or too many tracked tooltips vanished at once, so nothing
          is listed and nothing is written until the next complete manifest.
        </p>
      </article>
    );
  const entries = returned ? result.returned : result.removed;
  const shown = entries.filter((tooltip) =>
    `${archiveIdentity(tooltip, data).name} ${tooltip.hash}`
      .toLocaleLowerCase()
      .includes(query.toLocaleLowerCase()),
  );
  const base = [...result.removed, ...result.returned].find(
    (entry) => String(entry.hash) === selectedHash,
  );
  const current = base && (drafts[base.hash]?.next ?? base);
  const canAct = Boolean(apiUrl && hydrated && !locked && user?.role === 'maintainer');
  const canRestore = Boolean(
    apiUrl && hydrated && !locked && ['maintainer', 'editor'].includes(user?.role ?? ''),
  );
  const targetBase = targetHash === undefined ? undefined : tooltipFor(targetHash, data);
  const targetDraft = targetBase && drafts[targetBase.hash];
  const target = targetBase && (targetDraft?.next ?? targetBase);
  const associated = current?.archive?.successor !== undefined;
  const staged = associated && current.archive?.successor !== base?.archive?.successor;
  const replaceDraft = targetHash !== undefined && replaceFor === targetHash;
  function back() {
    const next = new URLSearchParams(params);
    next.delete('item');
    setParams(next);
    setPicking(false);
    setTargetHash(undefined);
    setReplaceFor(undefined);
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
    setNotice('Archive confirmation staged → Review changes and save the draft.');
  }
  function associate() {
    if (!canAct || !base || !current || !targetBase || !target || !data!.items[target.hash]) return;
    if (current.archive?.successor !== undefined || (targetDraft && !replaceDraft)) return;
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
    setTargetHash(undefined);
    setReplaceFor(undefined);
    setNotice('');
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
        <div ref={barAnchor}>
          <WorkThroughBar
            source="archive"
            selected={shown
              .filter((tooltip) => picked.has(tooltip.hash))
              .map((tooltip) => archiveItem(tooltip, data, drafts))}
            shown={shown.map((tooltip) => archiveItem(tooltip, data, drafts))}
            restore={
              { returned, query, selected: [...picked] } satisfies Omit<ArchiveRestore, 'scroll'>
            }
            onClear={() => setPicked(new Set())}
            anchor={barAnchor}
          />
        </div>
        {!entries.length && (
          <p>
            {returned
              ? 'No archived tooltips have returned.'
              : 'No tracked tooltips have left the manifest.'}
          </p>
        )}
        <ul>
          {shown.map((tooltip) => {
            const identity = archiveIdentity(tooltip, data);
            return (
              <li key={tooltip.hash} className={styles.card}>
                <div className={styles.cardHead}>
                  <label className={bar.select}>
                    <input
                      type="checkbox"
                      checked={picked.has(tooltip.hash)}
                      aria-label={`Select ${identity.name}`}
                      onChange={(event) => {
                        const on = event.target.checked;
                        setPicked((old) => {
                          const next = new Set(old);
                          if (on) next.add(tooltip.hash);
                          else next.delete(tooltip.hash);
                          return next;
                        });
                      }}
                    />
                  </label>
                  <button
                    type="button"
                    onClick={() => {
                      scroll.current = window.scrollY;
                      const next = new URLSearchParams(params);
                      next.set('item', String(tooltip.hash));
                      setParams(next);
                    }}
                  >
                    {identity.name}
                    {identity.name === `Tooltip ${tooltip.hash}` ? '' : ` (${tooltip.hash})`}
                  </button>
                </div>
                <p>{archiveCategoryLabel(identity.categoryId, data)}</p>
                <p>
                  <strong>{tooltip.archive ? 'Confirmed' : 'Unconfirmed'}</strong> ·{' '}
                  {tooltip.archive ? (
                    <>
                      Removed <When nowrap value={tooltip.archive.removedAt} />
                    </>
                  ) : (
                    'removal detected from the current manifest'
                  )}
                  {data.items[tooltip.hash] && ' · back in manifest'}
                </p>
                <p>
                  Languages:{' '}
                  {languages
                    .filter((lang) => tooltip.text[lang]?.text.trim())
                    .map(languageLabel)
                    .join(', ') || 'none'}
                </p>
                {tooltip.archive?.successor !== undefined && (
                  <p>
                    Successor:{' '}
                    <Link to={tooltipPath(tooltip.archive.successor, '')}>
                      {data.items[tooltip.archive.successor]?.name ?? 'Tooltip'} (
                      {tooltip.archive.successor})
                    </Link>
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      </div>
      {selectedHash && (
        <>
          <div className={styles.detailBar}>
            {/* In a queue, its "Archive" link is the way back (it leaves the queue). */}
            {work ? (
              <WorkThroughControl work={work} />
            ) : (
              <button type="button" onClick={back}>
                Back to Archive
              </button>
            )}
          </div>
          {!base || !current ? (
            <p>This tooltip is no longer in this Archive filter.</p>
          ) : (
            <>
              {notice && <p role="status">{notice}</p>}
              <section className={styles.status} aria-label="Archive status">
                <p>
                  <strong>{current.archive ? 'Confirmed' : 'Unconfirmed'}</strong>
                  {current.archive ? (
                    <>
                      {' '}
                      · Removed <When nowrap value={current.archive.removedAt} />. Name and category
                      are saved from the last manifest.
                    </>
                  ) : (
                    ' · Removed from the manifest, not yet confirmed. Confirming saves the name and category so this stays readable if the catalog changes.'
                  )}
                  {data.items[base.hash] && ' This item is back in the current manifest.'}
                </p>
                {current.archive?.successor !== undefined && (
                  <p>
                    Superseded by{' '}
                    <Link to={tooltipPath(current.archive.successor, '')}>
                      {data.items[current.archive.successor]?.name ?? 'Tooltip'} (
                      {current.archive.successor})
                    </Link>
                    {staged && ' — staged as a local draft'}.
                  </p>
                )}
                {!canAct && !canRestore && (
                  <p>Only maintainers can confirm, restore or move archived text.</p>
                )}
              </section>
              <div className={styles.actions}>
                {!current.archive && !data.items[base.hash] && user?.role === 'maintainer' && (
                  <div>
                    <button type="button" disabled={!canAct} onClick={confirmArchive}>
                      Confirm archival
                    </button>
                    <p className={styles.consequence}>
                      Confirm archival: saves the name and category as they were, as a local draft.
                      Nothing is saved until review.
                    </p>
                  </div>
                )}
                {current.archive && data.items[base.hash] && canRestore && (
                  <div>
                    <button
                      type="button"
                      onClick={() => {
                        updateDraft(base, (next) => {
                          delete next.archive;
                          return next;
                        });
                        setNotice('Restore staged → Review changes and save the draft.');
                      }}
                    >
                      Restore
                    </button>
                    <p className={styles.consequence}>
                      Restore: clears the archive flag as a local draft. Text is untouched. Nothing
                      is saved until review.
                    </p>
                  </div>
                )}
                {!data.items[base.hash] &&
                  user?.role === 'maintainer' &&
                  (associated ? (
                    <p className={styles.consequence}>
                      {staged
                        ? 'Association staged → Review changes and save the drafts.'
                        : 'Association saved.'}
                    </p>
                  ) : (
                    <div>
                      <button
                        type="button"
                        disabled={!canAct || !current.archive}
                        onClick={() => {
                          setPicking(true);
                          setTargetHash(undefined);
                          setReplaceFor(undefined);
                          setSelected(
                            languages.filter((lang) => Boolean(current.text[lang]?.text.trim())),
                          );
                        }}
                      >
                        Associate with new item…
                      </button>
                      <p className={styles.consequence}>
                        {current.archive
                          ? 'Associate: copies chosen languages into a local draft on the new item and marks this one superseded. Nothing is saved until review.'
                          : 'Confirm archival first, then you can associate this text with a new item.'}
                      </p>
                    </div>
                  ))}
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
                            <button
                              type="button"
                              onClick={() => {
                                setTargetHash(item.hash);
                                setReplaceFor(undefined);
                              }}
                            >
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
                              Copy {languageLabel(lang)}
                            </label>
                            <div className={styles.comparison}>
                              <div>
                                <h4>Archived text</h4>
                                <ReadingTooltip
                                  text={current.text[lang]?.text ?? ''}
                                  lang={lang}
                                  hash={current.hash}
                                />
                              </div>
                              <div>
                                <h4>Destination current text</h4>
                                {target.text[lang]?.text ? (
                                  <ReadingTooltip
                                    text={target.text[lang]!.text}
                                    lang={lang}
                                    hash={target.hash}
                                  />
                                ) : (
                                  <p>(empty)</p>
                                )}
                              </div>
                            </div>
                            <p className={styles.consequence}>
                              Changes the draft would make to {data.items[target.hash].name} (
                              {target.hash}), {languageLabel(lang)}:
                            </p>
                            <RawDiffToggle />
                            {rawDiff ? (
                              <HistoryWordDiff
                                before={target.text[lang]?.text ?? ''}
                                after={current.text[lang]?.text ?? ''}
                              />
                            ) : (
                              <RenderedWordDiff
                                before={target.text[lang]?.text ?? ''}
                                after={current.text[lang]?.text ?? ''}
                                lang={lang}
                                hash={target.hash}
                              />
                            )}
                          </section>
                        ))}
                      {targetDraft && (
                        <label>
                          <input
                            type="checkbox"
                            checked={replaceDraft}
                            onChange={(event) =>
                              setReplaceFor(event.target.checked ? target.hash : undefined)
                            }
                          />
                          {data.items[target.hash].name} ({target.hash}) already has a local draft.
                          Replace the selected languages in that draft.
                        </label>
                      )}
                      <button
                        type="button"
                        disabled={
                          !canAct || !selected.length || Boolean(targetDraft && !replaceDraft)
                        }
                        onClick={associate}
                      >
                        Confirm association as drafts
                      </button>
                    </>
                  )}
                  <button
                    type="button"
                    onClick={() => {
                      setPicking(false);
                      setTargetHash(undefined);
                      setReplaceFor(undefined);
                    }}
                  >
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
