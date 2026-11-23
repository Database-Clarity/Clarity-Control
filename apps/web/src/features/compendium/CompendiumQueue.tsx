import { memo, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { VirtualList } from '../../ui/VirtualList';
import {
  SkeletonRegion,
  SkeletonRows,
  SkeletonStatus,
  useSkeletonVisible,
} from '../../ui/Skeleton';
import { phoneQuery, touchQuery, useMedia } from '../../ui/useMedia';
import { useScaleFactor } from '../../ui/usePaneDivider';
import { useSettingsStore } from '../../stores/settings';
import { FinderSheetCloseContext } from '../navigation/FinderSheetContext';
import { useCompendiumQueueStore } from './queueStore';
import {
  decidedKinds,
  kindGlyphs,
  kindLabels,
  parseShow,
  showOptions,
  type QueueRow,
} from './queueRows';
import type { QueueItem } from './queueView';
import { asideKinds } from './queueView';
import { useWhyNotShared } from './sharedDecisions';
import { CompendiumViews } from './CompendiumViews';
import { useLinkedSources } from './linkedSources';
import styles from './CompendiumQueue.module.scss';
import { plainError } from '../../services/httpError';
import { InlineAlert } from '../../ui/InlineAlert';

const headerRem = 1.5;
const itemKey = (item: QueueItem) => item.key;
export const queueRowId = (hash: number) => `cq-row-${hash}`;

const Row = memo(function Row({
  row,
  selected,
  pinned,
  whyNot,
  onSelect,
  onReinclude,
}: {
  row: QueueRow;
  selected: boolean;
  pinned?: boolean;
  /** Why a decision that applies to everyone cannot be cleared here. */
  whyNot?: string;
  onSelect(hash: number): void;
  onReinclude?: (row: QueueRow) => void;
}) {
  const shared = row.kind === 'no-match' || row.excluded === 'shared';
  return (
    <div
      id={queueRowId(row.hash)}
      role="treeitem"
      aria-level={2}
      aria-selected={selected}
      className={styles.row}
      data-kind={row.kind}
      data-perf-navigation="true"
      data-selected={selected || undefined}
      title={`${row.name} · ${row.hash}`}
      onClick={() => onSelect(row.hash)}
    >
      <span className={styles.glyph} aria-hidden="true">
        {kindGlyphs[row.kind]}
      </span>
      <span className={styles.name}>{row.name}</span>
      {asideKinds.includes(row.kind) ? (
        <button
          type="button"
          className={styles.reinclude}
          disabled={!onReinclude || (shared && !!whyNot)}
          title={shared ? whyNot : undefined}
          onClick={(event) => {
            event.stopPropagation();
            // The row leaves with its button: keep focus (and its keys) in the list.
            event.currentTarget
              .closest<HTMLElement>('[role="tree"]')
              ?.focus({ preventScroll: true });
            onReinclude?.(row);
          }}
        >
          {row.kind === 'no-match' ? 'Unmark' : 'Re-include'}
        </button>
      ) : (
        <span className={styles.kind}>
          {pinned && !decidedKinds.includes(row.kind) ? 'outside filter' : kindLabels[row.kind]}
        </span>
      )}
    </div>
  );
});

function Header({
  item,
  onToggle,
}: {
  item: Extract<QueueItem, { type: 'header' }>;
  onToggle(group: string): void;
}) {
  return (
    <button
      type="button"
      className={styles.header}
      aria-expanded={!item.collapsed}
      data-perf-navigation="true"
      onClick={() => onToggle(item.group)}
    >
      <span className={styles.chevron} aria-hidden="true">
        {item.collapsed ? '▸' : '▾'}
      </span>
      <span className={styles.groupName}>{item.label}</span>
      <span className={styles.count}>{item.count}</span>
    </button>
  );
}

/** The left column of the Compendium page: the view switch, then the open view's list. */
export function CompendiumQueue() {
  const [params] = useSearchParams();
  // A phone has the switch on the page itself, above this sheet's list.
  const phone = useMedia(phoneQuery);
  const linked = params.get('tab') === 'linked';
  return (
    <nav
      aria-label={linked ? 'Source changes by category' : 'Compendium review queue'}
      className={styles.queue}
    >
      {!phone && <CompendiumViews />}
      {linked ? <LinkedFilters /> : <ReviewQueue />}
    </nav>
  );
}

/** Search, list, and category of the Source changes view; the page beside it lists the entries. */
function LinkedFilters() {
  const closeSheet = useContext(FinderSheetCloseContext);
  const { list, query, category, rows, searched, categories, set } = useLinkedSources();
  const options = [{ id: '', label: 'All categories', count: searched.length }, ...categories];
  return (
    <>
      <div className={styles.filters}>
        <input
          type="search"
          aria-label="Find entry"
          placeholder="Name or hash"
          value={query}
          onChange={(event) => set('linkedQuery', event.target.value)}
        />
        <select
          aria-label="Show"
          value={list}
          onChange={(event) =>
            set('linkedList', event.target.value === 'unlinked' ? 'unlinked' : '')
          }
        >
          <option value="changes">All changes</option>
          <option value="unlinked">Without links</option>
        </select>
      </div>
      {rows && (
        <ul className={styles.categories}>
          {options.map(({ id, label, count }) => (
            <li key={id}>
              <button
                type="button"
                className={styles.category}
                aria-pressed={id === category}
                onClick={() => {
                  set('linkedCategory', id);
                  closeSheet?.();
                }}
              >
                <span className={styles.groupName}>{label}</span>
                <span className={styles.count}>{count.toLocaleString('en')}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

/** The queue behind the Compendium tab: filters and one virtualised, grouped list. */
function ReviewQueue() {
  const [params, setParams] = useSearchParams();
  const whyNot = useWhyNotShared();
  // Writes start from the URL as it is now, never from the render a timer or row was set up in;
  // the router's setter changes with every URL, so rows keep one stable select (no row re-renders
  // beyond the two whose selection changed).
  const paramsRef = useRef(params);
  paramsRef.current = params;
  const setParamsRef = useRef(setParams);
  setParamsRef.current = setParams;
  // On a phone the queue is the header's sheet: choosing an entry closes it over the detail.
  const sheetClose = useContext(FinderSheetCloseContext);
  const closeSheet = useRef(sheetClose);
  closeSheet.current = sheetClose;
  const model = useCompendiumQueueStore((state) => state.model);
  const rows = useCompendiumQueueStore((state) => state.rows);
  // The tab publishes its rows from an effect, a commit after this column mounts. Give them
  // the clock's two-frame grace (a warm open lists at once) instead of flashing a skeleton
  // whose 200 ms minimum then held every open of a ready model.
  const showSkeleton = useSkeletonVisible(rows === null, 'queue', true);
  const error = useCompendiumQueueStore((state) => state.error);
  const selected = useCompendiumQueueStore((state) => state.selected);
  const reinclude = useCompendiumQueueStore((state) => state.reinclude);
  const toggleGroup = useCompendiumQueueStore((state) => state.toggleGroup);
  // Touch rows (phones and coarse pointers) are var(--tap): 2.25rem, or max(44px, 2.75rem) with
  // Large, so they follow the interface scale and keep the 44px floor below 100%.
  const touch = useMedia(touchQuery);
  const scale = useScaleFactor();
  const large = useSettingsStore((state) => state.device.touchSize) === 'large';
  const touchRem = large ? Math.max(44 / (16 * scale), 2.75) : 2.25;
  const itemHeight = useCallback(
    (item: QueueItem) => (item.type === 'header' ? headerRem : touch ? touchRem : 2),
    [touch, touchRem],
  );
  const show = parseShow(params.get('show'));
  const query = params.get('q') ?? '';
  const select = useCallback((hash: number) => {
    const next = new URLSearchParams(paramsRef.current);
    next.set('hash', String(hash));
    setParamsRef.current(next, { replace: true });
    closeSheet.current?.();
  }, []);
  const filter = (key: 'show' | 'q', value: string) => {
    const next = new URLSearchParams(paramsRef.current);
    if (value && !(key === 'show' && value === 'open')) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
  };
  // The box owns what is typed; the URL follows shortly after, so fast typing never loses keys
  // to a route commit, and an outside change (Clear filters, Back) still lands in the box.
  const [text, setText] = useState(query);
  const pushed = useRef(query);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => {
    if (query === pushed.current) return;
    pushed.current = query;
    setText(query);
  }, [query]);
  useEffect(() => () => clearTimeout(timer.current), []);
  const type = (value: string) => {
    setText(value);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      pushed.current = value;
      filter('q', value);
    }, 150);
  };
  const revealIndex =
    selected === undefined
      ? undefined
      : model.items.findIndex((item) => item.type === 'row' && item.row.hash === selected);
  // Opening a group or putting a row back leaves the list where the user is working: the selected
  // row is not brought back into view until it or the filters change.
  const view = `${selected}|${show}|${query}|${params.get('group') ?? ''}`;
  const viewRef = useRef(view);
  viewRef.current = view;
  const arranged = useRef<string>();
  const toggle = useCallback(
    (group: string) => {
      arranged.current = viewRef.current;
      toggleGroup(group);
    },
    [toggleGroup],
  );
  const putBack = useCallback(
    (row: QueueRow) => {
      arranged.current = viewRef.current;
      reinclude?.(row);
    },
    [reinclude],
  );
  const reveal =
    revealIndex !== undefined && revealIndex >= 0 && arranged.current !== view
      ? revealIndex
      : undefined;
  const groupStart = useCallback(
    (index: number) => {
      for (let i = index; i >= 0; i--) if (model.items[i]?.type === 'header') return i;
      return -1;
    },
    [model.items],
  );
  const filtersActive = !!query || show !== 'open' || !!params.get('group');
  const noMatches = (
    <p className={styles.note}>
      {filtersActive ? (
        <>
          Nothing matches.{' '}
          <button
            type="button"
            className={styles.link}
            onClick={() => {
              setText('');
              pushed.current = '';
              const next = new URLSearchParams(paramsRef.current);
              for (const key of ['show', 'q', 'group']) next.delete(key);
              setParams(next, { replace: true });
            }}
          >
            Clear filters
          </button>
        </>
      ) : (
        'Nothing needs review.'
      )}
    </p>
  );
  return (
    <>
      <div className={styles.filters}>
        <input
          type="search"
          aria-label="Find entry"
          placeholder="Name or hash   /"
          data-compendium-search=""
          value={text}
          onChange={(event) => type(event.target.value)}
        />
        <select
          aria-label="Show"
          data-perf-navigation="true"
          value={show}
          onChange={(event) => filter('show', event.target.value)}
        >
          {showOptions.map(({ value, label }) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </div>
      {error ? (
        <InlineAlert>{plainError(error)}</InlineAlert>
      ) : rows === null && !showSkeleton ? (
        <div className={styles.skeleton} />
      ) : rows === null || showSkeleton ? (
        <div className={styles.skeleton} aria-busy="true">
          <SkeletonStatus>Loading the review queue</SkeletonStatus>
          <SkeletonRegion>
            <SkeletonRows
              count={12}
              maxRows={12}
              columns={[75, 25]}
              rowHeight={`${touch ? touchRem : 2}rem`}
            />
          </SkeletonRegion>
        </div>
      ) : model.items.length === 0 ? (
        noMatches
      ) : (
        <>
          {model.visible === 0 && filtersActive && noMatches}
          <VirtualList
            className={styles.list}
            role="tree"
            label="Entries to review"
            items={model.items}
            heightRem={itemHeight}
            itemKey={itemKey}
            reveal={reveal}
            groupStart={groupStart}
            activeDescendant={selected === undefined ? undefined : queueRowId(selected)}
            stickyFor={(item) =>
              item.type === 'header' ? <Header item={item} onToggle={toggle} /> : null
            }
            renderItem={(item) =>
              item.type === 'header' ? (
                <Header item={item} onToggle={toggle} />
              ) : (
                <Row
                  row={item.row}
                  pinned={item.pinned}
                  whyNot={whyNot}
                  selected={item.row.hash === selected}
                  onSelect={select}
                  onReinclude={reinclude && putBack}
                />
              )
            }
          />
        </>
      )}
    </>
  );
}
