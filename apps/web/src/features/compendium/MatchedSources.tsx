import { useEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import type { CompendiumMatch } from '@clarity/core';
import { Link, useSearchParams } from 'react-router-dom';
import { useDataStore, type EditorData } from '../../stores/data';
import { useDraftStore } from '../../stores/drafts';
import { useAuthStore } from '../../stores/auth';
import { itemFor } from '../navigation/catalog';
import { useCompendiumStore } from './store';
import { useDisplayMatches } from './useDisplayMatches';
import styles from './Compendium.module.scss';

type SourceRow = {
  hash: number;
  match: CompendiumMatch;
  item: ReturnType<typeof itemFor>;
  search: string;
  heightKey: string;
};
const sourceRows = new WeakMap<
  EditorData,
  WeakMap<ReadonlyMap<number, CompendiumMatch>, SourceRow[]>
>();
const noRows: SourceRow[] = [];

/** Immutable match revisions share their sorted catalog projection across mounts. */
export function matchedSourceRows(
  editor: EditorData,
  matches: ReadonlyMap<number, CompendiumMatch>,
) {
  let revisions = sourceRows.get(editor);
  if (!revisions) sourceRows.set(editor, (revisions = new WeakMap()));
  const previous = revisions.get(matches);
  if (previous) return previous;
  const rows = [...matches]
    .map(([hash, match]) => {
      const item = itemFor(hash, editor);
      return {
        hash,
        match,
        item,
        search: `${item?.name ?? ''} ${hash} ${match.row.name}`.toLowerCase(),
        heightKey: JSON.stringify([hash, item?.name, match.tab.name, match.row.name]),
      };
    })
    .sort((a, b) => (a.item?.name ?? '').localeCompare(b.item?.name ?? ''));
  revisions.set(matches, rows);
  return rows;
}

/** Keep natural wrapping and native scroll anchoring, while mounting nearby rows only. */
export function MatchedSourceList({ rows }: { rows: SourceRow[] }) {
  const list = useRef<HTMLUListElement>(null);
  const heights = useRef(new Map<string, number>());
  const nodes = useRef(new Map<string, HTMLLIElement>());
  const nodeKeys = useRef(new WeakMap<Element, string>());
  const refs = useRef(new Map<string, (node: HTMLLIElement | null) => void>());
  const observer = useRef<ResizeObserver>();
  const width = useRef(0);
  const [, refreshHeights] = useState(0);
  const [viewport, setViewport] = useState({ top: 0, height: 384 });
  const [focused, setFocused] = useState<number>();
  const [forced, setForced] = useState<number>();

  useEffect(() => {
    if (typeof ResizeObserver === 'undefined') return;
    const current = new ResizeObserver((entries) => {
      let changed = false;
      for (const entry of entries) {
        if (entry.target === list.current) {
          if (width.current && Math.abs(width.current - entry.contentRect.width) > 1) {
            heights.current.clear();
            changed = true;
          }
          width.current = entry.contentRect.width;
          const height = entry.contentRect.height;
          if (height > 0)
            setViewport((previous) =>
              Math.abs(previous.height - height) > 1 ? { ...previous, height } : previous,
            );
        } else {
          const key = nodeKeys.current.get(entry.target);
          const height =
            entry.borderBoxSize?.[0]?.blockSize ?? entry.target.getBoundingClientRect().height;
          if (key && height > 0 && Math.abs((heights.current.get(key) ?? 0) - height) > 0.5) {
            heights.current.set(key, height);
            changed = true;
          }
        }
      }
      if (changed) refreshHeights((value) => value + 1);
    });
    observer.current = current;
    if (list.current) current.observe(list.current);
    for (const node of nodes.current.values()) current.observe(node);
    return () => current.disconnect();
  }, []);

  function rowRef(key: string) {
    let ref = refs.current.get(key);
    if (!ref) {
      ref = (node) => {
        const previous = nodes.current.get(key);
        if (previous) observer.current?.unobserve(previous);
        if (node) {
          nodes.current.set(key, node);
          nodeKeys.current.set(node, key);
          observer.current?.observe(node);
        } else nodes.current.delete(key);
      };
      refs.current.set(key, ref);
    }
    return ref;
  }

  const offsets = [0];
  for (const row of rows)
    offsets.push(offsets[offsets.length - 1] + (heights.current.get(row.heightKey) ?? 56));
  const total = offsets[offsets.length - 1];
  const top = Math.min(viewport.top, Math.max(0, total - viewport.height));
  const first = Math.max(0, offsets.findIndex((offset) => offset > top - viewport.height) - 1);
  const after = offsets.findIndex((offset) => offset >= top + viewport.height * 2);
  const end = after < 0 ? rows.length : Math.min(rows.length, after + 1);
  const indices = new Set(Array.from({ length: Math.max(0, end - first) }, (_, i) => first + i));
  const byHash = new Map(rows.map((row, index) => [row.hash, index]));
  for (const hash of [focused, forced]) {
    const index = hash === undefined ? undefined : byHash.get(hash);
    if (index !== undefined) indices.add(index);
  }
  const visible = [...indices].sort((a, b) => a - b);
  const children = [];
  let previousEnd = 0;
  for (const index of visible) {
    const row = rows[index];
    if (offsets[index] > previousEnd)
      children.push(
        <li
          key={`gap-${row.hash}`}
          className={styles.matchedSpacer}
          role="presentation"
          aria-hidden="true"
          style={{ height: offsets[index] - previousEnd }}
        />,
      );
    children.push(
      <li
        key={row.hash}
        ref={rowRef(row.heightKey)}
        data-matched-hash={row.hash}
        aria-posinset={index + 1}
        aria-setsize={rows.length}
      >
        <Link to={`/t/${row.hash}`}>{row.item?.name ?? row.hash}</Link>{' '}
        <span className={styles.matched}>Matched</span>{' '}
        <small>
          {row.match.tab.name} / {row.match.row.name}
        </small>
      </li>,
    );
    previousEnd = offsets[index + 1];
  }
  if (total > previousEnd)
    children.push(
      <li
        key="gap-end"
        className={styles.matchedSpacer}
        role="presentation"
        aria-hidden="true"
        style={{ height: total - previousEnd }}
      />,
    );
  return (
    <ul
      ref={list}
      className={`${styles.rows} ${styles.matchedRows}`}
      onScroll={(event) => {
        const top = event.currentTarget.scrollTop;
        // Commit a jumped-to viewport before the next paint, including thumb drags.
        flushSync(() => setViewport((previous) => ({ ...previous, top })));
      }}
      onFocusCapture={(event) => {
        const row = event.target.closest<HTMLElement>('[data-matched-hash]');
        if (row) setFocused(Number(row.dataset.matchedHash));
        setForced(undefined);
      }}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setFocused(undefined);
      }}
      onKeyDownCapture={(event) => {
        if (event.key !== 'Tab' || event.altKey || event.ctrlKey || event.metaKey) return;
        const row = (event.target as Element).closest<HTMLElement>('[data-matched-hash]');
        const index = row && byHash.get(Number(row.dataset.matchedHash));
        if (index === undefined || index === null) return;
        const next = index + (event.shiftKey ? -1 : 1);
        if (rows[next] && !indices.has(next))
          // Native Tab still selects the next link; make that link exist first.
          flushSync(() => setForced(rows[next].hash));
      }}
    >
      {children}
    </ul>
  );
}

