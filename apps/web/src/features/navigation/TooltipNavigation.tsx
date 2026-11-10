import { useCompendiumStore } from '../compendium/store';
import {
  memo,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ComponentProps,
  type CSSProperties,
  type KeyboardEvent,
  type MutableRefObject,
} from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { flushSync } from 'react-dom';
import type { EditorData } from '../../stores/data';
import { useDraftStore } from '../../stores/drafts';
import { usePreviewReviewStore } from '../../stores/previewReview';
import {
  useWorkspaceShortcutOwner,
  workspaceShortcutOwners,
  workspaceShortcutsBlocked,
} from '../../ui/interaction';
import {
  classifiedCategory,
  exoticWeaponKind,
  finderCategoryId,
  frameGroupSize,
  groupedSection,
  itemFor,
  listName,
  navigationGroups,
  sharedPerkLabel,
  variantHashes,
  type CategorySection,
  type GroupedSection,
} from './catalog';
import { enhancedPairs } from '../tooltip/variants';
import { EnhancedArrow } from '../../ui/EnhancedArrow';
import {
  categoryPosition,
  createStepping,
  entryKey,
  keyOf,
  parseScope,
  positionLabel,
  createWheelStepper,
  resolvePlace,
  scopeValue,
  stepTarget,
  target as stepRoute,
  tooltipPath,
  wheelStep,
  type Entry,
  type StepTarget,
  type SteppingGuard,
} from './stepping';
import { useSettingsStore } from '../../stores/settings';
import { FinderSheetCloseContext, FinderSheetContext } from './FinderSheetContext';
import {
  beginSteppingFrame,
  clearSteppingTarget,
  holdSteppingKey,
  pulseStepping,
  publishSteppingTarget,
  useSteppingActivity,
} from './steppingActivity';
import { touchQuery, useMedia } from '../../ui/useMedia';
import { useScaleFactor } from '../../ui/usePaneDivider';
import styles from './TooltipFinder.module.scss';

// Stepping asks the preview leave guard before it moves anything; see createStepping.
const pathname = (route: string) => route.split('?')[0];
const steppingGuard: SteppingGuard = {
  allow: (from, to) => usePreviewReviewStore.getState().requestLeave(pathname(from), pathname(to)),
  epoch: () => usePreviewReviewStore.getState().epoch,
  authorized: (run) => usePreviewReviewStore.getState().authorized(run),
};

interface Row {
  hash: number;
  /** Row identity: the hash, or hash:group where a hash is listed under several groups. */
  key: string;
  /** The group the row is listed under ('' in a category without groups). */
  group: string;
  name: string;
  /** The perk an exotic armour entry opens, or the entry of a weapon/activity row in All scope. */
  perk?: string;
  /** Weapon entry kind (Frame, Perk, Catalyst, Part), shown before the hash. */
  kind?: string;
  /** Replaces the generic shared-perk mark on a grouped row: "also X" in a group, "shared" in All. */
  extra?: string;
  /** The entry's own name, for the two-line phone form of a grouped row. */
  entry?: string;
  /** The row sits in an All-scope list: committing it keeps the All scope. */
  all?: boolean;
  /** The name already lists several pieces, so the row needs no shared-perk mark. */
  listsPieces?: boolean;
  category: string;
}

const noItems: never[] = [];
const noDrafts: ReturnType<typeof useDraftStore.getState>['drafts'] = {};
// Small lists remain eager; longer lists keep a symmetric, fully laid-out
// window. Its contents never rely on deferred content-visibility painting.
const retainedRowLimit = 96;

function FinderDraftIndicator({ hash, data }: { hash: number; data: EditorData }) {
  const dirty = useDraftStore((state) =>
    variantHashes(hash, data).some((variant) => state.drafts[variant]),
  );
  return dirty ? <span className={styles.draftDot} role="img" aria-label="Unsaved draft" /> : null;
}

interface FinderViewport {
  top: number;
  height: number;
}
function createFinderViewport() {
  let current: FinderViewport = { top: 0, height: 416 };
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => current,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    set(update: FinderViewport | ((previous: FinderViewport) => FinderViewport)) {
      const next = typeof update === 'function' ? update(current) : update;
      if (next.top === current.top && next.height === current.height) return;
      current = next;
      for (const listener of listeners) listener();
    },
  };
}

