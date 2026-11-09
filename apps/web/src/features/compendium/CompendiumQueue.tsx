import { memo, useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import { VirtualList } from '../../ui/VirtualList';
import { phoneQuery, useMedia } from '../../ui/useMedia';
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
          {pinned && !decidedKinds.includes(row.kind) ? 'from editor' : kindLabels[row.kind]}
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
  const error = useCompendiumQueueStore((state) => state.error);
  const selected = useCompendiumQueueStore((state) => state.selected);
  const reinclude = useCompendiumQueueStore((state) => state.reinclude);
  const toggleGroup = useCompendiumQueueStore((state) => state.toggleGroup);
  const phone = useMedia(phoneQuery);
  // Touch rows are 44px; the list measures rem, so it follows the interface scale too.
  const itemHeight = useCallback(
    (item: QueueItem) => (item.type === 'header' ? headerRem : phone ? 2.75 : 2),
    [phone],
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
  const filter = (key: 'show' | 'q', value: string) => {
    const next = new URLSearchParams(params);
    if (value && !(key === 'show' && value === 'open')) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
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
  return (
    <nav aria-label="Compendium review queue" className={styles.queue}>
      <div className={styles.filters}>
        <input
          type="search"
          aria-label="Find entry"
          placeholder="Name or hash   /"
          data-compendium-search=""
          value={query}
          onChange={(event) => filter('q', event.target.value)}
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
      ) : rows === null ? (
        <div className={styles.skeleton} role="status" aria-label="Loading the review queue">
          {Array.from({ length: 12 }, (_, index) => (
            <span key={index} style={{ width: `${55 + ((index * 17) % 35)}%` }} />
          ))}
        </div>
      ) : model.items.length === 0 ? (
        <p className={styles.note}>
          {query || show !== 'open' || params.get('group') ? (
            <>
              Nothing matches.{' '}
              <button
                type="button"
                className={styles.link}
                onClick={() => {
                  const next = new URLSearchParams(params);
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
      ) : (
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
      )}
    </nav>
  );
}
