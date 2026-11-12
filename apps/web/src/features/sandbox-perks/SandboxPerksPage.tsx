import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import type { SandboxConflicts, SandboxPick, SandboxPointers } from '@clarity/core';
import { LoadingSkeleton, useSkeletonVisible } from '../../ui/Skeleton';
import { VirtualList } from '../../ui/VirtualList';
import { useMedia } from '../../ui/useMedia';
import { apiUrl } from '../../services/api';
import { errorMessage } from '../../services/http';
import { categoryDisplay } from '../../services/categoryLabels';
import {
  getSandboxPointers,
  putSandboxPointers,
  sandboxPointersChangedMessage,
  type LoadedSandboxPointers,
} from '../../services/sandboxPointers';
import { useAuthStore } from '../../stores/auth';
import { sharedSandboxConflicts, useDataStore, withSandboxPicks } from '../../stores/data';
import { loadSandboxPerkText, useSandboxPerkText } from '../manifest/manifestText';
import {
  bucketLabels,
  buildRows,
  bulkCheck,
  effectivePick,
  kindLabels,
  matches,
  picksToSave,
  type BulkResult,
  type Bucket,
  type Kind,
  type SandboxRow,
  type StatusFilter,
} from './model';
import styles from './SandboxPerks.module.scss';

type Staged = Record<string, SandboxPick | null>;
const statusOrder: StatusFilter[] = [
  'open',
  'same-text',
  'name-match',
  'same-name',
  'suggest-none',
  'judgement',
  'decided',
  'changed',
  'all',
];
const statusLabel = (status: StatusFilter) =>
  status === 'open'
    ? 'Open'
    : status === 'decided'
      ? 'Decided'
      : status === 'changed'
        ? 'Changed since decided'
        : status === 'all'
          ? 'All'
          : bucketLabels[status as Bucket];
const shownCandidates = 3;