// Moving the highlight changes two rows, not every catalogue lookup and DOM subtree.
const FinderOption = memo(function FinderOption({
  row,
  index,
  id,
  current,
  active,
  data,
  drafts,
  source,
  allCategories,
  onActive,
  onCommit,
  total,
  virtual,
  rowHeight,
  twoLine,
  narrow = false,
}: {
  row: Row;
  index: number;
  id: string;
  current: boolean;
  active: boolean;
  data: EditorData;
  drafts: ReturnType<typeof useDraftStore.getState>['drafts'];
  source: ReturnType<typeof useCompendiumStore.getState>['data'];
  allCategories: boolean;
  onActive(index: number): void;
  onCommit: { current(row: Row): void };
  total: number;
  virtual: boolean;
  rowHeight: number;
  /** The phone sheet shows a grouped row as entry over "group · kind · hash". */
  twoLine: boolean;
  /** A screen under 21rem wide: every row is two lines, the name over the perk and hash. */
  narrow?: boolean;
}) {
  const item = itemFor(row.hash, data);
  const isDirty = variantHashes(row.hash, data).some((variant) => drafts[variant]);
  const shared = sharedPerkLabel(row.hash, data, source);
  const frames = frameGroupSize(row.hash, data);
  const enhanced = enhancedPairs(row.hash, data).length > 0;
  const stacked = twoLine && row.entry !== undefined;
  return (
    <li
      id={id}
      style={
        virtual
          ? {
              position: 'absolute',
              top: 0,
              transform: `translateY(${index * rowHeight}px)`,
              left: 0,
              right: 0,
            }
          : undefined
      }
      role="option"
      aria-selected={current}
      aria-posinset={index + 1}
      aria-setsize={total}
      data-active={active || undefined}
      data-current={current || undefined}
      title={shared}
      className={styles.option}
      data-two-line={stacked || narrow || undefined}
      data-grouped={row.group || undefined}
      onMouseDown={(event) => event.preventDefault()}
      onMouseMove={() => !active && onActive(index)}
      onClick={() => onCommit.current(row)}
    >
      <span className={styles.mark} aria-hidden="true">
        {isDirty ? '*' : ''}
      </span>
      <span className={styles.name}>
        {isDirty && <span className="sr-only">Unsaved draft: </span>}
        {stacked ? row.entry : row.name}
      </span>
      <small>
        {enhanced && (
          <span className={styles.enhanced} title="Has an enhanced version">
            <EnhancedArrow />
          </span>
        )}
        {!stacked && row.perk && <span className={styles.perk}>{row.perk}</span>}
        <span className={styles.tail}>
          {stacked ? row.all && `${row.name} · ` : row.perk && ' · '}
          {row.kind && `${row.kind} · `}
          {row.hash}
          {row.extra && ` · ${row.extra}`}
          {shared && !row.listsPieces && !row.group && ' · shared perk'}
          {frames > 1 && ` ×${frames}`}
          {item && allCategories && ` · ${row.category}`}
        </span>
      </small>
    </li>
  );
});

interface FinderOptionsProps extends Omit<
  ComponentProps<typeof FinderOption>,
  'row' | 'index' | 'id' | 'current' | 'active' | 'total' | 'virtual'
> {
  rows: Row[];
  active: number;
  hash: number;
  /** The group of the open entry, so a hash listed twice marks only the one the route names. */
  group: string;
  base: string;
  query: string;
  viewportStore: ReturnType<typeof createFinderViewport>;
  listLayout: MutableRefObject<{ top: number } | null>;
  pointerHighlight: MutableRefObject<boolean>;
  revealedActive: MutableRefObject<number | null>;
}

// Native scrolling updates only this boundary. In particular, it must not
// reconcile every category option or the combobox on each window shift.
const FinderOptions = memo(function FinderOptions({
  rows,
  active,
  hash,
  group,
  base,
  query,
  viewportStore,
  listLayout,
  pointerHighlight,
  revealedActive,
  ...rowProps
}: FinderOptionsProps) {
  const viewport = useSyncExternalStore(
    viewportStore.subscribe,
    viewportStore.getSnapshot,
    viewportStore.getSnapshot,
  );
  const { rowHeight } = rowProps;
  const option = (row: Row, index: number, key: string | number = row.key) => (
    <FinderOption
      {...rowProps}
      key={key}
      row={row}
      index={index}
      id={`${base}-o${row.key}`}
      current={row.hash === hash && (!row.group || row.group === group)}
      active={index === active}
      total={rows.length}
      virtual={rows.length > retainedRowLimit}
    />
  );
  if (rows.length <= retainedRowLimit) return <>{rows.map((row, index) => option(row, index))}</>;

  // The synchronous external-store subscription fills the destination on every
  // native scroll notification, including jumps larger than this buffer. Keep
  // half a viewport on either side without laying out several hidden screens.
  const overscan = Math.max(8, Math.ceil(viewport.height / rowHeight / 2));
  const initialIndex = query.trim()
    ? 0
    : Math.max(
        0,
        rows.findIndex((row) => row.hash === hash && (!row.group || row.group === group)),
      );
  const targetIndex = listLayout.current ? active : initialIndex;
  const targetTop = targetIndex * rowHeight;
  const baseTop = listLayout.current ? viewport.top : 0;
  const renderTop =
    !pointerHighlight.current && revealedActive.current !== active
      ? targetTop < baseTop
        ? targetTop
        : Math.max(baseTop, targetTop + rowHeight - viewport.height)
      : viewport.top;
  const windowSize = Math.min(rows.length, Math.ceil(viewport.height / rowHeight) + 2 * overscan);
  const start = Math.max(
    0,
    Math.min(rows.length - windowSize, Math.floor(renderTop / rowHeight) - overscan),
  );
  const end = start + windowSize;
  const indexes = new Set(Array.from({ length: end - start }, (_, i) => start + i));
  if (rows[active]) indexes.add(active);
  return (
    <li role="presentation" style={{ height: rows.length * rowHeight }}>
      <ul
        role="presentation"
        style={{ position: 'relative', height: '100%', margin: 0, padding: 0, listStyle: 'none' }}
      >
        {[...indexes]
          .sort((a, b) => a - b)
          .map((index) =>
            option(
              rows[index],
              index,
              index >= start && index < end ? index % windowSize : 'active',
            ),
          )}
      </ul>
    </li>
  );
});

const noRows: Row[] = [];
const plainRow = (item: CategorySection['items'][number], section: CategorySection): Row => ({
  hash: item.hash,
  key: String(item.hash),
  group: '',
  // The row names the piece and keeps the perk on the right, so a set's rows stay
  // tellable apart even where the name column truncates.
  name: item.piece ?? item.name,
  perk: item.perkName && item.perkName !== (item.piece ?? item.name) ? item.perkName : undefined,
  listsPieces: (item.pieces ?? 1) > 1,
  category: section.label,
});

