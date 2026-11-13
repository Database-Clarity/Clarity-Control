import { startTransition, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  compendiumNameVariants,
  compendiumPreferredTabs,
  normaliseCompendiumName,
  type CompendiumData,
  type CompendiumMatch,
  type Tooltip,
} from '@clarity/core';
import { useDraftStore } from '../../stores/drafts';
import { errorMessage } from '../../services/http';
import { useCompendiumStore } from './store';
import { When } from '../../ui/When';
import { SourceRef } from './SourceRef';
import { matchLocation, sectionLabel } from './sourceLocation';
import styles from './Compendium.module.scss';
import { CellPicker } from './CellPicker';
import { confirmCompendiumSelection } from './selection';
import { categorySuggestions, suggestionAnchor, type CompendiumSuggestion } from './suggestions';
import { mayDraftLink } from './reviewQueue';
import { useAuthStore } from '../../stores/auth';
import { useSaveState } from '../../services/save/state';
import { apiUrl } from '../../services/api';
import { pickerRowDetail, pickerRows } from './pickerRows';

/** Tabs in the order the picker searches them for the item's own name: preferred tabs first. */
function searchOrder(data: CompendiumData, category: string, name: string) {
  const preferred = compendiumPreferredTabs(category, name);
  const position = (gid: string) =>
    preferred.includes(gid) ? preferred.indexOf(gid) : preferred.length;
  return [...data.tabs].sort((a, b) => position(a.gid) - position(b.gid));
}

/** The tab, section, query, and anchor a new picker opens on. */
function pickerStart(
  data: CompendiumData,
  category: string,
  name: string,
  remembered: string | null,
) {
  const names = compendiumNameVariants(category, name).map(normaliseCompendiumName);
  const preferred = compendiumPreferredTabs(category, name);
  const suggested = searchOrder(data, category, name).find((tab) =>
    tab.rows.some((row) =>
      pickerRowDetail(row).identifiers.some((identifier) => names.includes(identifier)),
    ),
  );
  const initialGid =
    data.tabs.find((tab) => tab.gid === remembered)?.gid ??
    suggested?.gid ??
    data.tabs.find((tab) => preferred.includes(tab.gid))?.gid ??
    data.tabs.find((tab) => tab.rows.length || tab.grid?.length)?.gid ??
    '';
  const initialTab = data.tabs.find((tab) => tab.gid === initialGid);
  const initialSection = categorySuggestions(data, category, name).find(
    (hint) => hint.gid === initialGid,
  )?.section;
  const exactRow = initialTab?.rows.find((row) => names.includes(pickerRowDetail(row).name));
  return {
    gid: initialGid,
    section: exactRow ? '' : (initialSection ?? ''),
    query: exactRow ? name : '',
    row:
      exactRow ??
      (initialSection ? initialTab?.rows.find((row) => row.section === initialSection) : undefined),
  };
}

/**
 * The opening lookups, one row per step: each scanned row's names (cached per row, in the
 * order pickerStart scans them), then the search text of the tab the picker opens on.
 */
function* pickerLookups(category: string, name: string) {
  const data = useCompendiumStore.getState().data;
  if (!data) return;
  const names = compendiumNameVariants(category, name).map(normaliseCompendiumName);
  scan: for (const tab of searchOrder(data, category, name))
    for (const row of tab.rows) {
      if (pickerRowDetail(row).identifiers.some((identifier) => names.includes(identifier)))
        break scan;
      yield;
    }
  let remembered: string | null = null;
  try {
    remembered = localStorage.getItem(`clarity-compendium-tab:${category}`);
  } catch {
    // The picker reports an unreadable preference itself.
  }
  const start = pickerStart(data, category, name, remembered);
  const tab = data.tabs.find((entry) => entry.gid === start.gid);
  for (const row of tab?.rows ?? []) {
    void pickerRowDetail(row).search;
    void pickerRowDetail(row).name;
    yield;
  }
  pickerRows(tab, category, start.query, start.section);
}

/**
 * Opens a picker after the input: its lookups run in tasks of about 12 ms, then the picker
 * renders. The current pane stays until the picker commits. Returns a cancel function.
 */
export function openLinkPickerSoon(category: string, name: string, open: () => void) {
  const channel = new MessageChannel();
  const steps = pickerLookups(category, name);
  const close = () => {
    channel.port1.close();
    channel.port2.close();
  };
  channel.port1.onmessage = () => {
    const until = performance.now() + 12;
    for (let step = 1; ; step++) {
      if (steps.next().done) {
        close();
        open();
        return;
      }
      if (step % 32 === 0 && performance.now() >= until) break;
    }
    channel.port2.postMessage(null);
  };
  channel.port2.postMessage(null);
  return close;
}

const firstRows = 12;

