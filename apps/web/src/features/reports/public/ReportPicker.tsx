import { languages } from '../../../../../../packages/core/src/languages';
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { languageLabel } from '../../../languageLabels';
import { categorySpecs } from '../../../services/categoryLabels';
import type { ReportCatalog } from '../../../services/reports';
import { browserLang, recentItems } from './draft';
import { iconUrl } from './ItemIdentity';
import { reportCatalog } from './tooltipRender';
import styles from './ReportPage.module.scss';

interface Entry {
  hash: number;
  name: string;
  category: string;
  icon: string;
  key: string;
}

const fold = (value: string) => value.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
const countFormat = new Intl.NumberFormat('en');

/** One row per item a consumer can show: aliases with the same name and owner collapse. */
export function pickerEntries(catalog: ReportCatalog): Entry[] {
  const seen = new Map<string, Entry>();
  for (const [key, item] of Object.entries(catalog.items)) {
    const hash = Number(key);
    if (hash <= 3 || !item.name.trim()) continue;
    const category = categorySpecs[item.category]?.label ?? item.type;
    const id = `${item.owner}|${item.variant}|${item.name}|${category}`;
    const current = seen.get(id);
    if (current && current.hash === item.owner) continue;
    seen.set(id, { hash, name: item.name, category, icon: item.icon, key: fold(item.name) });
  }
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Name prefix first, then a word prefix, then anywhere in the name. */
export function searchEntries(entries: Entry[], query: string, limit = 50): Entry[] {
  const q = fold(query.trim());
  if (!q) return [];
  const ranked: [number, Entry][] = [];
  for (const entry of entries) {
    const at = entry.key.indexOf(q);
    if (at < 0) continue;
    const rank = at === 0 ? 0 : /[\s'(-]/.test(entry.key[at - 1]) ? 1 : 2;
    ranked.push([rank, entry]);
  }
  return ranked
    .sort((a, b) => a[0] - b[0] || a[1].name.localeCompare(b[1].name))
    .slice(0, limit)
    .map(([, entry]) => entry);
}

/** #/report: find the item by the name the consumer app shows, then open its form. */
export function ReportPicker() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const query = params.get('q') ?? '';
  const lang = params.get('lang') ?? browserLang();
  const [catalog, setCatalog] = useState<ReportCatalog | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const listId = useId();
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let live = true;
    reportCatalog().then(
      (value) => live && setCatalog(value),
      (error: unknown) => live && setFailed(error instanceof Error ? error.message : String(error)),
    );
    return () => {
      live = false;
    };
  }, []);

  const entries = useMemo(() => (catalog ? pickerEntries(catalog) : []), [catalog]);
  const results = useMemo(() => searchEntries(entries, query), [entries, query]);
  const recent = useMemo(() => {
    const byHash = new Map(entries.map((entry) => [entry.hash, entry]));
    return recentItems()
      .map((hash) => byHash.get(hash))
      .filter((entry): entry is Entry => entry !== undefined);
  }, [entries]);
  useEffect(() => setActive(0), [query]);

  const target = (hash: number) => `/report/${hash}?lang=${encodeURIComponent(lang)}`;
  const update = (key: string, value: string) =>
    setParams(
      (current) => {
        const next = new URLSearchParams(current);
        if (value) next.set(key, value);
        else next.delete(key);
        return next;
      },
      { replace: true },
    );

  const keyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (!results.length) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const next = Math.min(
        results.length - 1,
        Math.max(0, active + (event.key === 'ArrowDown' ? 1 : -1)),
      );
      setActive(next);
      document.getElementById(`${listId}-${next}`)?.scrollIntoView({ block: 'nearest' });
    } else if (event.key === 'Enter') {
      event.preventDefault();
      navigate(target(results[active].hash));
    }
  };

  return (
    <div className={`${styles.page} ${styles.picker}`}>
      <label htmlFor={`${listId}-search`} className={styles.label}>
        Search the perk, fragment, or mod name as your app shows it
      </label>
      <input
        ref={input}
        id={`${listId}-search`}
        className={`${styles.input} ${styles.search}`}
        type="search"
        role="combobox"
        aria-expanded={results.length > 0}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={results.length ? `${listId}-${active}` : undefined}
        autoComplete="off"
        autoFocus={!('ontouchstart' in window)}
        value={query}
        onChange={(event) => update('q', event.target.value)}
        onKeyDown={keyDown}
      />
      <div className={styles.pickerMeta}>
        <label className={styles.inline}>
          <span className={styles.label}>Language</span>
          <select
            className={styles.select}
            value={lang}
            onChange={(event) => update('lang', event.target.value)}
          >
            {languages.map((code) => (
              <option key={code} value={code}>
                {languageLabel(code)}
              </option>
            ))}
          </select>
        </label>
        <span className={styles.muted}>
          {catalog
            ? `Only items with a Clarity tooltip (${countFormat.format(entries.length)})`
            : failed
              ? ''
              : 'Loading items…'}
        </span>
      </div>
      {failed && (
        <p role="alert" className={styles.notice}>
          The item list could not load: {failed}
        </p>
      )}
      {results.length > 0 && (
        <ul id={listId} role="listbox" aria-label="Items" className={styles.results}>
          {results.map((entry, index) => (
            <li
              key={entry.hash}
              id={`${listId}-${index}`}
              role="option"
              aria-selected={index === active}
              className={styles.result}
              onMouseMove={() => setActive(index)}
              onClick={() => navigate(target(entry.hash))}
            >
              {iconUrl(entry.icon) ? (
                <img
                  className={styles.resultIcon}
                  src={iconUrl(entry.icon)}
                  alt=""
                  loading="lazy"
                />
              ) : (
                <span className={styles.resultIcon} aria-hidden="true" />
              )}
              <span className={styles.resultName}>{entry.name}</span>
              <span className={styles.resultCategory}>{entry.category}</span>
            </li>
          ))}
        </ul>
      )}
      {catalog && query.trim() && !results.length && (
        <p className={styles.muted} role="status">
          No item with a Clarity tooltip matches “{query.trim()}”.
        </p>
      )}
      {recent.length > 0 && (
        <p className={styles.recent}>
          Recent:{' '}
          {recent.map((entry, index) => (
            <span key={entry.hash}>
              {index > 0 && ' · '}
              <Link to={target(entry.hash)}>{entry.name}</Link>
            </span>
          ))}
        </p>
      )}
    </div>
  );
}
