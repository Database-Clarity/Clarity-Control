import { useEffect, useMemo, useState } from 'react';
import {
  compendiumIdentifiers,
  compendiumNameVariants,
  compendiumPreferredTabs,
  normaliseCompendiumName,
  type CompendiumMatch,
  type Tooltip,
} from '@clarity/core';
import { useDraftStore } from '../../stores/drafts';
import { errorMessage } from '../../services/http';
import { useCompendiumStore } from './store';
import styles from './Compendium.module.scss';
import { CellPicker } from './CellPicker';
import { confirmCompendiumSelection } from './selection';
import { categorySuggestions, suggestionAnchor, type CompendiumSuggestion } from './suggestions';
import { mayDraftLink } from './reviewQueue';
import { useAuthStore } from '../../stores/auth';
import { useSaveState } from '../../services/save/state';
import { apiUrl } from '../../services/api';

export function LinkPicker({
  base,
  name,
  category,
  onLinked,
  readOnly = false,
  suggestions,
}: {
  base: Tooltip;
  name: string;
  category: string;
  onLinked(): void;
  readOnly?: boolean;
  suggestions?: CompendiumSuggestion[];
}) {
  const data = useCompendiumStore((state) => state.data);
  const user = useAuthStore((state) => state.user);
  const hydrated = useDraftStore((state) => state.hydrated);
  const locked = useSaveState((state) => state.locked);
  const canEdit = !readOnly && mayDraftLink(user?.role, !!apiUrl, hydrated, locked);
  const [section, setSection] = useState('');
  const updateDraft = useDraftStore((state) => state.updateDraft);
  const [anchorRow, setAnchorRow] = useState<CompendiumMatch['row']>();
  const [gid, setGid] = useState('');
  const [query, setQuery] = useState(name);
  const [error, setError] = useState<string | null>(null);
  const preferenceKey = `clarity-compendium-tab:${category}`;
  useEffect(() => {
    if (!data) return;
    let remembered: string | null = null;
    try {
      remembered = localStorage.getItem(preferenceKey);
    } catch (error) {
      setError(`Cannot read remembered tab: ${errorMessage(error)}`);
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
          compendiumIdentifiers(row.name).some((identifier) =>
            names.includes(normaliseCompendiumName(identifier)),
          ),
        ),
      );
    const initialGid =
      data.tabs.find((tab) => tab.gid === remembered)?.gid ??
      suggested?.gid ??
      data.tabs.find((tab) => preferred.includes(tab.gid))?.gid ??
      data.tabs.find((tab) => tab.rows.length || tab.grid?.length)?.gid ??
      '';
    setGid(initialGid);
    const initialTab = data.tabs.find((tab) => tab.gid === initialGid);
    const initialSection = categorySuggestions(data, category, name).find(
      (hint) => hint.gid === initialGid,
    )?.section;
    const exactRow = initialTab?.rows.find((row) =>
      names.includes(normaliseCompendiumName(row.name)),
    );
    setSection(exactRow ? '' : (initialSection ?? ''));
    setAnchorRow(
      exactRow ??
        (initialSection
          ? initialTab?.rows.find((row) => row.section === initialSection)
          : undefined),
    );
    if (!exactRow) setQuery('');
  }, [data, name, category, preferenceKey]);
  const rows = useMemo(() => {
    const searches = compendiumNameVariants(category, query).map(normaliseCompendiumName);
    const exact = (name: string) =>
      compendiumIdentifiers(name).some((identifier) =>
        searches.includes(normaliseCompendiumName(identifier)),
      );
    return (
      data?.tabs
        .find((tab) => tab.gid === gid)
        ?.rows.filter((row) => !section || row.section === section)
        .filter(
          (row) =>
            !query.trim() ||
            searches.some((search) =>
              normaliseCompendiumName(`${row.name} ${row.section ?? ''}`).includes(search),
            ),
        )
        .sort(
          (a, b) =>
            Number(exact(b.name)) - Number(exact(a.name)) ||
            a.name.localeCompare(b.name) ||
            a.rowIndex - b.rowIndex,
        ) ?? []
    );
  }, [data, gid, query, category, section]);
  function choose(match: CompendiumMatch) {
    if (!canEdit) return;
    const link = data && confirmCompendiumSelection(match, data);
    if (!link) {
      setError('This selection cannot be resolved uniquely. Choose a nearby unique name anchor.');
      return;
    }
    updateDraft(base, (tooltip) => ({
      ...tooltip,
      compendium: link,
    }));
    try {
      localStorage.setItem(preferenceKey, match.tab.gid);
    } catch (error) {
      setError(`Link is drafted, but cannot remember tab: ${errorMessage(error)}`);
    }
    onLinked();
  }
  if (!data) return null;
  const tab = data.tabs.find((tab) => tab.gid === gid);
  return (
    <section aria-label="Link a Compendium row">
      <h3>Choose tab and row</h3>
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
        All tabs remain available. Search parsed names/sections below, or all grid text in the cell
        picker.
      </p>
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
      <p>Exact name matches appear first. Linking creates a local draft; save it normally.</p>
      {error && <p role="alert">{error}</p>}
      <ul className={styles.rows}>
        {tab &&
          rows.slice(0, 100).map((row) => (
            <li key={`${row.rowIndex}:${row.name}`}>
              <button type="button" disabled={!canEdit} onClick={() => choose({ tab, row })}>
                {compendiumIdentifiers(row.name).some((identifier) =>
                  compendiumNameVariants(category, query)
                    .map(normaliseCompendiumName)
                    .includes(normaliseCompendiumName(identifier)),
                ) && 'Exact match: '}
                {row.name} {row.section && ` / ${row.section}`} <small>(row {row.rowIndex})</small>
              </button>
              <button type="button" onClick={() => setAnchorRow(row)}>
                Pick description cells near this name
              </button>
            </li>
          ))}
      </ul>
      {tab && (
        <CellPicker
          key={`${gid}:${anchorRow?.rowIndex}:${anchorRow?.anchor?.col}`}
          tab={tab}
          data={data}
          initial={anchorRow}
          onChoose={choose}
          readOnly={!canEdit}
        />
      )}
      {!rows.length && <p>No matching rows. Choose another tab or search.</p>}
      {rows.length > 100 && <p>Showing 100 of {rows.length}; refine the search.</p>}
    </section>
  );
}