export function LinkPicker({
  base,
  name,
  category,
  onLinked,
  onBeforeLinked,
  readOnly = false,
  suggestions,
  onReference,
}: {
  base: Tooltip;
  name: string;
  category: string;
  onLinked(): void;
  onBeforeLinked?(link: NonNullable<Tooltip['compendium']>): void;
  readOnly?: boolean;
  suggestions?: CompendiumSuggestion[];
  onReference?(match: CompendiumMatch): void;
}) {
  const data = useCompendiumStore((state) => state.data);
  const user = useAuthStore((state) => state.user);
  const hydrated = useDraftStore((state) => state.hydrated);
  const locked = useSaveState((state) => state.locked);
  const canEdit =
    !readOnly && (!!onReference || mayDraftLink(user?.role, !!apiUrl, hydrated, locked));
  const preferenceKey = `clarity-compendium-tab:${category}`;
  const initial = useMemo(() => {
    if (!data) return { gid: '', section: '', query: name, row: undefined, error: null };
    let remembered: string | null = null;
    let storageError: string | null = null;
    try {
      remembered = localStorage.getItem(preferenceKey);
    } catch (error) {
      storageError = `Cannot read remembered tab: ${errorMessage(error)}`;
    }
    return { ...pickerStart(data, category, name, remembered), error: storageError };
  }, [data, name, category, preferenceKey]);
  const [initialized, setInitialized] = useState(initial);
  const [section, setSection] = useState(initial.section);
  const updateDraft = useDraftStore((state) => state.updateDraft);
  const [anchorRow, setAnchorRow] = useState<CompendiumMatch['row'] | undefined>(initial.row);
  const [gid, setGid] = useState(initial.gid);
  const [query, setQuery] = useState(initial.query);
  const [error, setError] = useState<string | null>(initial.error);
  if (initialized !== initial) {
    // Reconcile a reopened picker before committing any stale entry or empty sheet.
    setInitialized(initial);
    setGid(initial.gid);
    setSection(initial.section);
    setAnchorRow(initial.row);
    setQuery(initial.query);
    setError(initial.error);
  }
  const [visited, setVisited] = useState<
    Record<string, { gid: string; row?: CompendiumMatch['row'] }>
  >({});
  const cellKey = `${gid}:${anchorRow?.rowIndex}:${anchorRow?.anchor?.col}`;
  // The sheet for a new anchor mounts in its own (interruptible) render after the input
  // task has committed and painted the controls, never inside the click or keypress.
  const [shown, setShown] = useState<{ key: string; gid: string; row?: CompendiumMatch['row'] }>();
  const pending = !!gid && shown?.key !== cellKey;
  useEffect(() => {
    if (!pending) return;
    const target = { key: cellKey, gid, row: anchorRow };
    const channel = new MessageChannel();
    channel.port1.onmessage = () => startTransition(() => setShown(target));
    channel.port2.postMessage(null);
    return () => {
      channel.port1.close();
      channel.port2.close();
    };
  }, [pending, cellKey, gid, anchorRow]);
  const sheets = !shown || visited[shown.key] ? visited : { ...visited, [shown.key]: shown };
  useEffect(() => {
    if (shown)
      setVisited((old) =>
        old[shown.key] ? old : { ...old, [shown.key]: { gid: shown.gid, row: shown.row } },
      );
  }, [shown]);
  const { rows, exact } = useMemo(
    () =>
      pickerRows(
        data?.tabs.find((tab) => tab.gid === gid),
        category,
        query,
        section,
      ),
    [data, gid, category, query, section],
  );
  // At most 100 rows. The input task renders the first 12 (the list shows at most about 11:
  // 24rem at 2.25rem or more per row), the rest follow 22 per task, so neither the opening
  // click nor a tab change carries every row's render, layout, and paint at once. A pending
  // sheet commits first: the rows below the first chunk wait for it.
  const shownTarget = Math.min(100, rows.length);
  const [rowChunk, setRowChunk] = useState({ rows, count: firstRows });
  if (rowChunk.rows !== rows) setRowChunk({ rows, count: firstRows });
  const shownCount = rowChunk.rows === rows ? rowChunk.count : firstRows;
  const rowsPending = shownCount < shownTarget;
  useEffect(() => {
    if (!rowsPending || pending) return;
    const channel = new MessageChannel();
    channel.port1.onmessage = () => setRowChunk({ rows, count: shownCount + 22 });
    channel.port2.postMessage(null);
    return () => {
      channel.port1.close();
      channel.port2.close();
    };
  }, [rows, shownCount, rowsPending, pending]);
  function choose(match: CompendiumMatch) {
    if (!canEdit) return;
    const link = data && confirmCompendiumSelection(match, data);
    if (!link) {
      setError('This selection cannot be resolved uniquely. Choose a nearby unique name anchor.');
      return;
    }
    if (onReference) onReference(match);
    else {
      onBeforeLinked?.(link);
      updateDraft(base, (tooltip) => ({
        ...tooltip,
        compendium: link,
      }));
    }
    try {
      localStorage.setItem(preferenceKey, match.tab.gid);
    } catch (error) {
      setError(`Selection recorded, but cannot remember tab: ${errorMessage(error)}`);
    }
    onLinked();
  }
  const chooseCurrent = useRef(choose);
  chooseCurrent.current = choose;
  const chooseLatest = useCallback((match: CompendiumMatch) => chooseCurrent.current(match), []);
  if (!data) return null;
  const tab = data.tabs.find((tab) => tab.gid === gid);
  return (
    <section
      className={styles.linkPicker}
      aria-label="Link a Compendium row"
      aria-busy={pending || rowsPending}
      data-sheet-pending={pending}
    >
      <h3>Choose tab and row</h3>
      <label>
        Compendium tab{' '}
        <select
          value={gid}
          onChange={(event) => {
            setGid(event.target.value);
            setSection('');
            setQuery('');
            setAnchorRow(undefined);
          }}
        >
          {data.tabs
            .filter((tab) => tab.rows.length || tab.grid?.length)
            .map((tab) => (
              <option key={tab.gid} value={tab.gid}>
                {tab.name}
              </option>
            ))}
        </select>
      </label>
      <label>
        Section{' '}
        <select
          value={section}
          onChange={(event) => {
            setSection(event.target.value);
            setQuery('');
            setAnchorRow(tab?.rows.find((row) => row.section === event.target.value));
          }}
        >
          <option value="">All sections in this tab</option>
          {[...new Set(tab?.rows.map((row) => row.section).filter(Boolean))].map((label) => (
            <option key={label} value={label}>
              {label}
            </option>
          ))}
        </select>
      </label>
      <label>
        Find row by name / section{' '}
        <input value={query} onChange={(event) => setQuery(event.target.value)} />
      </label>
      <details>
        <summary>Why these locations? / source details</summary>
        <p>Suggested places to look (not confirmed matches):</p>
        {!(suggestions ?? categorySuggestions(data, category, name)).length && (
          <p>No category-based location is established. Search any tab below.</p>
        )}
        <ul className={styles.rows}>
          {(suggestions ?? categorySuggestions(data, category, name)).map((hint, index) => (
            <li key={index}>
              <button
                type="button"
                onClick={() => {
                  const target = data.tabs.find((entry) => entry.gid === hint.gid);
                  if (!target) return;
                  setGid(hint.gid);
                  setSection(hint.section ?? '');
                  setQuery('');
                  setAnchorRow(suggestionAnchor(target, hint));
                }}
              >
                {data.tabs.find((entry) => entry.gid === hint.gid)?.name ?? 'Removed sheet tab'}{' '}
                {hint.section && `/ ${hint.section}`}
              </button>
              <p>{hint.rationale}</p>
            </li>
          ))}
        </ul>
        <p>
          All tabs remain available. Search parsed names/sections below, or all grid text in the
          cell picker.
        </p>
        <p>
          Source fetched: <When value={data.fetchedAt} />
        </p>
      </details>
      <p>
        Exact name matches appear first.{' '}
        {onReference
          ? 'Choosing a source records a local reference only; no tooltip draft or save.'
          : 'Linking creates a local draft; save it normally.'}
      </p>
      {error && <p role="alert">{error}</p>}
      <ul className={styles.rows}>
        {tab &&
          rows.slice(0, Math.min(shownTarget, shownCount)).map((row) => (
            <li key={`${row.rowIndex}:${row.name}`}>
              <small className={styles.rowRange}>
                <SourceRef location={matchLocation({ tab, row }, data)} show="range" />
              </small>
              <button type="button" disabled={!canEdit} onClick={() => choose({ tab, row })}>
                {exact.has(row) && 'Exact match: '}
                {row.name} {row.section && ` / ${sectionLabel(row.section)}`}
              </button>
              <button type="button" onClick={() => setAnchorRow(row)}>
                Pick description cells near this name
              </button>
            </li>
          ))}
      </ul>
      {Object.entries(sheets).map(([key, saved]) => {
        const savedTab = data.tabs.find((entry) => entry.gid === saved.gid);
        return (
          savedTab && (
            <div key={key} className={styles.retainedSheet} hidden={!gid || key !== shown?.key}>
              <CellPicker
                tab={savedTab}
                data={data}
                initial={saved.row}
                onChoose={chooseLatest}
                readOnly={!canEdit}
                referenceOnly={!!onReference}
              />
            </div>
          )
        );
      })}
      {!rows.length && <p>No matching rows. Choose another tab or search.</p>}
      {rows.length > 100 && <p>Showing 100 of {rows.length}; refine the search.</p>}
    </section>
  );
}