export function SandboxPerksPage() {
  const { user, loading: authLoading } = useAuthStore();
  const data = useDataStore((state) => state.data);
  const perkText = useSandboxPerkText();
  const permitted = user?.role === 'maintainer';
  const phone = useMedia('(max-width: 700px)');
  const [conflicts, setConflicts] = useState<SandboxConflicts | null>(null);
  const [saved, setSaved] = useState<LoadedSandboxPointers | null>(null);
  const [staged, setStaged] = useState<Staged>({});
  const [status, setStatus] = useState<StatusFilter>('open');
  const [kind, setKind] = useState<Kind | ''>('');
  const [query, setQuery] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [bulk, setBulk] = useState<BulkResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const [reload, setReload] = useState(0);
  const compileCache = useRef(new Map<string, string>());

  useEffect(() => {
    if (!permitted || !apiUrl) return;
    const controller = new AbortController();
    setError(null);
    void loadSandboxPerkText();
    void Promise.all([sharedSandboxConflicts(), getSandboxPointers(controller.signal)])
      .then(([table, picks]) => {
        if (controller.signal.aborted) return;
        if (!table)
          throw new Error('The generator’s shared sandbox perk list could not be loaded.');
        setConflicts(table);
        setSaved(picks);
        setStale(false);
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) setError(errorMessage(cause));
      });
    return () => controller.abort();
  }, [permitted, user?.id, reload]);

  const generatorAliases = data ? (data.generatorAliases ?? data.aliases) : undefined;
  const rows = useMemo(
    () =>
      data && conflicts && saved && perkText && generatorAliases
        ? buildRows({
            conflicts,
            aliases: generatorAliases,
            tooltips: data.bundle.tooltips,
            items: data.items,
            perkText,
            saved: saved.pointers,
          })
        : null,
    [data, conflicts, saved, perkText, generatorAliases],
  );
  const counts = useMemo(() => {
    const result = Object.fromEntries(statusOrder.map((value) => [value, 0])) as Record<
      StatusFilter,
      number
    >;
    for (const row of rows ?? [])
      for (const value of statusOrder) if (matches(row, value, kind, '')) result[value]++;
    return result;
  }, [rows, kind]);
  const shown = useMemo(
    () => (rows ?? []).filter((row) => matches(row, status, kind, query)),
    [rows, status, kind, query],
  );
  const stagedCount = Object.keys(staged).length;

  const stage = useCallback((hash: string, pick: SandboxPick | null) => {
    setStaged((current) => ({ ...current, [hash]: pick }));
    setNotice(null);
  }, []);
  const unstage = useCallback((hash: string) => {
    setStaged((current) => {
      const next = { ...current };
      delete next[hash];
      return next;
    });
    setNotice(null);
  }, []);

  const pending = authLoading || (permitted && !!apiUrl && !rows && !error);
  const skeleton = useSkeletonVisible(pending, 'Loading sandbox perks…', true);
  if (authLoading || (pending && skeleton))
    return <LoadingSkeleton label="Loading sandbox perks…" shape="rows" visible={skeleton} />;
  if (!permitted)
    return (
      <article className={styles.page}>
        <h1>Sandbox perks</h1>
        <p role="alert">Maintainer access is required to review shared sandbox perks.</p>
      </article>
    );
  if (!apiUrl)
    return (
      <article className={styles.page}>
        <h1>Sandbox perks</h1>
        <p role="alert">The API is not configured. Sandbox picks cannot be edited.</p>
      </article>
    );

  const nameOf = (hash: number) =>
    data?.items[hash]?.name ?? data?.bundle.tooltips[hash]?.custom?.name ?? String(hash);

  async function save() {
    if (!saved || !stagedCount) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const next = await putSandboxPointers(picksToSave(saved.pointers, staged), saved.revision);
      setSaved(next);
      setStaged({});
      setBulk(null);
      applyToEditor(next.pointers, conflicts);
      setNotice(
        `Saved ${stagedCount} ${stagedCount === 1 ? 'change' : 'changes'}. Tooltips with new picks need a push to reach the live data.`,
      );
    } catch (cause) {
      const message = errorMessage(cause);
      if (message === sandboxPointersChangedMessage) setStale(true);
      else setError(message);
    } finally {
      setBusy(false);
    }
  }

  async function applyAllShown() {
    if (!data || !generatorAliases) return;
    const candidates = shown.filter((row) => !Object.hasOwn(staged, row.hash));
    setBusy(true);
    setBulk(null);
    setProgress({ done: 0, total: candidates.length });
    try {
      const result = await bulkCheck(
        candidates,
        { tooltips: data.bundle.tooltips, aliases: generatorAliases, cache: compileCache.current },
        (done) => setProgress({ done, total: candidates.length }),
      );
      const byHash = new Map(candidates.map((row) => [row.hash, row]));
      setStaged((current) => {
        const next = { ...current };
        for (const hash of result.applied) next[hash] = byHash.get(hash)!.suggestion!;
        return next;
      });
      setBulk(result);
    } finally {
      setProgress(null);
      setBusy(false);
    }
  }

  const rowHeight = (row: SandboxRow) => {
    const base = phone ? 6.375 : 3.625;
    return row.hash === expanded ? base + 0.5 + (row.candidates.length + 1) * 2.5 : base;
  };

  return (
    <article className={styles.page}>
      <h1>Sandbox perks</h1>
      <p className={styles.intro}>
        Bungie effects shared by items with different tooltips. Point each one at a reviewed tooltip
        or confirm “no tooltip”; changes apply only after saving.
      </p>
      {error && (
        <p role="alert" className={styles.alert}>
          {error}{' '}
          {!rows && (
            <button type="button" onClick={() => setReload((value) => value + 1)}>
              Retry
            </button>
          )}
        </p>
      )}
      {stale && (
        <p role="alert" className={styles.alert}>
          {sandboxPointersChangedMessage}{' '}
          <button
            type="button"
            onClick={() => {
              setStaged({});
              setReload((value) => value + 1);
            }}
          >
            Reload picks
          </button>
        </p>
      )}
      {saved && !saved.exporting && (
        <p role="alert" className={styles.alert}>
          The publisher installed in the data branch does not apply sandbox picks yet. Picks can be
          reviewed but not saved until it is updated.
        </p>
      )}
      {notice && (
        <p role="status" className={styles.notice}>
          {notice}
        </p>
      )}
      {rows && (
        <>
          <div className={styles.filters} role="group" aria-label="Filter sandbox perks">
            <input
              type="search"
              aria-label="Search by name or hash"
              placeholder="Search name or hash"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
            <select
              aria-label="Status"
              value={status}
              onChange={(event) => {
                setStatus(event.target.value as StatusFilter);
                setBulk(null);
              }}
            >
              {statusOrder.map((value) => (
                <option key={value} value={value}>
                  {statusLabel(value)} ({counts[value]})
                </option>
              ))}
            </select>
            <select
              aria-label="Kind"
              value={kind}
              onChange={(event) => setKind(event.target.value as Kind | '')}
            >
              <option value="">All kinds</option>
              {(Object.keys(kindLabels) as Kind[]).map((value) => (
                <option key={value} value={value}>
                  {kindLabels[value]}
                </option>
              ))}
            </select>
            <span className={styles.count} role="status">
              {shown.length} shown
            </span>
            {status === 'same-text' && (
              <button
                type="button"
                className={styles.bulk}
                disabled={busy || !shown.some((row) => !Object.hasOwn(staged, row.hash))}
                onClick={() => void applyAllShown()}
              >
                {progress
                  ? `Checking ${progress.done}/${progress.total}…`
                  : `Apply all ${shown.filter((row) => !Object.hasOwn(staged, row.hash)).length} shown`}
              </button>
            )}
          </div>
          {bulk && (
            <div className={styles.bulkResult} role="status">
              <p>
                Staged {bulk.applied.length} after the compiled check (every language, base and
                enhanced).{' '}
                {bulk.skipped.length
                  ? `Skipped ${bulk.skipped.length}; they stay open:`
                  : 'None skipped.'}
                <button type="button" className={styles.link} onClick={() => setBulk(null)}>
                  Dismiss
                </button>
              </p>
              {bulk.skipped.length > 0 && (
                <ul>
                  {bulk.skipped.map((row) => (
                    <li key={row.hash}>
                      <strong>{row.name || '(no Bungie name)'}</strong> {row.hash}: {row.reason}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
          {shown.length ? (
            <VirtualList
              className={styles.list}
              label="Shared sandbox perks"
              items={shown}
              itemKey={(row) => row.hash}
              heightRem={rowHeight}
              renderItem={(row) => (
                <Row
                  row={row}
                  staged={staged}
                  expanded={row.hash === expanded}
                  disabled={busy}
                  nameOf={nameOf}
                  onToggle={() =>
                    setExpanded((current) => (current === row.hash ? null : row.hash))
                  }
                  onStage={stage}
                  onUnstage={unstage}
                />
              )}
            />
          ) : (
            <p className={styles.empty}>
              {query || kind
                ? 'No sandbox perks match these filters.'
                : 'Nothing left in this list.'}
            </p>
          )}
          <div className={styles.saveBar}>
            <span role="status">
              {stagedCount
                ? `${stagedCount} staged ${stagedCount === 1 ? 'change' : 'changes'}`
                : 'No staged changes.'}
            </span>
            <button
              type="button"
              disabled={!stagedCount || busy}
              onClick={() => {
                setStaged({});
                setBulk(null);
                setNotice('Staged changes discarded.');
              }}
            >
              Discard
            </button>
            <button
              type="button"
              className={styles.primary}
              disabled={!stagedCount || busy || stale || !saved?.exporting}
              onClick={() => void save()}
            >
              {busy && !progress ? 'Saving…' : 'Save'}
            </button>
          </div>
        </>
      )}
    </article>
  );
}

/** After a save: every tab reads the same aliases push and publish will use. */
function applyToEditor(pointers: SandboxPointers, conflicts: SandboxConflicts | null) {
  if (!conflicts) return;
  useDataStore.setState(({ data }) =>
    data ? { data: withSandboxPicks(data, pointers, conflicts) } : {},
  );
}

function Row({
  row,
  staged,
  expanded,
  disabled,
  nameOf,
  onToggle,
  onStage,
  onUnstage,
}: {
  row: SandboxRow;
  staged: Staged;
  expanded: boolean;
  disabled: boolean;
  nameOf(hash: number): string;
  onToggle(): void;
  onStage(hash: string, pick: SandboxPick | null): void;
  onUnstage(hash: string): void;
}) {
  const isStaged = Object.hasOwn(staged, row.hash);
  const pick = effectivePick(row, staged);
  // First line: what the row resolves to (the name matters most); second: where that comes from.
  const target = (value: SandboxPick) => ('to' in value ? `→ ${nameOf(value.to)}` : 'No tooltip');
  const decision = isStaged
    ? staged[row.hash]
      ? target(staged[row.hash]!)
      : 'Pick undone'
    : row.saved
      ? target(row.saved)
      : row.suggestion
        ? target(row.suggestion)
        : 'Choose a tooltip';
  const source = isStaged
    ? 'Staged'
    : row.saved
      ? 'Saved'
      : `${row.suggestion ? 'Suggested · ' : ''}${bucketLabels[row.bucket]}`;
  const more = row.candidates.length - shownCandidates;
  const name = row.name || '(no Bungie name)';
  const choiceName = `pick-${row.hash}`;
  return (
    <div className={styles.row} data-state={isStaged ? 'staged' : row.saved ? 'decided' : 'open'}>
      <div className={styles.effect} title={row.firstLine || undefined}>
        <span className={styles.line}>
          <strong>{name}</strong> <span className={styles.meta}>{row.hash}</span>
        </span>
        <span className={`${styles.line} ${styles.meta}`}>
          {row.firstLine || 'No Bungie description'}
        </span>
      </div>
      <div className={styles.shared}>
        <span className={styles.line}>
          {row.candidates.slice(0, shownCandidates).map((candidate, index) => (
            <span key={candidate.hash}>
              {index > 0 && ' · '}
              <Link to={`/t/${candidate.hash}`}>{candidate.name}</Link>
            </span>
          ))}
          {more > 0 && <span className={styles.meta}> +{more} more</span>}
        </span>
        <span className={`${styles.line} ${styles.meta}`}>
          {row.candidates.length} tooltips · {kindLabels[row.kind]}
        </span>
      </div>
      <div className={styles.decision}>
        <span className={styles.line} title={decision}>
          {decision}
        </span>
        <span className={`${styles.line} ${styles.meta}`}>
          {source}
          {!isStaged && row.retired ? (
            <span className={styles.flag}> · No longer shared</span>
          ) : !isStaged && row.changed ? (
            <span
              className={styles.flag}
              title="The items sharing this effect changed after the pick; the pick still applies."
            >
              {' '}
              · Changed
            </span>
          ) : null}
        </span>
      </div>
      <div className={styles.actions}>
        {pick || isStaged ? (
          <button
            type="button"
            disabled={disabled}
            onClick={() => (isStaged ? onUnstage(row.hash) : onStage(row.hash, null))}
          >
            Undo
          </button>
        ) : (
          <button
            type="button"
            disabled={disabled || !row.suggestion}
            onClick={() => row.suggestion && onStage(row.hash, row.suggestion)}
          >
            Apply
          </button>
        )}
        <button type="button" aria-expanded={expanded} disabled={disabled} onClick={onToggle}>
          Choose
        </button>
      </div>
      {expanded && (
        <fieldset className={styles.choices}>
          <legend className={styles.hidden}>Pick for {name}</legend>
          {row.candidates.map((candidate) => (
            <label key={candidate.hash} className={styles.choice}>
              <input
                type="radio"
                name={choiceName}
                disabled={disabled || !candidate.hasText}
                checked={!!pick && 'to' in pick && pick.to === candidate.hash}
                onChange={() => onStage(row.hash, { to: candidate.hash })}
              />
              <span className={styles.line}>
                <strong>{candidate.name}</strong>{' '}
                <span className={styles.meta}>
                  {categoryDisplay(candidate.categoryId).label} · {candidate.hash}
                  {candidate.hasText ? ` · ${candidate.firstLine}` : ' · no text'}
                </span>
              </span>
            </label>
          ))}
          <label className={styles.choice}>
            <input
              type="radio"
              name={choiceName}
              disabled={disabled}
              checked={!!pick && !('to' in pick)}
              onChange={() => onStage(row.hash, { none: true })}
            />
            <span className={styles.line}>
              <strong>No tooltip</strong>{' '}
              <span className={styles.meta}>apps show Bungie’s text</span>
            </span>
          </label>
        </fieldset>
      )}
    </div>
  );
}