/**
 * Rows of a grouped category: one weapon's (or activity's) entries, or every group's in All scope.
 * A group row leads with the entry; an All row leads with the group, the anchor of the alphabet,
 * and keeps the entry beside the hash. An entry listed under two weapons names the other one.
 */
function groupedRows(
  section: CategorySection,
  grouped: GroupedSection,
  scope: { all: boolean; group: string },
): Row[] {
  const entries = scope.all ? grouped.all : (grouped.byId.get(scope.group)?.entries ?? []);
  return entries.map((entry): Row => {
    const item = grouped.items.get(entry.hash)!;
    const owners = grouped.owners.get(entry.hash);
    const others = owners?.filter((group) => group.id !== entry.group).map((group) => group.label);
    const label = grouped.byId.get(entry.group)?.label ?? '';
    return {
      hash: entry.hash,
      key: entryKey(entry.hash, entry.group),
      group: entry.group,
      name: scope.all ? label : item.name,
      perk: scope.all ? item.name : undefined,
      kind: grouped.grouping === 'weapon' ? exoticWeaponKind(item) : undefined,
      extra: owners ? (scope.all ? 'shared' : `also ${others?.join(', ')}`) : undefined,
      entry: item.name,
      all: scope.all,
      category: section.label,
    };
  });
}

/**
 * The editor's finder: category, a searchable tooltip combobox (the selector itself) and the
 * position in the category. Typing filters, arrows move the highlighted option, Enter commits,
 * Escape restores the current item and its query and keeps focus. The highlighted option and
 * the selected (current) one are drawn differently. `bar` is the header form; `sheet` the phone
 * form, which adds Previous/Next because touch screens have no Shift+wheel.
 */
