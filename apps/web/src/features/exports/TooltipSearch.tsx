// Tooltip search for the export preview and the partner Tooltips view: the editor finder's search
// (navigationGroups) as one combobox, plus recent picks. Typing a hash also offers that hash, so
// aliases and sandbox perks can be picked by number.
import { useDeferredValue, useId, useMemo, useState, type KeyboardEvent } from 'react';
import { useDataStore } from '../../stores/data';
import { navigationGroups } from '../navigation/catalog';
import styles from './Exports.module.scss';

export interface Pick {
  hash: string;
  name: string;
  detail?: string;
}

const limit = 40;

export function TooltipSearch({
  onPick,
  recent,
  label = 'Find a tooltip',
}: {
  onPick(pick: Pick): void;
  recent: readonly Pick[];
  label?: string;
}) {
  const data = useDataStore((state) => state.data);
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const deferred = useDeferredValue(query);
  const id = useId();
  const results = useMemo<Pick[]>(() => {
    const search = deferred.trim();
    if (!data || !search) return [];
    const found: Pick[] = [];
    if (/^\d{2,10}$/.test(search))
      found.push({
        hash: search,
        name: data.items[search]?.name ?? `Hash ${search}`,
        detail: search,
      });
    for (const group of navigationGroups(data, search))
      for (const section of group.sections)
        for (const item of section.items) {
          if (found.length >= limit) break;
          if (found.some((pick) => pick.hash === String(item.hash))) continue;
          found.push({ hash: String(item.hash), name: item.name, detail: section.label });
        }
    return found;
  }, [data, deferred]);
  const choose = (pick: Pick) => {
    onPick(pick);
    setQuery('');
    setOpen(false);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown' && results.length) {
      event.preventDefault();
      setOpen(true);
      setActive((index) => Math.min(results.length - 1, index + 1));
    } else if (event.key === 'ArrowUp' && results.length) {
      event.preventDefault();
      setActive((index) => Math.max(0, index - 1));
    } else if (event.key === 'Enter' && open && results[active]) {
      event.preventDefault();
      choose(results[active]);
    } else if (event.key === 'Escape') {
      if (query) setQuery('');
      setOpen(false);
    }
  };
  const showList = open && results.length > 0;
  return (
    <div className={styles.search}>
      <input
        className={styles.field}
        type="search"
        role="combobox"
        aria-label={label}
        aria-expanded={showList}
        aria-controls={`${id}-list`}
        aria-autocomplete="list"
        aria-activedescendant={showList ? `${id}-${active}` : undefined}
        placeholder={data ? 'Find a tooltip by name or hash' : 'Loading tooltips…'}
        disabled={!data}
        value={query}
        onChange={(event) => {
          setQuery(event.target.value);
          setActive(0);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={onKeyDown}
      />
      {showList && (
        <ul id={`${id}-list`} role="listbox" className={styles.results} aria-label="Tooltips">
          {results.map((pick, index) => (
            <li
              key={pick.hash}
              id={`${id}-${index}`}
              role="option"
              aria-selected={index === active}
              className={styles.result}
              onMouseDown={(event) => {
                event.preventDefault();
                choose(pick);
              }}
              onMouseEnter={() => setActive(index)}
            >
              <span className={styles.resultName}>{pick.name}</span>
              <span className={styles.meta}>{pick.detail}</span>
            </li>
          ))}
        </ul>
      )}
      {recent.length > 0 && (
        <div className={styles.recent} role="group" aria-label="Recent picks">
          {recent.map((pick) => (
            <button
              key={pick.hash}
              type="button"
              className={styles.recentPick}
              title={`${pick.name} (${pick.hash})`}
              onClick={() => onPick(pick)}
            >
              {pick.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Recent picks per scope (project or the Tooltips view), on this device only. */
export function recentPicks(scope: string): Pick[] {
  try {
    const raw = JSON.parse(localStorage.getItem(`exports:recent:${scope}`) ?? '[]') as unknown;
    return Array.isArray(raw)
      ? raw.filter(
          (pick): pick is Pick =>
            typeof pick?.hash === 'string' &&
            /^\d+$/.test(pick.hash) &&
            typeof pick.name === 'string',
        )
      : [];
  } catch {
    return [];
  }
}

export function rememberPick(scope: string, pick: Pick): Pick[] {
  const next = [pick, ...recentPicks(scope).filter((old) => old.hash !== pick.hash)].slice(0, 6);
  try {
    localStorage.setItem(`exports:recent:${scope}`, JSON.stringify(next));
  } catch {
    // Private windows: recent picks stay for this page only.
  }
  return next;
}