export function MatchedSources({ preparedRows }: { preparedRows?: SourceRow[] } = {}) {
  const editor = useDataStore((s) => s.data);
  const drafts = useDraftStore((s) => s.drafts);
  const userId = useAuthStore((s) => s.user?.id);
  const { data: source, load, loading, error } = useCompendiumStore();
  const result = useDisplayMatches(editor, source, drafts, userId);
  const [params, setParams] = useSearchParams();
  const query = params.get('matchedQuery') ?? '';
  const category = params.get('matchedCategory') ?? '';
  const [limit, setLimit] = useState(100);
  useEffect(() => {
    void load();
  }, [load]);
  const rows = useMemo(
    () =>
      preparedRows ??
      (editor && result.matches ? matchedSourceRows(editor, result.matches) : noRows),
    [preparedRows, editor, result.matches],
  );
  const search = query.trim().toLowerCase();
  const filtered = useMemo(
    () =>
      rows.filter(
        ({ item, search: text }) =>
          (!category || item?.categoryId === category) && (!search || text.includes(search)),
      ),
    [rows, category, search],
  );
  const shown = useMemo(() => filtered.slice(0, limit), [filtered, limit]);
  const filter = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setLimit(100);
    setParams(next, { replace: true });
  };
  return (
    <section aria-label="Matched Compendium sources">
      <p>Matched sources ({rows.length}). Saved and draft links take precedence in the editor.</p>
      {(loading || result.loading) && <p role="status">Matching Compendium…</p>}
      {(error || result.error) && <p role="alert">{error || result.error}</p>}
      <label>
        Search tooltips{' '}
        <input value={query} onChange={(e) => filter('matchedQuery', e.target.value)} />
      </label>{' '}
      <label>
        Category{' '}
        <select value={category} onChange={(e) => filter('matchedCategory', e.target.value)}>
          <option value="">All categories</option>
          {editor?.categories.map((entry) => (
            <option key={entry.id} value={entry.id}>
              {entry.label}
            </option>
          ))}
        </select>
      </label>
      <MatchedSourceList rows={shown} />
      {filtered.length > limit && (
        <button type="button" onClick={() => setLimit(limit + 100)}>
          Show 100 more
        </button>
      )}
      {!result.loading && !result.error && !filtered.length && (
        <p>No matched sources match these filters.</p>
      )}
    </section>
  );
}
