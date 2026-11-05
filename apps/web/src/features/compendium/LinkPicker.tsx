import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  compendiumNameVariants,
  compendiumPreferredTabs,
  normaliseCompendiumName,
  type CompendiumMatch,
  type Tooltip,
} from '@clarity/core';
import { useDraftStore } from '../../stores/drafts';
import { errorMessage } from '../../services/http';
import { useCompendiumStore } from './store';
import { When } from '../../ui/When';
import styles from './Compendium.module.scss';
import gridStyles from './PickerGrid.module.scss';
import { CellPicker } from './CellPicker';
import { PickerRowList } from './PickerRowList';
import { confirmCompendiumSelection } from './selection';
import { categorySuggestions, suggestionAnchor, type CompendiumSuggestion } from './suggestions';
import { mayDraftLink } from './reviewQueue';
import { useAuthStore } from '../../stores/auth';
import { useSaveState } from '../../services/save/state';
import { apiUrl } from '../../services/api';
import { pickerRowDetail, pickerRows } from './pickerRows';

export function LinkPicker({
  base,
  name,
  category,
  onLinked,
  onBeforeLinked,
  readOnly = false,
  suggestions,
  onReference,
  retainPrevious = false,
}: LinkPickerProps) {
  const [started, setStarted] = useState(false);
  useLayoutEffect(() => {
    if (!retainPrevious) return;
    const channel = new MessageChannel();
    channel.port1.onmessage = () => setStarted(true);
    channel.port2.postMessage(null);
    return () => {
      channel.port1.close();
      channel.port2.close();
    };
  }, [retainPrevious]);
  return !retainPrevious || started ? (
    <PreparedLinkPicker
      {...{
        base,
        name,
        category,
        onLinked,
        onBeforeLinked,
        readOnly,
        suggestions,
        onReference,
        retainPrevious,
      }}
    />
  ) : (
    <section className={`${gridStyles.picker} ${gridStyles.pendingOpen}`} aria-hidden="true" />
  );
}

type LinkPickerProps = {
  base: Tooltip;
  name: string;
  category: string;
  onLinked(): void;
  onBeforeLinked?(link: NonNullable<Tooltip['compendium']>): void;
  readOnly?: boolean;
  suggestions?: CompendiumSuggestion[];
  onReference?(match: CompendiumMatch): void;
  /** Keep the caller's live previous surface visible while first-pane bands prepare. */
  retainPrevious?: boolean;
};

function PreparedLinkPicker({
  base,
  name,
  category,
  onLinked,
  onBeforeLinked,
  readOnly = false,
  suggestions,
  onReference,
  retainPrevious = false,
}: LinkPickerProps) {
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
    const names = compendiumNameVariants(category, name).map(normaliseCompendiumName);
    const preferred = compendiumPreferredTabs(category, name);
    const suggested = [...data.tabs]
      .sort((a, b) => {
        const position = (gid: string) =>
          preferred.includes(gid) ? preferred.indexOf(gid) : preferred.length;
        return position(a.gid) - position(b.gid);
      })
      .find((tab) =>
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
        (initialSection
          ? initialTab?.rows.find((row) => row.section === initialSection)
          : undefined),
      error: storageError,
    };
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
  const [shownCellKey, setShownCellKey] = useState<string>();
  const readySheets = useRef(new Set<string>());
  const [readyInitial, setReadyInitial] = useState(initial);
  const sheetInitial = useRef(initial);
  if (sheetInitial.current !== initial) {
    sheetInitial.current = initial;
    readySheets.current.clear();
  }
  const openReady = !retainPrevious || (readyInitial === initial && !!shownCellKey);
  const currentReady = openReady && (!retainPrevious || cellKey === shownCellKey);
  const currentCellKey = useRef(cellKey);
  currentCellKey.current = cellKey;
  useEffect(() => {
    if (!gid || readySheets.current.has(cellKey)) {
      setShownCellKey(cellKey);
      setReadyInitial(initial);
    }
  }, [cellKey, gid, initial]);
  const sheets =
    visited[cellKey] || !gid ? visited : { ...visited, [cellKey]: { gid, row: anchorRow } };
  useEffect(() => {
    if (gid)
      setVisited((old) => (old[cellKey] ? old : { ...old, [cellKey]: { gid, row: anchorRow } }));
  }, [gid, anchorRow, cellKey]);
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
      className={`${gridStyles.picker}${openReady ? '' : ` ${gridStyles.pendingOpen}`}`}
      aria-label="Link a Compendium row"
      aria-busy={!currentReady}
      data-picker-ready={currentReady}
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
                {data.tabs.find((entry) => entry.gid === hint.gid)?.name ?? hint.gid}{' '}
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
      <PickerRowList
        rows={rows}
        exact={exact}
        disabled={!canEdit}
        onChoose={(row) => {
          if (tab) choose({ tab, row });
        }}
        onAnchor={setAnchorRow}
      />
      {Object.entries(sheets).map(([key, saved]) => {
        const savedTab = data.tabs.find((entry) => entry.gid === saved.gid);
        return (
          savedTab && (
            <div
              key={key}
              data-picker-sheet-state={
                key === (retainPrevious ? shownCellKey : cellKey)
                  ? 'active'
                  : key === cellKey
                    ? 'preparing'
                    : 'inactive'
              }
              hidden={key !== cellKey && (!retainPrevious || key !== shownCellKey)}
              className={
                retainPrevious &&
                openReady &&
                shownCellKey &&
                key === cellKey &&
                key !== shownCellKey
                  ? gridStyles.preparingSheet
                  : undefined
              }
            >
              <CellPicker
                tab={savedTab}
                data={data}
                initial={saved.row}
                onChoose={chooseLatest}
                readOnly={!canEdit}
                referenceOnly={!!onReference}
                onReady={
                  retainPrevious
                    ? () => {
                        readySheets.current.add(key);
                        if (currentCellKey.current === key) {
                          setShownCellKey(key);
                          setReadyInitial(initial);
                        }
                      }
                    : undefined
                }
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
