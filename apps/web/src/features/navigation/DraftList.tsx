import { Fragment, memo, useCallback, useMemo, useState, type KeyboardEvent } from 'react';
import type { Lang, Tooltip } from '@clarity/core';
import { languageLabel } from '../../languageLabels';
import { VirtualList } from '../../ui/VirtualList';
import { phoneQuery, touchQuery, useMedia } from '../../ui/useMedia';
import { useScaleFactor } from '../../ui/usePaneDivider';
import { useSettingsStore } from '../../stores/settings';
import { When } from '../../ui/When';
import styles from './DraftButton.module.scss';

interface DraftPair {
  base: Tooltip;
  next: Tooltip;
}

/** What a draft changes, for grouping. A draft sits in the first kind it matches. */
export type DraftKind = 'compendium' | 'text' | 'translation' | 'other';
const kinds: DraftKind[] = ['compendium', 'text', 'translation', 'other'];
const kindLabels: Record<DraftKind, string> = {
  compendium: 'Compendium link',
  text: 'English text',
  translation: 'Translations',
  other: 'Other fields',
};

function changedLanguages(draft: DraftPair) {
  return Object.keys(draft.next.text).filter(
    (language) =>
      draft.next.text[language as Lang]?.text !== draft.base.text[language as Lang]?.text,
  );
}

function latest(draft: DraftPair, languages: string[]) {
  return languages
    .map((language) => draft.next.text[language as Lang]?.updatedAt ?? '')
    .sort()
    .at(-1);
}

export function draftKind(draft: DraftPair, languages: string[]): DraftKind {
  if (
    JSON.stringify(draft.base.compendium ?? null) !== JSON.stringify(draft.next.compendium ?? null)
  )
    return 'compendium';
  if (languages.includes('en')) return 'text';
  return languages.length ? 'translation' : 'other';
}

export interface DraftRow {
  hash: number;
  kind: DraftKind;
  languages: string[];
  time?: string;
}

/** One row per draft, newest first within its kind. */
export function draftRows(drafts: Record<string, DraftPair>): DraftRow[] {
  return Object.entries(drafts)
    .map(([hash, draft]) => {
      const languages = changedLanguages(draft);
      return {
        hash: Number(hash),
        kind: draftKind(draft, languages),
        languages,
        time: latest(draft, languages),
      };
    })
    .sort((a, b) => (b.time ?? '').localeCompare(a.time ?? '') || a.hash - b.hash);
}

type Item =
  | { type: 'header'; kind: DraftKind; count: number; collapsed: boolean }
  | { type: 'row'; row: DraftRow };

const itemKey = (item: Item) => (item.type === 'header' ? `h:${item.kind}` : item.row.hash);
const headerRem = 1.5;
export const draftRowId = (hash: number) => `draft-row-${hash}`;
const headerId = (kind: DraftKind) => `draft-group-${kind}`;
const itemId = (item: Item) =>
  item.type === 'header' ? headerId(item.kind) : draftRowId(item.row.hash);

const Row = memo(function Row({
  row,
  name,
  conflicts,
  stale,
  active,
  onOpen,
  onDiscard,
}: {
  row: DraftRow;
  name: string;
  conflicts: number;
  stale: boolean;
  active: boolean;
  onOpen(hash: number): void;
  onDiscard(hash: number): void;
}) {
  return (
    <div
      id={draftRowId(row.hash)}
      role="treeitem"
      aria-level={2}
      aria-selected={active}
      aria-disabled={stale || undefined}
      className={styles.row}
      data-active={active || undefined}
      title={`${name} · ${row.hash}`}
      onClick={() => {
        if (!stale) onOpen(row.hash);
      }}
    >
      <span className={styles.name}>{name}</span>
      <small className={styles.hash}>{row.hash}</small>
      <small className={styles.meta}>
        {/* The group already says English text: name the languages only when they add to it. */}
        {[
          row.kind !== 'other' && !(row.kind === 'text' && row.languages.length === 1)
            ? row.languages.map(languageLabel).join(', ')
            : null,
          conflicts > 0 ? (
            <span key="c" className={styles.conflict}>
              {conflicts} conflict{conflicts === 1 ? '' : 's'}
            </span>
          ) : null,
          row.time ? <When key="t" value={row.time} /> : null,
        ]
          .filter(Boolean)
          .map((part, at) => (
            <Fragment key={at}>
              {at ? ' · ' : ''}
              {part}
            </Fragment>
          ))}
      </small>
      <button
        type="button"
        tabIndex={-1}
        className={styles.discard}
        aria-label={`Discard draft ${name}`}
        onClick={(event) => {
          event.stopPropagation();
          onDiscard(row.hash);
        }}
      >
        Discard
      </button>
    </div>
  );
});

function Header({
  item,
  active,
  pinned = false,
  onToggle,
}: {
  item: Extract<Item, { type: 'header' }>;
  active: boolean;
  /** The copy pinned over the list while its rows scroll: for the eye and the pointer only. */
  pinned?: boolean;
  onToggle(kind: DraftKind): void;
}) {
  return (
    <div
      id={pinned ? undefined : headerId(item.kind)}
      role={pinned ? undefined : 'treeitem'}
      aria-hidden={pinned || undefined}
      aria-level={pinned ? undefined : 1}
      aria-expanded={pinned ? undefined : !item.collapsed}
      aria-selected={pinned ? undefined : active}
      className={styles.group}
      data-active={active || undefined}
      onClick={() => onToggle(item.kind)}
    >
      <span className={styles.chevron} aria-hidden="true">
        {item.collapsed ? '▸' : '▾'}
      </span>
      <span className={styles.groupName}>{kindLabels[item.kind]}</span>
      <span className={styles.groupCount}>{item.count}</span>
    </div>
  );
}

