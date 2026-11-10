import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { VirtualList } from '../../ui/VirtualList';
import { useSkeletonVisible } from '../../ui/Skeleton';
import { phoneQuery, useMedia } from '../../ui/useMedia';
import { useSettingsStore } from '../../stores/settings';
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
import styles from './CompendiumQueue.module.scss';

const headerRem = 1.5;
const itemKey = (item: QueueItem) => item.key;
export const queueRowId = (hash: number) => `cq-row-${hash}`;

const Row = memo(function Row({
  row,
  selected,
  pinned,
  onSelect,
  onReinclude,
}: {
  row: QueueRow;
  selected: boolean;
  pinned?: boolean;
  onSelect(hash: number): void;
  onReinclude?: (row: QueueRow) => void;
}) {
  const excluded = row.kind === 'not-needed';
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
      {excluded ? (
        <button
          type="button"
          className={styles.reinclude}
          disabled={!onReinclude}
          onClick={(event) => {
            event.stopPropagation();
            onReinclude?.(row);
          }}
        >
          Re-include
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

/** The queue behind the Compendium tab: filters and one virtualised, grouped list. */
export function CompendiumQueue() {
  const [params, setParams] = useSearchParams();
  const model = useCompendiumQueueStore((state) => state.model);
  const rows = useCompendiumQueueStore((state) => state.rows);
  const showSkeleton = useSkeletonVisible(rows === null, 'queue', false);
  const error = useCompendiumQueueStore((state) => state.error);
  const selected = useCompendiumQueueStore((state) => state.selected);
  const reinclude = useCompendiumQueueStore((state) => state.reinclude);
  const toggleGroup = useCompendiumQueueStore((state) => state.toggleGroup);
  const phone = useMedia(phoneQuery);
  // Phone rows are the touch size (2.25rem, 2.75rem with Large); the list measures rem, so it
  // follows the interface scale too.
  const touchRem = useSettingsStore((state) => state.device.touchSize) === 'large' ? 2.75 : 2.25;
  const itemHeight = useCallback(
    (item: QueueItem) => (item.type === 'header' ? headerRem : phone ? touchRem : 2),
    [phone, touchRem],
  );
  const show = parseShow(params.get('show'));
  const query = params.get('q') ?? '';
  const select = useCallback(
    (hash: number) => {
      const next = new URLSearchParams(params);
      next.delete('tab');
      next.set('hash', String(hash));
      setParams(next, { replace: true });
    },
    [params, setParams],
  );
  const filter = (key: 'show' | 'q', value: string) =>
    setParams(
      (previous) => {
        const next = new URLSearchParams(previous);
        if (value && !(key === 'show' && value === 'open')) next.set(key, value);
        else next.delete(key);
        return next;
      },
      { replace: true },
    );
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
              setParams(
                (previous) => {
                  const next = new URLSearchParams(previous);
                  for (const key of ['show', 'q', 'group']) next.delete(key);
                  return next;
                },
                { replace: true },
              );
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
    <nav aria-label="Compendium review queue" className={styles.queue}>
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
        <p role="alert" className={styles.note}>
          {error}
        </p>
      ) : rows === null || showSkeleton ? (
        <div className={styles.skeleton} role="status" aria-label="Loading the review queue">
          {Array.from({ length: 12 }, (_, index) => (
            <span key={index} style={{ width: `${55 + ((index * 17) % 35)}%` }} />
          ))}
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
          reveal={revealIndex !== undefined && revealIndex >= 0 ? revealIndex : undefined}
          groupStart={groupStart}
          activeDescendant={selected === undefined ? undefined : queueRowId(selected)}
          stickyFor={(item) =>
            item.type === 'header' ? (
              <Header item={item} onToggle={toggleGroup} />
            ) : null
          }
          renderItem={(item) =>
            item.type === 'header' ? (
              <Header item={item} onToggle={toggleGroup} />
            ) : (
              <Row
                row={item.row}
                pinned={item.pinned}
                selected={item.row.hash === selected}
                onSelect={select}
                onReinclude={reinclude}
              />
            )
          }
        />
        </>
      )}
    </nav>
  );
}
