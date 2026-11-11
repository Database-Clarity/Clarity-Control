import { useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import type { Lang } from '@clarity/core';
import { languageLabel } from '../../../languageLabels';
import { useAuthStore } from '../../../stores/auth';
import { useDataStore } from '../../../stores/data';
import { archivedItemFor } from '../../archive/archive';
import { editorName } from '../../navigation/catalog';
import { ShellOverlay } from '../../navigation/ShellOverlay';
import {
  openPairs,
  reportLanguages,
  seesReports,
  useReportsIndex,
  useReportsIndexLoader,
} from './indexStore';
import { useReportsTab } from './tabStore';
import styles from './ReportsEntry.module.scss';

/** Tooltip + language pairs with open reports for this viewer, by count then name. */
function useWorklist() {
  const user = useAuthStore((state) => state.user);
  const open = useReportsIndex((state) => state.open);
  const failed = useReportsIndex((state) => state.failed && !state.open);
  const data = useDataStore((state) => state.data);
  const rows = useMemo(() => {
    const pairs = openPairs(open, reportLanguages(user));
    return pairs
      .map((pair) => {
        const item = data ? archivedItemFor(pair.hash, data) : undefined;
        return { ...pair, name: item ? editorName(item) : `Tooltip ${pair.hash}` };
      })
      .sort((a, b) => b.n - a.n || a.name.localeCompare(b.name) || a.lang.localeCompare(b.lang));
  }, [open, user, data]);
  return { user, rows, loaded: open !== null, failed };
}

function Worklist({
  rows,
  onOpen,
  className,
}: {
  rows: ReturnType<typeof useWorklist>['rows'];
  onOpen(hash: number, lang: string): void;
  className?: string;
}) {
  const list = useRef<HTMLUListElement>(null);
  const keys = (event: KeyboardEvent) => {
    const items = [...(list.current?.querySelectorAll<HTMLElement>('button') ?? [])];
    const at = items.indexOf(document.activeElement as HTMLElement);
    const to =
      event.key === 'ArrowDown'
        ? at + 1
        : event.key === 'ArrowUp'
          ? at - 1
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? items.length - 1
              : null;
    if (to === null || !items.length) return;
    event.preventDefault();
    items[(to + items.length) % items.length]?.focus();
  };
  if (!rows.length) return <p className={styles.empty}>No open reports.</p>;
  return (
    <ul ref={list} className={className ?? styles.list} onKeyDown={keys}>
      {rows.map((row, index) => (
        <li key={`${row.hash}:${row.lang}`}>
          <button
            type="button"
            className={styles.item}
            data-autofocus={index === 0 ? '' : undefined}
            onClick={() => onOpen(row.hash, row.lang)}
          >
            <span className={styles.name}>{row.name}</span>
            <span className={styles.lang}>{languageLabel(row.lang as Lang)}</span>
            <span className={styles.count} aria-label={`${row.n} open`}>
              {row.n}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

function useOpenReport() {
  const navigate = useNavigate();
  const openAndFocus = useReportsTab((state) => state.openAndFocus);
  return (hash: number, lang: string) => {
    openAndFocus();
    navigate(`/t/${hash}?lang=${lang}`);
  };
}

/**
 * The header's `Reports n` entry for role holders: n = tooltip + language pairs with open
 * reports in the viewer's languages, from the marker index. Until the bulk Reports tab exists it
 * opens this worklist; a row opens the tooltip with its Reports tab.
 */
export function ReportsEntry({
  className,
  badgeClassName,
}: {
  className: string;
  badgeClassName: string;
}) {
  useReportsIndexLoader();
  const { user, rows, loaded, failed } = useWorklist();
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const openReport = useOpenReport();
  if (!seesReports(user) || (!loaded && !failed)) return null;
  return (
    <li>
      <button
        ref={button}
        type="button"
        className={className}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={
          failed ? 'Reports (counts unavailable)' : `Reports, ${rows.length} with open reports`
        }
        onClick={() => setOpen((value) => !value)}
      >
        Reports
        {failed ? (
          <span className={badgeClassName} aria-hidden="true">
            !
          </span>
        ) : (
          rows.length > 0 && (
            <span className={badgeClassName} aria-hidden="true">
              {rows.length}
            </span>
          )
        )}
      </button>
      <ShellOverlay
        open={open}
        onClose={() => setOpen(false)}
        label="Open reports"
        anchorRef={button}
        width={320}
        modal={false}
      >
        {failed ? (
          <p className={styles.empty}>Report counts are unavailable right now.</p>
        ) : (
          <Worklist
            rows={rows}
            onOpen={(hash, lang) => {
              setOpen(false);
              openReport(hash, lang);
            }}
          />
        )}
      </ShellOverlay>
    </li>
  );
}

/** The phone menu's row: expands the same worklist in place. */
export function ReportsMenuRow({
  className,
  badgeClassName,
  onNavigate,
}: {
  className: string;
  badgeClassName: string;
  onNavigate(): void;
}) {
  useReportsIndexLoader();
  const { user, rows, loaded, failed } = useWorklist();
  const [expanded, setExpanded] = useState(false);
  const openReport = useOpenReport();
  if (!seesReports(user) || (!loaded && !failed)) return null;
  return (
    <>
      <button
        type="button"
        className={className}
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
      >
        <span>Reports</span>
        {rows.length > 0 && (
          <span className={badgeClassName} aria-label={`${rows.length} with open reports`}>
            {rows.length}
          </span>
        )}
      </button>
      {expanded &&
        (failed ? (
          <p className={styles.empty}>Report counts are unavailable right now.</p>
        ) : (
          <Worklist
            rows={rows}
            className={styles.phoneList}
            onOpen={(hash, lang) => {
              onNavigate();
              openReport(hash, lang);
            }}
          />
        ))}
    </>
  );
}