export const TooltipNavigation = memo(function TooltipNavigation({
  data,
  variant = 'bar',
}: {
  data: EditorData;
  variant?: 'bar' | 'sheet';
}) {
  const compendiumSource = useCompendiumStore((state) => state.data);
  const sheetOpen = useContext(FinderSheetContext);
  const closeSheet = useContext(FinderSheetCloseContext);
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [draggingScrollbar, setDraggingScrollbar] = useState(false);
  const draggingScrollbarRef = useRef(false);
  const pointerHighlight = useRef(false);
  const hoverActive = useCallback((index: number) => {
    pointerHighlight.current = true;
    setActive(index);
  }, []);
  const [allCategories, setAllCategories] = useState(false);
  // Widens a weapon's (or an activity's) list to every group of the category.
  const [allGroups, setAllGroups] = useState(false);
  const swapWheel = useSettingsStore((state) => state.device.finderWheel) === 'groups';
  const swapWheelRef = useRef(swapWheel);
  swapWheelRef.current = swapWheel;
  const base = useId();
  const listId = `${base}-list`;
  const optionId = (row: Row) => `${base}-o${row.key}`;
  const groups = useMemo(() => navigationGroups(data, ''), [data]);
  const found = useMemo(
    () => (query.trim() ? navigationGroups(data, query) : groups),
    [data, groups, query],
  );
  const drafts = useDraftStore((state) => (open ? state.drafts : noDrafts));
  const navigate = useNavigate();
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;
  const location = useLocation();
  const urgentTarget = useSteppingActivity((state) => state.target);
  const hash = Number(pathname(urgentTarget ?? location.pathname).split('/')[2]);
  const routeSearch = urgentTarget ? (urgentTarget.split('?')[1] ?? '') : location.search;
  const sections = useMemo(() => groups.flatMap((group) => group.sections), [groups]);
  const selectedCategory =
    sections.find(
      (category) =>
        category.id === finderCategoryId(classifiedCategory(itemFor(hash, data), data)?.id ?? ''),
    ) ?? sections[0];
  const items = selectedCategory?.items ?? noItems;
  const grouped = useMemo(
    () => (selectedCategory ? groupedSection(selectedCategory, data) : undefined),
    [selectedCategory, data],
  );
  const groupedRef = useRef(grouped);
  groupedRef.current = grouped;
  // A category without groups lists its items as entries of no group.
  const plain = useMemo(() => {
    const list: Entry[] = grouped ? [] : items.map((item) => ({ hash: item.hash, group: '' }));
    return { list, index: new Map(list.map((entry, i) => [keyOf(entry), i])) };
  }, [grouped, items]);
  /** The scope and group of a route: from `?g=`, else the item's first owner. */
  const placeOf = (itemHash: number, search: string) => {
    if (!grouped) return { all: false, group: '' };
    const param = search ? new URLSearchParams(search).get('g') : null;
    return resolvePlace(parseScope(param), itemHash, grouped.firstGroup, (h, g) =>
      grouped.allIndex.has(entryKey(h, g)),
    );
  };
  /** The entries a scope steps through, and where each sits. */
  const scopeLists = (all: boolean, group: string) => {
    if (!grouped) return plain;
    const own = all ? undefined : grouped.byId.get(group);
    return own
      ? { list: own.entries, index: own.index }
      : { list: grouped.all, index: grouped.allIndex };
  };
  const place = placeOf(hash, routeSearch);
  const scope = scopeLists(place.all, place.group);
  const entry: Entry = { hash, group: place.group };
  const position = categoryPosition(entry, scope.list, scope.index);
  const current = useRef({ pathname: location.pathname, search: location.search });
  current.current = { pathname: location.pathname, search: location.search };
  const field = useRef<HTMLInputElement>(null);
  useWorkspaceShortcutOwner(field, open && (variant !== 'sheet' || sheetOpen));
  const list = useRef<HTMLUListElement>(null);
  const listObserver = useRef<ResizeObserver | null>(null);
  const revealedActive = useRef<number | null>(null);
  const listLayout = useRef<{ element: HTMLUListElement; top: number; height: number } | null>(
    null,
  );
  const revealActive = useRef<() => void>(() => undefined);
  const scale = useScaleFactor();
  const touchRows = useMedia(touchQuery);
  const touchSize = useSettingsStore((state) => state.device.touchSize);
  // Under 21rem of screen width (a phone at a large interface scale) a row is two lines.
  const narrow = useMedia(`(max-width: ${Math.floor(21 * 16 * scale)}px)`) && touchRows;
  // Matches the fixed CSS row geometry (var(--tap), plus 1.125rem for two lines) at every
  // interface scale, computed once per scale and size: scroll handlers never measure a row or
  // synchronously flush a React render.
  // Compact is 2.25rem (follows the scale both ways); Large is max(44px, 2.75rem).
  const tap = touchSize === 'large' ? Math.max(44, 44 * scale) : 36 * scale;
  const rowHeight =
    Math.round((touchRows ? tap + (narrow ? 18 * scale : 0) : 28 * scale) * 64) / 64;
  const [viewportStore] = useState(createFinderViewport);
  const setViewport = viewportStore.set;
  const root = useRef<HTMLDivElement>(null);
  const openRef = useRef(open);
  openRef.current = open;
  const [stepping] = useState(() =>
    createStepping(
      (target, options) => {
        if (!options.flushSync) return navigateRef.current(target, options);
        flushSync(() => publishSteppingTarget(target, landNewest, resumeNewest));
        // Identity lands now; route work waits when the document is deferred.
        // A free frame resumes only the newest target. History replaces the
        // intermediate entry and pushes exactly once at gesture commit.
        if (!useSteppingActivity.getState().deferWorkspace) resumeNewest();
      },
      steppingGuard,
      typeof requestAnimationFrame === 'function'
        ? {
            request: (run) =>
              requestAnimationFrame(() => {
                const finish = beginSteppingFrame();
                try {
                  run();
                } finally {
                  finish();
                }
              }),
            cancel: (id) => cancelAnimationFrame(id),
            end: clearSteppingTarget,
            allow: () => {
              if (!workspaceShortcutsBlocked(new Event('stepping'))) return true;
              // Phone Previous/Next deliberately belong to the finder sheet itself.
              const sheet =
                variant === 'sheet' ? root.current?.closest('[data-shell-overlay]') : null;
              return (
                Boolean(sheet) &&
                [...workspaceShortcutOwners()].every((owner) => sheet!.contains(owner))
              );
            },
          }
        : undefined,
    ),
  );
  const landNewest = useCallback(() => {
    const land = (target: string, options: { replace: boolean; flushSync?: boolean }) => {
      if (`${current.current.pathname}${current.current.search}` !== target)
        navigateRef.current(target, options);
    };
    if (stepping.target) stepping.flush(land);
    else {
      const target = useSteppingActivity.getState().target;
      if (target) land(target, { replace: true, flushSync: true });
    }
  }, [stepping]);
  const resumeNewest = useCallback(() => {
    const target = stepping.target ?? useSteppingActivity.getState().target;
    if (target && `${current.current.pathname}${current.current.search}` !== target)
      navigateRef.current(target, { replace: true, flushSync: true });
  }, [stepping]);
  const [wheelStepper] = useState(createWheelStepper);
  const step = useRef<(direction: number) => boolean>(() => false);
  const stepGroup = useRef<(direction: number) => boolean>(() => false);
  const canStep = useRef<(direction: number, kind: 'entry' | 'group') => boolean>(() => false);
  const stepLocation = () => {
    const pending = (stepping.target ?? useSteppingActivity.getState().target)?.split('?');
    return pending
      ? { pathname: pending[0], search: pending[1] ? `?${pending[1]}` : '' }
      : current.current;
  };
  const stepAt = () => {
    const where = stepLocation();
    const at = Number(where.pathname.split('/')[2]);
    return { where, hash: at, ...placeOf(at, where.search) };
  };
  /** Moves to `target` unless there is none (the scope's end) or the guard refuses. */
  const stepTo = (target: StepTarget | undefined) => {
    if (!target) {
      // A free-spin gesture can reach the category boundary long before its wheel
      // packets stop. Keep pending panel work cancelled until the input rests.
      if (useSteppingActivity.getState().active) pulseStepping();
      return false;
    }
    // Refused before anything moves: the selection, the pending history entry and the timer stay.
    if (!stepping.step(target.from, target.to.path)) return false;
    pulseStepping(landNewest, resumeNewest);
    return true;
  };
  const scopeRoute = (entry: Entry, all: boolean, search: string) =>
    tooltipPath(
      entry.hash,
      search,
      (grouped && scopeValue(entry, all, grouped.firstGroup)) || null,
    );
  step.current = (direction) => {
    const at = stepAt();
    const { list, index } = scopeLists(at.all, at.group);
    return stepTo(
      stepTarget(at.where, direction, list, index, { hash: at.hash, group: at.group }, (next) =>
        scopeRoute(next, at.all, at.where.search),
      ),
    );
  };
  /** The neighbouring group's first entry; in a group scope that changes the scope. */
  const groupTarget = (direction: number) => {
    const at = stepAt();
    const index = grouped?.groupIndex.get(at.group);
    const next = index === undefined ? undefined : grouped?.groups[index + direction];
    return { at, first: next?.entries[0] };
  };
  stepGroup.current = (direction) => {
    const { at, first } = groupTarget(direction);
    return stepTo(first && stepRoute(at.where, first, scopeRoute(first, at.all, at.where.search)));
  };
  canStep.current = (direction, kind) => {
    if (kind === 'group') return groupTarget(direction).first !== undefined;
    const at = stepAt();
    const { list, index } = scopeLists(at.all, at.group);
    const found = index.get(entryKey(at.hash, at.group));
    return found !== undefined && list[found + direction] !== undefined;
  };

  // The list: the current category by default (a weapon's or an activity's entries in a group
  // scope), every category on request. Only an open list needs rows.
  const rows: Row[] = useMemo(() => {
    if (!open) return noRows;
    const all = found.flatMap((group) => group.sections);
    const listed =
      allCategories || !selectedCategory
        ? all
        : all.filter((section) => section.id === selectedCategory.id);
    return listed.flatMap((section) => {
      const grouping = groupedSection(section, data);
      if (!grouping) return section.items.map((item) => plainRow(item, section));
      const own = section.id === selectedCategory?.id && !allCategories;
      const narrow = own && !allGroups && !place.all;
      return groupedRows(section, grouping, { all: !narrow, group: place.group });
    });
  }, [open, found, allCategories, allGroups, selectedCategory, data, place.all, place.group]);
  const currentItem = itemFor(hash, data);
  const currentLabel = currentItem ? listName(currentItem, data) : '';
  const sharedLabel = sharedPerkLabel(hash, data, compendiumSource);
  revealActive.current = () => {
    const layout = listLayout.current;
    if (!layout || pointerHighlight.current || !rows[active]) return;
    const top = active * rowHeight;
    const next = top < layout.top ? top : Math.max(layout.top, top + rowHeight - layout.height);
    if (next !== layout.top) {
      layout.element.scrollTop = next;
      layout.top = next;
    }
    revealedActive.current = active;
    if (rows.length > retainedRowLimit) {
      const bucket = Math.floor(layout.top / rowHeight) * rowHeight;
      setViewport({ top: bucket, height: layout.height });
    }
  };
  useLayoutEffect(() => {
    const element = list.current;
    listLayout.current = null;
    revealedActive.current = null;
    if (!open || !element) return;
    let height = 416;
    let lastTop = -1;
    const scroll = () => {
      if (listLayout.current) listLayout.current.top = element.scrollTop;
      if (rows.length <= retainedRowLimit) return;
      // Fill at every row boundary, before paint, without reading row geometry.
      const top = Math.floor(element.scrollTop / rowHeight) * rowHeight;
      if (top === lastTop) return;
      lastTop = top;
      setViewport({ top, height });
    };
    const measure = ([entry]: ResizeObserverEntry[]) => {
      // The observer already has the laid-out content box. Reading clientHeight
      // here (or on mount) flushes the newly opened finder before it can paint.
      height = entry.contentRect.height;
      listLayout.current = { element, top: element.scrollTop, height };
      // Land on already-laid-out rows before paint. Initial windowing is based
      // on the selected row, so this does not mount a distant second window.
      revealActive.current();
      lastTop = Math.floor(listLayout.current.top / rowHeight) * rowHeight;
    };
    const observer =
      typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(measure);
    listObserver.current = observer ?? null;
    observer?.observe(element);
    if (!observer) listLayout.current = { element, top: 0, height };
    element.addEventListener('scroll', scroll, { passive: true });
    return () => {
      observer?.disconnect();
      listObserver.current = null;
      element.removeEventListener('scroll', scroll);
      if (listLayout.current?.element === element) listLayout.current = null;
    };
  }, [open, rows, rowHeight, setViewport]);

  useLayoutEffect(() => {
    if (!open) return;
    const finish = () => {
      if (!draggingScrollbarRef.current) return;
      const element = list.current;
      // Restore windowing around the landed viewport in the same update that
      // removes the drag surface, so no intermediate spacer can become visible.
      if (element)
        setViewport({
          top: Math.floor(element.scrollTop / rowHeight) * rowHeight,
          height: viewportStore.getSnapshot().height,
        });
      draggingScrollbarRef.current = false;
      setDraggingScrollbar(false);
    };
    window.addEventListener('pointerup', finish, true);
    window.addEventListener('pointercancel', finish, true);
    window.addEventListener('blur', finish);
    return () => {
      window.removeEventListener('pointerup', finish, true);
      window.removeEventListener('pointercancel', finish, true);
      window.removeEventListener('blur', finish);
      finish();
    };
  }, [open, rowHeight, setViewport, viewportStore]);

  // A new route, or leaving the field, restores the current item and an empty query.
  const restore = () => {
    setOpen(false);
    setQuery('');
    setAllCategories(false);
    setAllGroups(false);
  };
  useEffect(() => {
    setOpen(false);
    setQuery('');
    setAllCategories(false);
    setAllGroups(false);
  }, [location.pathname]);
  // The phone sheet shows the list as soon as it opens, and starts clean when it closes.
  useEffect(() => {
    if (variant !== 'sheet') return;
    if (sheetOpen) setOpen(true);
    else {
      setOpen(false);
      setQuery('');
      setAllCategories(false);
      setAllGroups(false);
    }
  }, [variant, sheetOpen]);
  useLayoutEffect(() => {
    if (!open) return;
    pointerHighlight.current = false;
    const index = rows.findIndex(
      (row) => row.hash === hash && (!row.group || row.group === place.group),
    );
    setActive(query.trim() ? 0 : Math.max(0, index));
    // Only a new query, scope or opening resets the highlight; route changes close the list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, query, allCategories, allGroups]);
  useLayoutEffect(() => {
    if (!open || pointerHighlight.current) return;
    const element = list.current;
    if (!element || !rows[active]) return;
    // Let layout finish for the prefilled destination before changing scrollTop.
    // Re-observing schedules a fresh delivery even when the box size is unchanged.
    const observer = listObserver.current;
    if (observer) {
      observer.disconnect();
      observer.observe(element);
    } else revealActive.current();
  }, [open, active, rows, rowHeight]);

  useLayoutEffect(() => {
    // A finder list owns wheel interaction while open. Remove the global
    // cancelable listener entirely so its native scrolling stays compositor-led.
    if (open) return;
    const shiftWheel = (event: WheelEvent) => {
      const wheel = wheelStep(event, {
        swap: swapWheelRef.current,
        grouped: Boolean(groupedRef.current),
      });
      if (!wheel || workspaceShortcutsBlocked(event)) return;
      // The gesture still belongs to stepping at either end of the scope.
      // Letting its default horizontal overscroll escape can navigate Back.
      event.preventDefault();
      if (!canStep.current(wheel.direction, wheel.kind)) {
        // At the boundary the remaining packets still belong to the same gesture.
        // Keep the workspace idle until that physical gesture actually stops.
        if (useSteppingActivity.getState().active) pulseStepping();
        return;
      }
      const stepDirection = wheelStepper.feed(event, event.timeStamp);
      if (stepDirection) (wheel.kind === 'group' ? stepGroup : step).current(stepDirection);
    };
    window.addEventListener('wheel', shiftWheel, { passive: false, capture: true });
    return () => window.removeEventListener('wheel', shiftWheel, true);
  }, [open, wheelStepper]);

  useEffect(() => {
    const element = field.current;
    if (!element) return;
    const wheel = (event: WheelEvent) => {
      if (!event.deltaY || event.ctrlKey || event.metaKey || event.shiftKey) return;
      // An open list scrolls itself; the wheel steps only over the closed field.
      if (openRef.current) return;
      event.preventDefault();
      const direction = wheelStepper.feed(event, event.timeStamp);
      if (direction) step.current(direction);
    };
    const pop = () => stepping.cancel();
    const change = (event: Event) => {
      if (event.target instanceof HTMLSelectElement) stepping.commit();
    };
    const explicit = (event: MouseEvent) => {
      if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey)
        return;
      if (event.target instanceof Element && event.target.closest('a[href]')) stepping.commit();
    };
    element.addEventListener('wheel', wheel, { passive: false });
    window.addEventListener('popstate', pop);
    document.addEventListener('click', explicit, true);
    document.addEventListener('change', change, true);
    return () => {
      element.removeEventListener('wheel', wheel);
      window.removeEventListener('popstate', pop);
      document.removeEventListener('click', explicit, true);
      document.removeEventListener('change', change, true);
      stepping.cancel();
    };
  }, [stepping, wheelStepper]);
  /** True when the navigation went ahead (the guard did not refuse it). */
  function choose(target: number, scopeParam?: string | null): boolean {
    stepping.commit();
    const path = tooltipPath(target, location.search, scopeParam);
    if (!steppingGuard.allow(location.pathname, path)) return false;
    pulseStepping();
    navigate(path);
    return true;
  }
  function commit(row: Row | undefined) {
    if (!row) return;
    restore();
    // A refused (guarded) navigation leaves the route; the field shows the current item again.
    // On the phone the chosen row opens its item and the sheet closes (a refused one stays, so
    // the prompt that explains why is not the only thing on screen).
    // A row of an All list keeps the All scope; a weapon's own rows keep the weapon's.
    const scopeParam =
      grouped && row.group
        ? (scopeValue({ hash: row.hash, group: row.group }, Boolean(row.all), grouped.firstGroup) ??
          null)
        : null;
    if (choose(row.hash, scopeParam) && variant === 'sheet') closeSheet?.();
  }
  const commitRef = useRef(commit);
  commitRef.current = commit;
  const chooseRef = useRef(choose);
  chooseRef.current = choose;
  const heldKey = useRef<{ key: string; release(): void }>();
  const releaseKey = useCallback(() => {
    heldKey.current?.release();
    heldKey.current = undefined;
  }, []);
  useEffect(() => releaseKey, [releaseKey]);
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (['ArrowDown', 'ArrowUp', 'Home', 'End', 'PageDown', 'PageUp'].includes(event.key))
      pointerHighlight.current = false;
    if (event.key === 'Escape') {
      if (!open && !query) return;
      // Restore the current item and its query; the focus stays in the field.
      event.preventDefault();
      event.stopPropagation();
      restore();
      return;
    }
    if (event.altKey || event.ctrlKey || event.metaKey) {
      if (event.altKey && event.key === 'ArrowDown') {
        event.preventDefault();
        setOpen(true);
      }
      return;
    }
    if (event.key === 'F4') {
      event.preventDefault();
      setOpen((value) => !value);
      return;
    }
    if (!open) {
      const paging = (event.key === 'PageDown' || event.key === 'PageUp') && grouped;
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || paging) {
        // Closed, the arrows keep stepping through the category, as the dropdown always did;
        // PageUp/PageDown step the weapons or activities.
        event.preventDefault();
        if (!event.shiftKey) {
          const direction = event.key === 'ArrowDown' || event.key === 'PageDown' ? 1 : -1;
          const moved = (paging ? stepGroup : step).current(direction);
          if (
            (moved || useSteppingActivity.getState().active) &&
            (!event.repeat || heldKey.current?.key !== event.key)
          ) {
            // Replace even an old, already released latch: keyup/blur may have
            // ended it without another React render.
            const previous = heldKey.current;
            const release = holdSteppingKey(event.key);
            previous?.release();
            heldKey.current = { key: event.key, release };
          }
        }
      } else if (event.key === 'Enter') {
        event.preventDefault();
        setOpen(true);
      }
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (rows.length)
        setActive(
          (value) => (value + (event.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length,
        );
    } else if (event.key === 'PageDown' || event.key === 'PageUp') {
      event.preventDefault();
      const page = Math.max(1, Math.floor((listLayout.current?.height ?? 416) / rowHeight));
      const direction = event.key === 'PageDown' ? 1 : -1;
      setActive((value) => Math.max(0, Math.min(rows.length - 1, value + direction * page)));
    } else if (event.key === 'Home' || event.key === 'End') {
      if (event.shiftKey) return;
      // Home/End move the highlight only while the query is empty; otherwise they edit the text.
      if (query) return;
      event.preventDefault();
      setActive(event.key === 'Home' ? 0 : Math.max(0, rows.length - 1));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      if (rows.length) commit(rows[active]);
      else if (query.trim() && grouped && !place.all && !allGroups) setAllGroups(true);
      else if (query.trim() && !allCategories) setAllCategories(true);
    }
  };

  const trimmed = query.trim();
  // A weapon's (or an activity's) own list; widening shows every group of the category.
  const narrowed = Boolean(grouped) && !place.all && !allGroups && !allCategories;
  const scopeName = narrowed
    ? grouped?.byId.get(place.group)?.label
    : allCategories
      ? undefined
      : selectedCategory?.label;
  const widenGroups = grouped && narrowed ? `Search ${grouped.allLabel.toLowerCase()}` : undefined;
  // Shared perks list the other weapon, and a long "entry · kind · hash" needs the room.
  const wideRows =
    place.all || allGroups || allCategories || (narrowed && Boolean(grouped?.owners.size));
  const listbox = open && (
    <div className={styles.popup} data-variant={variant} data-wide={wideRows || undefined}>
      <ul
        ref={list}
        id={listId}
        role="listbox"
        aria-label="Tooltips"
        className={styles.listbox}
        data-windowed={rows.length > 80 || undefined}
        data-scrollbar-drag={draggingScrollbar || undefined}
        data-eager-rows={rows.length <= retainedRowLimit || undefined}
        onPointerDown={(event) => {
          const element = event.currentTarget;
          if (
            event.button === 0 &&
            event.target === element &&
            event.nativeEvent.offsetX >= element.clientWidth
          ) {
            // Bounded lists are already laid out; larger lists synchronously
            // fill a smaller window as the native scrollbar moves.
            pointerHighlight.current = true;
            draggingScrollbarRef.current = true;
            setDraggingScrollbar(true);
          }
        }}
        style={
          {
            '--finder-row-height': `${rowHeight}px`,
            position: rows.length > retainedRowLimit ? 'relative' : undefined,
          } as CSSProperties
        }
      >
        <FinderOptions
          rows={rows}
          active={active}
          hash={hash}
          group={place.group}
          base={base}
          query={query}
          viewportStore={viewportStore}
          listLayout={listLayout}
          pointerHighlight={pointerHighlight}
          revealedActive={revealedActive}
          data={data}
          drafts={drafts}
          source={compendiumSource}
          allCategories={allCategories}
          onActive={hoverActive}
          onCommit={commitRef}
          rowHeight={rowHeight}
          twoLine={touchRows}
          narrow={narrow}
        />
      </ul>
      {!rows.length && (
        <p className={styles.empty}>
          No tooltips match “{trimmed}”{scopeName ? ` in ${scopeName}` : ''}.
          {widenGroups && (
            <>
              {' '}
              <button
                type="button"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => setAllGroups(true)}
              >
                {widenGroups}
              </button>
            </>
          )}
          {!allCategories && (
            <>
              {' '}
              <button
                type="button"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => setAllCategories(true)}
              >
                Search all categories
              </button>
            </>
          )}{' '}
          <button
            type="button"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => {
              setQuery('');
              setAllCategories(false);
              setAllGroups(false);
            }}
          >
            Clear
          </button>
        </p>
      )}
      {rows.length > 0 && trimmed && widenGroups && (
        <button
          type="button"
          className={styles.widen}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => setAllGroups(true)}
        >
          {widenGroups}
        </button>
      )}
      {rows.length > 0 && trimmed && !allCategories && (
        <button
          type="button"
          className={styles.widen}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => setAllCategories(true)}
        >
          Search all categories
        </button>
      )}
    </div>
  );
  const sheet = variant === 'sheet';
  const categoryNode = useMemo(
    () => (
      <select
        aria-label="Category"
        className={styles.category}
        value={selectedCategory?.id ?? ''}
        disabled={!sections.length}
        onChange={(event) => {
          // A new category opens its first entry, in the scope of every group.
          const next = sections.find((category) => category.id === event.target.value);
          const grouping = next && groupedSection(next, data);
          const first = grouping ? grouping.all[0] : next?.items[0];
          if (!first) return;
          const scope = grouping ? scopeValue(first as Entry, true, grouping.firstGroup) : null;
          chooseRef.current(first.hash, scope);
        }}
      >
        {!sections.length && <option value="">No matching categories</option>}
        {groups.map((group) => (
          <optgroup key={group.name} label={group.name}>
            {group.sections.map((category) => (
              <option key={category.id} value={category.id}>
                {category.label}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
    ),
    [groups, sections, selectedCategory?.id, data],
  );
  const groupOptions = useMemo(
    () =>
      grouped && [
        <option key="all" value="all">
          {grouped.allLabel}
        </option>,
        ...grouped.groups.map((group) => (
          <option key={group.id} value={group.id}>
            {group.label}
          </option>
        )),
      ],
    [grouped],
  );
  const groupValue = grouped && !place.all && grouped.byId.has(place.group) ? place.group : 'all';
  const groupNode = grouped && (
    <select
      aria-label={grouped.groupLabel}
      title={grouped.byId.get(groupValue)?.label ?? grouped.allLabel}
      className={styles.group}
      value={groupValue}
      onChange={(event) => {
        const id = event.target.value;
        const target = id === 'all' ? undefined : grouped.byId.get(id)?.entries[0];
        // "All" widens the scope and keeps the item; a group opens its first entry.
        if (id === 'all') chooseRef.current(hash, scopeValue(entry, true, grouped.firstGroup));
        else if (target)
          chooseRef.current(target.hash, scopeValue(target, false, grouped.firstGroup) ?? null);
      }}
    >
      {groupOptions}
    </select>
  );
  const neighbourGroup = (direction: number) => {
    const at = grouped?.groupIndex.get(place.group);
    return at === undefined ? undefined : grouped?.groups[at + direction];
  };
  const entryKeys = grouped && swapWheel ? 'Alt+Shift' : 'Shift';
  const groupKeys = swapWheel ? 'Shift' : 'Alt+Shift';
  const positionNode = (
    <span className={styles.position} role="status">
      {positionLabel(position, grouped ? selectedCategory?.label : undefined)}
    </span>
  );
  const comboNode = (
    <div
      ref={root}
      className={styles.combo}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) releaseKey();
        // The sheet keeps its list open while the sheet is; only the header form closes on blur.
        if (!sheet && !event.currentTarget.contains(event.relatedTarget)) restore();
      }}
    >
      <div className={styles.field}>
        <input
          ref={field}
          type="text"
          role="combobox"
          aria-label="Tooltip"
          aria-expanded={open}
          aria-controls={open ? listId : undefined}
          aria-activedescendant={open && rows[active] ? optionId(rows[active]) : undefined}
          aria-autocomplete="list"
          aria-haspopup="listbox"
          aria-describedby="tooltip-stepping-help"
          autoComplete="off"
          spellCheck={false}
          className={styles.input}
          title={sharedLabel}
          placeholder={open ? currentLabel : 'Find a tooltip'}
          value={open ? query : currentLabel}
          disabled={!items.length && !found.length}
          onFocus={(event) => event.currentTarget.select()}
          onClick={() => setOpen(true)}
          onChange={(event) => {
            setQuery(event.target.value);
            setOpen(true);
          }}
          onKeyDown={onKeyDown}
        />
        <FinderDraftIndicator hash={hash} data={data} />
      </div>
      {listbox}
      <span role="status" className="sr-only">
        {open ? `${rows.length} tooltip${rows.length === 1 ? '' : 's'}` : ''}
      </span>
    </div>
  );
  return (
    <section aria-label="Tooltip navigation" className={styles.finder} data-variant={variant}>
      {sheet ? (
        <>
          {comboNode}
          <div className={styles.sheetBar}>
            {categoryNode}
            {groupNode && (
              <div
                role="group"
                aria-label={`Step ${grouped?.groupLabel.toLowerCase()}`}
                className={styles.groupRow}
              >
                <button
                  type="button"
                  aria-label={`Previous ${grouped?.groupLabel.toLowerCase()}`}
                  disabled={!neighbourGroup(-1)}
                  onClick={() => stepGroup.current(-1)}
                >
                  ‹
                </button>
                {groupNode}
                <button
                  type="button"
                  aria-label={`Next ${grouped?.groupLabel.toLowerCase()}`}
                  disabled={!neighbourGroup(1)}
                  onClick={() => stepGroup.current(1)}
                >
                  ›
                </button>
              </div>
            )}
            {/* Touch screens have no Shift+wheel: one compact row steps through the category. */}
            <div role="group" aria-label="Step within category" className={styles.stepper}>
              <button
                type="button"
                aria-label="Previous tooltip"
                disabled={position.previous === undefined}
                onClick={() => step.current(-1)}
              >
                ‹
              </button>
              {positionNode}
              <button
                type="button"
                aria-label="Next tooltip"
                disabled={position.next === undefined}
                onClick={() => step.current(1)}
              >
                ›
              </button>
            </div>
          </div>
        </>
      ) : (
        <>
          {categoryNode}
          {groupNode}
          {comboNode}
          {positionNode}
        </>
      )}
      {sharedLabel && (
        <small role="note" className={sheet ? styles.note : 'sr-only'}>
          {sharedLabel}
        </small>
      )}
      <small id="tooltip-stepping-help" className="sr-only">
        Type to search. {entryKeys}+Scroll anywhere steps within this category and stops at its
        ends; the arrow keys step too while the list is closed.
        {grouped &&
          ` ${groupKeys}+Scroll and Page Up/Down step ${grouped.groupLabel.toLowerCase()}s, stopping at the ends.`}{' '}
        * = unsaved draft.
      </small>
    </section>
  );
});