/**
 * The drafts popover's list: one group per change kind (with its count, collapsible), compact
 * rows in a virtualised tree, so 400+ drafts open and scroll as fast as a handful. Keyboard: the
 * arrows move, Enter opens a row or toggles a group, Left and Right collapse and expand, Delete
 * asks to discard. A row opens its entry; Discard asks first (the caller's confirm).
 */
export function DraftList({
  rows,
  nameOf,
  conflictsOf,
  isStale,
  onOpen,
  onDiscard,
}: {
  rows: DraftRow[];
  nameOf(hash: number): string;
  conflictsOf(hash: number): number;
  isStale(hash: number): boolean;
  onOpen(hash: number): void;
  onDiscard(hash: number): void;
}) {
  const [collapsed, setCollapsed] = useState<ReadonlySet<DraftKind>>(() => new Set());
  const [active, setActive] = useState<string | number | null>(null);
  const items = useMemo(() => {
    const result: Item[] = [];
    for (const kind of kinds) {
      const members = rows.filter((row) => row.kind === kind);
      if (!members.length) continue;
      const closed = collapsed.has(kind);
      result.push({ type: 'header', kind, count: members.length, collapsed: closed });
      if (!closed) for (const row of members) result.push({ type: 'row', row });
    }
    return result;
  }, [rows, collapsed]);
  const toggle = useCallback(
    (kind: DraftKind) =>
      setCollapsed((previous) => {
        const next = new Set(previous);
        if (!next.delete(kind)) next.add(kind);
        return next;
      }),
    [],
  );
  // Row heights follow the interface scale: 28px desktop rows, the touch size on coarse pointers,
  // and two lines (name over languages and time) on a phone.
  const phone = useMedia(phoneQuery);
  const touch = useMedia(touchQuery);
  const scale = useScaleFactor();
  const large = useSettingsStore((state) => state.device.touchSize) === 'large';
  const rowRem = phone
    ? large
      ? 3.25
      : 2.75
    : touch
      ? large
        ? Math.max(44 / (16 * scale), 2.75)
        : 2.25
      : 1.75;
  const heightRem = useCallback(
    (item: Item) => (item.type === 'header' ? headerRem : rowRem),
    [rowRem],
  );
  const groupStart = useCallback(
    (index: number) => {
      for (let i = index; i >= 0; i--) if (items[i]?.type === 'header') return i;
      return -1;
    },
    [items],
  );
  const index = active === null ? -1 : items.findIndex((item) => itemKey(item) === active);
  const keydown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget || event.altKey || event.ctrlKey || event.metaKey)
      return;
    const current = items[index];
    const go = (to: number) => {
      const target = items[Math.max(0, Math.min(items.length - 1, to))];
      if (target) setActive(itemKey(target));
    };
    let handled = true;
    switch (event.key) {
      case 'ArrowDown':
        go(index + 1);
        break;
      case 'ArrowUp':
        go(index < 0 ? 0 : index - 1);
        break;
      case 'Home':
        go(0);
        break;
      case 'End':
        go(items.length - 1);
        break;
      case 'ArrowLeft':
        if (current?.type === 'header' && !current.collapsed) toggle(current.kind);
        else if (current?.type === 'row') go(groupStart(index));
        else handled = false;
        break;
      case 'ArrowRight':
        if (current?.type === 'header' && current.collapsed) toggle(current.kind);
        else handled = false;
        break;
      case 'Enter':
      case ' ':
        if (current?.type === 'header') toggle(current.kind);
        else if (current?.type === 'row' && event.key === 'Enter' && !isStale(current.row.hash))
          onOpen(current.row.hash);
        else handled = false;
        break;
      case 'Delete':
        if (current?.type === 'row') onDiscard(current.row.hash);
        else handled = false;
        break;
      default:
        handled = false;
    }
    if (handled) event.preventDefault();
  };
  // As tall as its rows, up to about 16 desktop rows; the popover's room shrinks it further.
  const naturalRem = items.reduce((sum, item) => sum + heightRem(item), 0);
  return (
    // The box takes its share of the popover from flex layout; the list fills it.
    <div
      className={styles.listBox}
      style={{
        flexBasis: `min(${naturalRem}rem, 28rem)`,
        minHeight: `min(${naturalRem}rem, 6rem)`,
      }}
    >
      <VirtualList
        className={styles.list}
        role="tree"
        label="Local drafts"
        items={items}
        heightRem={heightRem}
        itemKey={itemKey}
        reveal={index >= 0 ? index : undefined}
        groupStart={groupStart}
        activeDescendant={index >= 0 ? itemId(items[index]!) : undefined}
        onKeyDown={keydown}
        stickyFor={(item, at) =>
          item.type === 'header' ? (
            <Header item={item} active={at === index} pinned onToggle={toggle} />
          ) : null
        }
        renderItem={(item, at) =>
          item.type === 'header' ? (
            <Header item={item} active={at === index} onToggle={toggle} />
          ) : (
            <Row
              row={item.row}
              name={nameOf(item.row.hash)}
              conflicts={conflictsOf(item.row.hash)}
              stale={isStale(item.row.hash)}
              active={at === index}
              onOpen={onOpen}
              onDiscard={onDiscard}
            />
          )
        }
      />
    </div>
  );
}
