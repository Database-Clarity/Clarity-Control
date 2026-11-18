import {
  FinderWorklistScope,
  FinderWorklistRow,
  finderWorklistKey,
  useFinderWorklists,
} from '../queue/FinderWorklists';
import { LoadingSkeleton, useSkeletonVisible } from '../../ui/Skeleton';
import { useGlobalCatalog, useGlobalHover } from '../globals/useGlobals';
import { globalPath, type GlobalDefinition } from '../globals/model';
import { globalsEnabled } from '../../services/globalsFlag';
import {
  aggregateGlobalRoute,
  globalEntryPath,
  globalIdOf,
  identityDefinitions,
  useGlobalIdentities,
  type GlobalIdentity,
} from '../../stores/globalIdentities';
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
  type ReactNode,
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
  sharesAllOwners,
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
import { FinderPicker, type PickerSection } from './FinderPicker';
import { FinderIcon } from './FinderIcon';
import { FinderMarkers } from './FinderMarkers';
import {
  markedRouteCategory,
  markedRowScope,
  markedScopeValue as scopeValue,
} from '../marks/finder';
import { FinderEntryMarks } from '../marks/FinderEntryMarks';
import type { MarkDisplay } from '../marks/finder';
import { useMarkedFinder } from '../marks/useMarkedFinder';
import { MarkedWorkThrough } from '../marks/queue';
import { useLeftQueue } from '../queue/useQueue';
import { FinderMarkGroup } from '../marks/FinderMarkGroup';
import { prepareFinderMarkers, rollupFinderMarkers, type MarkerIndex } from './finderMarkerState';
import { defaultLanguage } from '../tooltip/language';
import { WorkspaceLanguageContext } from '../tooltip/WorkspaceLanguage';
import { useAuthStore } from '../../stores/auth';
import { exoticArmourRowIcon, groupIcon } from './groupIcons';
import {
  clearStepStates,
  finishQueue,
  flushPassed,
  notePassed,
  pendingVisit,
  queueEdges,
  queueStepTarget,
  rememberOrigin,
  rememberStep,
  stepStateFor,
  useQueueStepper,
  type QueueStepper,
} from '../queue/worklistStepping';

// Stepping asks the preview leave guard before it moves anything; see createStepping.
const pathname = (route: string) => route.split('?')[0];
const noIdentities: Record<string, GlobalIdentity> = {};
const steppingGuard: SteppingGuard = {
  allow: (from, to) => usePreviewReviewStore.getState().requestLeave(pathname(from), pathname(to)),
  epoch: () => usePreviewReviewStore.getState().epoch,
  authorized: (run) => usePreviewReviewStore.getState().authorized(run),
};

interface Row {
  global?: GlobalDefinition;
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
  /**
   * The row needs no shared-perk mark: its name already lists several pieces, or every entry of
   * its category shares the same owners (sharesAllOwners).
   */
  listsPieces?: boolean;
  /** An Exotic Armor row's piece icon ('' = empty box); undefined = the item's own icon. */
  icon?: string;
  category: string;
}

const noItems: never[] = [];
const noMarkers: MarkerIndex = new Map();
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
  markerIndex,
  marksIndex,
  source,
  allCategories,
  onActive,
  onCommit,
  total,
  virtual,
  rowHeight,
  twoLine,
  narrow = false,
  hashQuery,
}: {
  row: Row;
  index: number;
  id: string;
  current: boolean;
  active: boolean;
  data: EditorData;
  markerIndex: MarkerIndex;
  marksIndex: ReadonlyMap<number, readonly MarkDisplay[]>;
  source: ReturnType<typeof useCompendiumStore.getState>['data'];
  allCategories: boolean;
  onActive(index: number): void;
  onCommit: { current(row: Row): void };
  total: number;
  virtual: boolean;
  rowHeight: number;
  /** The phone sheet shows a grouped row as entry over "group · kind · hash". */
  twoLine: boolean;
  /** A screen under 21rem wide: every row is two lines, the name over its context. */
  narrow?: boolean;
  /** A digits-only search: rows whose hash it matches show the hash. */
  hashQuery: string;
}) {
  const globalContents = useGlobalHover(row.global, data);
  const item = itemFor(row.hash, data);
  const markerHashes = useMemo(() => variantHashes(row.hash, data), [row.hash, data]);
  const entryMarks = row.global ? undefined : marksIndex.get(row.hash);
  const shared = sharedPerkLabel(row.hash, data, source);
  const frames = frameGroupSize(row.hash, data);
  const enhanced = enhancedPairs(row.hash, data).length > 0;
  const stacked = twoLine && row.entry !== undefined;
  // The hash shows only when the search matched it (owner: the manifest id is not relevant here).
  const tail = [
    stacked && row.all && row.name,
    row.kind,
    hashQuery && String(row.hash).includes(hashQuery) && String(row.hash),
    row.extra,
    shared && !row.listsPieces && !row.group && 'shared perk',
    frames > 1 && `×${frames}`,
    item && allCategories && row.category,
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <FinderOptionView
      id={id}
      index={index}
      current={current}
      active={active}
      total={total}
      virtual={virtual}
      rowHeight={rowHeight}
      twoLine={twoLine}
      narrow={narrow}
      stacked={stacked}
      title={globalContents ?? shared}
      global={Boolean(row.global)}
      grouped={row.group}
      name={(stacked ? row.entry : row.name) ?? ''}
      category={row.category}
      perk={row.perk}
      allCategories={allCategories}
      enhanced={enhanced}
      tail={tail}
      onActive={onActive}
      onCommit={() => onCommit.current(row)}
      icon={
        <FinderWorklistRow
          hash={row.hash}
          name={row.entry ?? row.name}
          global={Boolean(row.global)}
        >
          <FinderIcon icon={row.icon ?? item?.icon} />
        </FinderWorklistRow>
      }
      markers={
        <>
          <FinderMarkers hashes={markerHashes} flags={row.global ? 0 : markerIndex.get(row.hash)} />
          {!!entryMarks?.length && <FinderEntryMarks entries={entryMarks} />}
        </>
      }
    />
  );
});

export function FinderOptionView({
  id,
  index,
  current,
  active,
  total,
  virtual,
  rowHeight,
  narrow = false,
  stacked,
  title,
  global,
  grouped,
  name,
  category,
  perk,
  allCategories,
  enhanced,
  tail,
  onActive,
  onCommit,
  icon,
  markers,
}: {
  id: string;
  index: number;
  current: boolean;
  active: boolean;
  total: number;
  virtual: boolean;
  rowHeight: number;
  twoLine: boolean;
  narrow?: boolean;
  stacked: boolean;
  title?: string;
  global: boolean;
  grouped?: string;
  name: string;
  category?: string;
  perk?: string;
  allCategories: boolean;
  enhanced: boolean;
  tail: string;
  onActive(index: number): void;
  onCommit(): void;
  icon: ReactNode;
  markers: ReactNode;
}) {
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
      title={title}
      className={styles.option}
      data-two-line={(!global && (stacked || narrow)) || undefined}
      data-grouped={grouped || undefined}
      onMouseDown={(event) => event.preventDefault()}
      onMouseMove={() => !active && onActive(index)}
      onClick={() => onCommit()}
    >
      <span className={styles.mark} aria-hidden="true"></span>
      {icon}
      <span className={styles.name}>{name}</span>
      {global ? (
        allCategories && <small>{category}</small>
      ) : (
        <small>
          {enhanced && (
            <span className={styles.enhanced} title="Has an enhanced version">
              <EnhancedArrow />
            </span>
          )}
          {!stacked && perk && <span className={styles.perk}>{perk}</span>}
          {tail && (
            <span className={styles.tail}>
              {!stacked && perk && ' · '}
              {tail}
            </span>
          )}
        </small>
      )}
      <span className={styles.markers}>{markers}</span>
    </li>
  );
}

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

/**
 * The whole text of the highlighted row when its name or context is cut off, in the finder's own
 * surface (not a native title). It follows the highlight (pointer or keys) once it has moved in
 * this opening, and hides while the list scrolls. Screen readers already get the whole option.
 */
function FinderHint({
  list,
  activeId,
}: {
  list: MutableRefObject<HTMLUListElement | null>;
  activeId: string | undefined;
}) {
  const [hint, setHint] = useState<{
    name: string;
    context: string;
    top: number;
    above: boolean;
  }>();
  const opened = useRef(activeId);
  useEffect(() => {
    const element = list.current;
    const hide = () => setHint(undefined);
    element?.addEventListener('scroll', hide, { passive: true });
    return () => element?.removeEventListener('scroll', hide);
  }, [list]);
  useEffect(() => {
    const element = list.current;
    const row = activeId && activeId !== opened.current ? document.getElementById(activeId) : null;
    opened.current = undefined;
    const parts = row?.querySelectorAll<HTMLElement>(
      `.${styles.name}, small, .${styles.perk}, .${styles.tail}`,
    );
    const area = element?.offsetParent;
    if (!row || !area || ![...parts!].some((part) => part.scrollWidth > part.clientWidth + 1)) {
      setHint(undefined);
      return;
    }
    const at = row.getBoundingClientRect();
    const top = area.getBoundingClientRect().top;
    // Below the row, or above it when the list's end is too close.
    const above = at.bottom + 3 * at.height > element.getBoundingClientRect().bottom;
    setHint({
      name: row.querySelector(`.${styles.name}`)?.textContent ?? '',
      context: row.querySelector('small')?.textContent ?? '',
      top: (above ? at.top : at.bottom) - top,
      above,
    });
  }, [list, activeId]);
  if (!hint) return null;
  return (
    <div
      className={styles.hint}
      aria-hidden="true"
      style={{ top: hint.top, transform: hint.above ? 'translateY(-100%)' : undefined }}
    >
      {hint.name}
      {hint.context && <small>{hint.context}</small>}
    </div>
  );
}

/**
 * About the width, in rem, the longest row needs to show whole: its name (0.8125rem text), its
 * context (0.75rem), and the icon, gaps, markers, and scrollbar. Characters average ~0.55em.
 */
function rowsWidth(rows: Row[], allCategories: boolean): number {
  let widest = 0;
  for (const row of rows) {
    const context =
      (row.perk?.length ?? 0) +
      (row.kind?.length ?? 0) +
      (row.extra?.length ?? 0) +
      (allCategories ? row.category.length : 0);
    widest = Math.max(widest, row.name.length * 0.8125 + (context + 9) * 0.75);
  }
  return widest * 0.55 + 8.5;
}

const noRows: Row[] = [];
const plainRow = (item: CategorySection['items'][number], section: CategorySection): Row => ({
  hash: item.hash,
  key: entryKey(item.hash, item.global?.name ?? ''),
  group: item.global?.name ?? '',
  global: item.global,
  // The row names the piece and keeps the perk on the right, so a set's rows stay
  // tellable apart even where the name column truncates.
  name: item.piece ?? item.name,
  perk: item.perkName,
  listsPieces: (item.pieces ?? 1) > 1 || sharesAllOwners(section.items),
  icon: exoticArmourRowIcon(item),
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
const LoadedTooltipNavigation = memo(function LoadedTooltipNavigation({
  data,
  variant = 'bar',
}: {
  data: EditorData;
  variant?: 'bar' | 'sheet';
}) {
  useLeftQueue();
  const compendiumSource = useCompendiumStore((state) => state.data);
  const sheetOpen = useContext(FinderSheetContext);
  const closeSheet = useContext(FinderSheetCloseContext);
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const keepGlobalCategoryOpen = useRef(false);
  const worklists = useFinderWorklists(open);
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
  const swapWheel = useSettingsStore((state) => state.settings.finderWheel) === 'groups';
  const swapWheelRef = useRef(swapWheel);
  swapWheelRef.current = swapWheel;
  // Worklist stepping: with a Work-through queue active, the stepping gestures step the queue.
  const worklistStepping = useSettingsStore((state) => state.settings.worklistStepping);
  const worklistSteppingRef = useRef(worklistStepping);
  worklistSteppingRef.current = worklistStepping;
  // "q" + whether the queue can step back and forward; '' when the gestures step the list.
  const queueMode = useQueueStepper((state) => (worklistStepping ? queueEdges(state.current) : ''));
  const base = useId();
  const listId = `${base}-list`;
  const optionId = (row: Row) => `${base}-o${row.key}`;
  const finderLocation = useLocation();
  const globalRole = useAuthStore((state) => state.user?.role);
  const authLoading = useAuthStore((state) => state.loading);
  const globalIdentities = useGlobalIdentities((state) =>
    globalsEnabled && globalRole ? state.identities : noIdentities,
  );
  /** The route in aggregate terms: `/globals/:id` reads as `/t/2?global=Name` (or 3). */
  const finderRoute = (path: string, search: string) =>
    (globalsEnabled && aggregateGlobalRoute(path, search, globalIdentities)) || {
      hash: Number(path.split('/')[2]),
      search,
    };
  /** A declaration's route: by stable ID once the globals catalogue knows it (globals on). */
  const declarationPath = (definition: GlobalDefinition, search: string) => {
    const id = globalsEnabled
      ? globalIdOf(globalIdentities, definition.kind, definition.name)
      : undefined;
    const lang = new URLSearchParams(search).get('lang');
    return id
      ? `/globals/${id}${lang ? `?lang=${encodeURIComponent(lang)}` : ''}`
      : globalPath(definition, search);
  };
  const catalogActive =
    open ||
    new URLSearchParams(finderLocation.search).has('global') ||
    (globalsEnabled && globalEntryPath.test(finderLocation.pathname));
  const aggregateDefinitions = useGlobalCatalog(data, catalogActive);
  const identitiesStatus = useGlobalIdentities((state) => (globalsEnabled ? state.status : 'idle'));
  const identitiesError = useGlobalIdentities((state) => (globalsEnabled ? state.error : ''));
  useEffect(() => {
    // Globals on: the finder lists authoritative entries, so load their catalogue when it is needed.
    if (
      import.meta.env.VITE_GLOBALS_ENABLED === '1' &&
      !authLoading &&
      globalRole &&
      catalogActive &&
      useGlobalIdentities.getState().status === 'idle'
    )
      void import('../../stores/globalEntries').then((module) => module.loadGlobalIdentities());
  }, [catalogActive, authLoading, globalRole]);
  // Authoritative entries include new and renamed definitions of every global kind.
  const globalDefinitions = useMemo(
    () =>
      globalsEnabled && !globalRole
        ? []
        : globalsEnabled
          ? identityDefinitions(globalIdentities)
          : aggregateDefinitions,
    [aggregateDefinitions, globalIdentities, globalRole],
  );
  const baseGroups = useMemo(
    () => navigationGroups(data, '', globalDefinitions, globalsEnabled && !!globalRole),
    [data, globalDefinitions, globalRole],
  );
  const baseFound = useMemo(
    () => (query.trim() ? navigationGroups(data, query, globalDefinitions) : baseGroups),
    [data, baseGroups, query, globalDefinitions],
  );
  const { groups, found, marksIndex, loadMarkedSection } = useMarkedFinder(
    baseGroups,
    baseFound,
    query,
    finderLocation.search,
  );
  const navigate = useNavigate();
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;
  const location = useLocation();
  const user = useAuthStore((state) => state.user);
  const rememberedLanguage = useContext(WorkspaceLanguageContext)?.[0];
  const language = defaultLanguage(user, new URLSearchParams(location.search), rememberedLanguage);
  const [preparedMarkers, setPreparedMarkers] = useState<{
    data: EditorData;
    source: typeof compendiumSource;
    language: typeof language;
    index: MarkerIndex;
  }>();
  useEffect(() => {
    let cancelled = false;
    void prepareFinderMarkers(data, compendiumSource, language).then((index) => {
      if (!cancelled) setPreparedMarkers({ data, source: compendiumSource, language, index });
    });
    return () => {
      cancelled = true;
    };
  }, [data, compendiumSource, language]);
  const markerIndex =
    preparedMarkers?.data === data &&
    preparedMarkers.source === compendiumSource &&
    preparedMarkers.language === language
      ? preparedMarkers.index
      : noMarkers;
  const urgentTarget = useSteppingActivity((state) => state.target);
  const { hash, search: routeSearch } = finderRoute(
    pathname(urgentTarget ?? location.pathname),
    urgentTarget ? (urgentTarget.split('?')[1] ?? '') : location.search,
  );
  const sections = useMemo(() => groups.flatMap((group) => group.sections), [groups]);
  const globalName = new URLSearchParams(routeSearch).get('global');
  const selectedGlobal = globalDefinitions.find(
    (entry) => entry.hash === hash && entry.name === globalName,
  );
  const selectedCategory =
    sections.find(
      (category) =>
        category.id ===
        (markedRouteCategory(hash, routeSearch, sections) ??
          (globalsEnabled && (hash === 1 || hash === 2 || hash === 3)
            ? `globals-${hash === 1 ? 'exports' : hash === 2 ? 'variables' : 'titles'}`
            : selectedGlobal
              ? `globals-${selectedGlobal.kind}`
              : finderCategoryId(classifiedCategory(itemFor(hash, data), data)?.id ?? ''))),
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
    const list: Entry[] = grouped
      ? []
      : items.map((item) => ({ hash: item.hash, group: item.global?.name ?? '' }));
    return { list, index: new Map(list.map((entry, i) => [keyOf(entry), i])) };
  }, [grouped, items]);
  /** The scope and group of a route: from `?g=`, else the item's first owner. */
  const placeOf = (itemHash: number, search: string) => {
    if (!grouped)
      return {
        all: false,
        group: selectedCategory?.id.startsWith('globals-')
          ? (new URLSearchParams(search).get('global') ?? '')
          : '',
      };
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
  const current = useRef({
    pathname: location.pathname,
    search: location.search,
    state: location.state as unknown,
  });
  current.current = {
    pathname: location.pathname,
    search: location.search,
    state: location.state as unknown,
  };
  // Stepping lands and commits plain paths; a route a worklist gesture stepped to (and the
  // gesture's origin) keeps its queue visit in the history entry's state. Landings flush; the
  // commit first restores the origin (replace, no flush), then pushes the destination.
  const go = (target: string, options: { replace: boolean; flushSync?: boolean }) => {
    const saved = stepStateFor(target, options.replace && !options.flushSync);
    navigateRef.current(target, saved ? { ...options, state: saved.state } : options);
  };
  const goRef = useRef(go);
  goRef.current = go;
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
    Math.round(
      (touchRows
        ? tap + (narrow && !(selectedGlobal && !allCategories) ? 18 * scale : 0)
        : 28 * scale) * 64,
    ) / 64;
  const [viewportStore] = useState(createFinderViewport);
  const setViewport = viewportStore.set;
  const root = useRef<HTMLDivElement>(null);
  const openRef = useRef(open);
  openRef.current = open;
  const [stepping] = useState(() =>
    createStepping(
      (target, options) => {
        if (!options.flushSync) return goRef.current(target, options);
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
            end: (committed) => {
              flushPassed();
              clearSteppingTarget(committed);
            },
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
        goRef.current(target, options);
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
      goRef.current(target, { replace: true, flushSync: true });
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
    const route = finderRoute(where.pathname, where.search);
    return { where, hash: route.hash, ...placeOf(route.hash, route.search) };
  };
  /**
   * Moves to `target` unless there is none (the scope's end) or the guard refuses. `state` is the
   * queue visit of a worklist step.
   */
  const stepTo = (target: StepTarget | undefined, state?: unknown) => {
    if (!target) {
      // A free-spin gesture can reach the category boundary long before its wheel
      // packets stop. Keep pending panel work cancelled until the input rests.
      if (useSteppingActivity.getState().active) pulseStepping();
      return false;
    }
    if (!stepping.target && useSteppingActivity.getState().target === undefined) clearStepStates();
    const here = `${current.current.pathname}${current.current.search}`;
    if (state !== undefined && target.from === here) rememberOrigin(here, current.current.state);
    rememberStep(target.to.path, state);
    // Refused before anything moves: the selection, the pending history entry and the timer stay.
    if (!stepping.step(target.from, target.to.path)) return false;
    pulseStepping(landNewest, resumeNewest);
    return true;
  };
  const scopeRoute = (entry: Entry, all: boolean, search: string) =>
    selectedCategory?.id.startsWith('globals-')
      ? declarationPath(
          globalDefinitions.find(
            (definition) => definition.hash === entry.hash && definition.name === entry.group,
          )!,
          search,
        )
      : tooltipPath(
          entry.hash,
          search,
          (grouped && scopeValue(entry, all, grouped.firstGroup)) || null,
        );
  /** The stepping key being handled is an auto-repeat (the key is held). */
  const keyRepeat = useRef(false);
  const queueStepper = () =>
    worklistSteppingRef.current ? useQueueStepper.getState().current : null;
  /** The queue item a gesture is on: its newest pending step, else the route's own. */
  const queueKey = (stepper: QueueStepper) => {
    const pending = pendingVisit(stepping.target ?? useSteppingActivity.getState().target);
    return pending?.id === stepper.queue.id ? pending.key : stepper.visit.key;
  };
  const queueTarget = (stepper: QueueStepper, direction: number) => {
    const key = queueKey(stepper);
    const found = queueStepTarget(stepper, key, direction);
    // Next past the last item ends the queue, but only as a fresh gesture on the route's own item:
    // a spin or a held key (its repeats, even after the history commit) stops on the last item.
    if (
      found?.kind === 'finish' &&
      (key !== stepper.visit.key ||
        keyRepeat.current ||
        stepping.target ||
        useSteppingActivity.getState().active)
    )
      return undefined;
    return found;
  };
  const stepQueue = (stepper: QueueStepper, direction: number) => {
    const found = queueTarget(stepper, direction);
    if (found?.kind === 'finish') {
      finishQueue(stepper, stepper.visit.key);
      return true;
    }
    const key = queueKey(stepper);
    const where = stepLocation();
    const moved = stepTo(
      found && stepRoute(where, { hash: found.item.hash, group: '' }, found.path),
      found?.state,
    );
    if (moved && direction > 0) notePassed(stepper.queue.id, key);
    return moved;
  };
  step.current = (direction) => {
    const stepper = queueStepper();
    if (stepper) return stepQueue(stepper, direction);
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
    // A queue has no groups: every stepping gesture steps its items.
    const stepper = queueStepper();
    if (stepper) return stepQueue(stepper, direction);
    const { at, first } = groupTarget(direction);
    return stepTo(first && stepRoute(at.where, first, scopeRoute(first, at.all, at.where.search)));
  };
  canStep.current = (direction, kind) => {
    const stepper = queueStepper();
    if (stepper) return queueTarget(stepper, direction) !== undefined;
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
  const currentLabel = selectedGlobal?.name ?? (currentItem ? listName(currentItem, data) : '');
  const sharedLabel = sharedPerkLabel(hash, data, compendiumSource);
  revealActive.current = () => {
    const layout = listLayout.current;
    if (!layout || pointerHighlight.current || !rows[active]) return;
    const top = active * rowHeight;
    // A list shorter than one row (a phone at a large scale with the keyboard up) keeps the
    // row's top, its name, in view.
    const next =
      top < layout.top || rowHeight > layout.height
        ? top
        : Math.max(layout.top, top + rowHeight - layout.height);
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
    keepGlobalCategoryOpen.current = false;
    setOpen(false);
    setQuery('');
    setAllCategories(false);
    setAllGroups(false);
  };
  // The open phone finder keeps its list: a new category, group, or Previous/Next shows the new
  // place in it (the highlight follows below).
  const keepListRef = useRef(false);
  keepListRef.current = variant === 'sheet' && sheetOpen;
  useEffect(() => {
    const globalRoute =
      globalEntryPath.test(location.pathname) || /^\/t\/[23]$/.test(location.pathname);
    if (!keepListRef.current && !(keepGlobalCategoryOpen.current && globalRoute)) setOpen(false);
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
  useEffect(() => {
    const returned = (
      location.state as { workThroughReturn?: { type?: unknown; query?: unknown } } | null
    )?.workThroughReturn;
    if (typeof returned?.type !== 'string' || typeof returned.query !== 'string') return;
    setQuery(returned.query);
    setOpen(true);
  }, [location.key, location.state]);
  const sheetPlace = variant === 'sheet' ? `${hash}:${place.group}` : '';
  useLayoutEffect(() => {
    if (!open) return;
    pointerHighlight.current = false;
    const index = rows.findIndex(
      (row) => row.hash === hash && (!row.group || row.group === place.group),
    );
    setActive(query.trim() ? 0 : Math.max(0, index));
    // Only a new query, scope or opening resets the highlight; route changes close the list
    // (the open phone finder keeps it, and its highlight moves to the new item).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, query, allCategories, allGroups, sheetPlace]);
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
  function choose(target: number, scopeParam?: string | null, global?: GlobalDefinition): boolean {
    keepGlobalCategoryOpen.current = false;
    stepping.commit();
    const path = global
      ? declarationPath(global, location.search)
      : tooltipPath(target, location.search, scopeParam);
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
      markedRowScope(row) ??
      (grouped && row.group
        ? (scopeValue({ hash: row.hash, group: row.group }, Boolean(row.all), grouped.firstGroup) ??
          null)
        : null);
    if (choose(row.hash, scopeParam, row.global) && variant === 'sheet') closeSheet?.();
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
    if (finderWorklistKey(event, worklists, open, rows[active])) return;
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
      const paging =
        (event.key === 'PageDown' || event.key === 'PageUp') && (grouped || queueMode !== '');
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || paging) {
        // Closed, the arrows keep stepping through the category, as the dropdown always did;
        // PageUp/PageDown step the weapons or activities.
        event.preventDefault();
        if (!event.shiftKey) {
          const direction = event.key === 'ArrowDown' || event.key === 'PageDown' ? 1 : -1;
          keyRepeat.current = event.repeat;
          let moved: boolean;
          try {
            moved = (paging ? stepGroup : step).current(direction);
          } finally {
            keyRepeat.current = false;
          }
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
  const hashQuery = /^\d+$/.test(trimmed) ? trimmed : '';
  // The header list widens to show its rows whole, up to the viewport: about the width the
  // longest row needs (estimated, as long lists render only the rows in view), never narrower
  // within one opening, so typing does not make it jump. It is sized when the list opens and when
  // its scope changes (category, group, all groups, all categories, or the query emptying), never
  // per keystroke: rows a query filters out of a scope are never wider than the scope's.
  const sheetList = variant === 'sheet';
  const emptyQuery = !trimmed;
  const sizedRows = useRef(rows);
  sizedRows.current = rows;
  const widest = useRef(0);
  useLayoutEffect(() => {
    if (!open || sheetList) {
      widest.current = 0;
      return;
    }
    const popup = root.current?.querySelector<HTMLElement>(`.${styles.popup}`);
    const needed = rowsWidth(sizedRows.current, allCategories);
    if (!popup || !root.current || (widest.current && needed <= widest.current)) return;
    widest.current = Math.max(widest.current, needed);
    const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
    const field = root.current.getBoundingClientRect();
    const viewport = document.documentElement.clientWidth;
    const edge = 0.5 * rem;
    const width = Math.min(
      Math.max(field.width, 30 * rem, widest.current * rem),
      viewport - 2 * edge,
    );
    // Under the field, moved left only as far as the viewport's right edge needs.
    const left = Math.max(edge - field.left, Math.min(0, viewport - edge - field.left - width));
    popup.style.width = `${width}px`;
    popup.style.left = `${left}px`;
  }, [
    open,
    sheetList,
    selectedCategory?.id,
    place.group,
    place.all,
    allGroups,
    allCategories,
    emptyQuery,
  ]);
  const listbox = open && (
    <FinderWorklistScope controller={worklists} className={styles.popup} data-variant={variant}>
      {variant === 'bar' && (
        <FinderMarkGroup
          grouped={grouped}
          hash={hash}
          group={place.group}
          all={place.all}
          choose={chooseRef.current}
        />
      )}
      {variant === 'bar' && (
        <MarkedWorkThrough
          data={data}
          group={place.group}
          all={place.all}
          query={query}
          onStart={restore}
        />
      )}
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
          markerIndex={markerIndex}
          marksIndex={marksIndex}
          source={compendiumSource}
          allCategories={allCategories}
          onActive={hoverActive}
          onCommit={commitRef}
          rowHeight={rowHeight}
          twoLine={touchRows}
          narrow={narrow}
          hashQuery={hashQuery}
        />
      </ul>
      <FinderHint list={list} activeId={rows[active] ? optionId(rows[active]) : undefined} />
      {identitiesStatus === 'loading' && (
        <p role="status" className={styles.empty}>
          Loading globals…
        </p>
      )}
      {identitiesStatus === 'failed' && (
        <div role="alert" className={styles.empty}>
          {identitiesError}{' '}
          <button
            type="button"
            onClick={() =>
              void import('../../stores/globalEntries').then((module) =>
                module.loadGlobalIdentities(true),
              )
            }
          >
            Retry globals
          </button>
        </div>
      )}
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
    </FinderWorklistScope>
  );
  const sheet = variant === 'sheet';
  const categorySections = useMemo<PickerSection[]>(
    () =>
      groups.map((group) => ({
        label: group.name,
        options: group.sections.map((category) => {
          const markerHashes = category.items.flatMap((item) => variantHashes(item.hash, data));
          const savedHashes = category.items
            .filter((item) => !item.global)
            .map((item) => item.hash);
          return {
            id: category.id,
            label: category.label,
            markerHashes,
            markerFlags: rollupFinderMarkers(savedHashes, markerIndex),
          };
        }),
      })),
    [groups, data, markerIndex],
  );
  const categoryNode = (
    <FinderPicker
      label="Category"
      className={styles.category}
      sections={categorySections}
      columns={categorySections.length >= 4}
      value={selectedCategory?.id ?? ''}
      empty="No matching categories"
      onChange={(id) => {
        // A new category opens its first entry, in the scope of every group.
        const next =
          id === 'marked' ? loadMarkedSection() : sections.find((category) => category.id === id);
        const grouping = next && groupedSection(next, data);
        const first = grouping ? grouping.all[0] : next?.items[0];
        if (!first) {
          if (
            globalsEnabled &&
            ['globals-variables', 'globals-titles', 'globals-exports'].includes(id)
          ) {
            chooseRef.current(
              id === 'globals-exports' ? 1 : id === 'globals-variables' ? 2 : 3,
              null,
            );
            keepGlobalCategoryOpen.current = true;
            setOpen(true);
          }
          return;
        }
        const scope = grouping ? scopeValue(first as Entry, true, grouping.firstGroup) : null;
        chooseRef.current(first.hash, scope, next?.items[0]?.global);
        if (
          globalsEnabled &&
          ['globals-variables', 'globals-titles', 'globals-exports'].includes(id)
        ) {
          keepGlobalCategoryOpen.current = true;
          setOpen(true);
        }
      }}
    />
  );
  const groupSections = useMemo<PickerSection[]>(
    () =>
      grouped
        ? [
            {
              options: [
                {
                  id: 'all',
                  label: grouped.allLabel,
                  markerHashes: grouped.all.flatMap((entry) => variantHashes(entry.hash, data)),
                  markerFlags: rollupFinderMarkers(
                    grouped.all.map((entry) => entry.hash),
                    markerIndex,
                  ),
                },
                ...grouped.groups.map((group) => ({
                  id: group.id,
                  label: group.label,
                  icon: groupIcon(grouped, group.id),
                  markerHashes: group.entries.flatMap((entry) => variantHashes(entry.hash, data)),
                  markerFlags: rollupFinderMarkers(
                    group.entries.map((entry) => entry.hash),
                    markerIndex,
                  ),
                })),
              ],
            },
          ]
        : [],
    [grouped, data, markerIndex],
  );
  const groupValue = grouped && !place.all && grouped.byId.has(place.group) ? place.group : 'all';
  const groupNode = grouped && (
    <FinderPicker
      label={grouped.groupLabel}
      className={styles.group}
      sections={groupSections}
      value={groupValue}
      icons={grouped.grouping === 'weapon'}
      onChange={(id) => {
        const target = id === 'all' ? undefined : grouped.byId.get(id)?.entries[0];
        // "All" widens the scope and keeps the item; a group opens its first entry.
        if (id === 'all') chooseRef.current(hash, scopeValue(entry, true, grouped.firstGroup));
        else if (target)
          chooseRef.current(target.hash, scopeValue(target, false, grouped.firstGroup) ?? null);
      }}
    />
  );
  const neighbourGroup = (direction: number) => {
    const at = grouped?.groupIndex.get(place.group);
    return at === undefined ? undefined : grouped?.groups[at + direction];
  };
  const entryKeys = grouped && swapWheel ? 'Alt+Shift' : 'Shift';
  const groupKeys = swapWheel ? 'Shift' : 'Alt+Shift';
  const positionText = positionLabel(position, grouped ? selectedCategory?.label : undefined);
  // The phone stepper shows "58/138" so it fits beside the category; the status reads in words.
  const positionNode = (
    <span className={styles.position} role="status">
      {sheet && position.index ? (
        <>
          <span aria-hidden="true">{`${position.index}/${position.total}`}</span>
          <span className="sr-only">{positionText}</span>
        </>
      ) : (
        positionText
      )}
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
    <FinderFrame variant={variant}>
      {sheet ? (
        <>
          {/* The controls sit at the top, next to the header title that opened the finder; the
              field and its list follow, and the list takes the rest of the room. */}
          <div className={styles.sheetBar}>
            {categoryNode}
            {/* Touch screens have no Shift+wheel: one compact row steps through the category, beside the category; the group row goes under both. */}
            <div
              role="group"
              aria-label={queueMode ? 'Step through the queue' : 'Step within category'}
              className={styles.stepper}
            >
              <button
                type="button"
                aria-label={queueMode ? 'Previous queue item' : 'Previous tooltip'}
                disabled={queueMode ? queueMode[1] !== '1' : position.previous === undefined}
                onClick={() => step.current(-1)}
              >
                ‹
              </button>
              {positionNode}
              <button
                type="button"
                aria-label={queueMode ? 'Next queue item' : 'Next tooltip'}
                disabled={queueMode ? queueMode[2] !== '1' : position.next === undefined}
                onClick={() => step.current(1)}
              >
                ›
              </button>
            </div>
            {groupNode && (
              <div
                role="group"
                aria-label={`Step ${grouped?.groupLabel.toLowerCase()}`}
                className={styles.groupRow}
              >
                <button
                  type="button"
                  aria-label={`Previous ${grouped?.groupLabel.toLowerCase()}`}
                  disabled={Boolean(queueMode) || !neighbourGroup(-1)}
                  onClick={() => stepGroup.current(-1)}
                >
                  ‹
                </button>
                {groupNode}
                <button
                  type="button"
                  aria-label={`Next ${grouped?.groupLabel.toLowerCase()}`}
                  disabled={Boolean(queueMode) || !neighbourGroup(1)}
                  onClick={() => stepGroup.current(1)}
                >
                  ›
                </button>
              </div>
            )}
          </div>
          <MarkedWorkThrough
            data={data}
            group={place.group}
            all={place.all}
            query={query}
            onStart={closeSheet ?? restore}
          />
          {comboNode}
        </>
      ) : (
        <>
          {categoryNode}
          {selectedCategory?.id !== 'marked' && groupNode}
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
        {queueMode ? (
          <>
            Type to search. Shift+Scroll anywhere steps through the work-through queue&apos;s items
            still to do and stops at its ends; the arrow keys and Page Up/Down step too while the
            list is closed.
          </>
        ) : (
          <>
            Type to search. {entryKeys}+Scroll anywhere steps within this category and stops at its
            ends; the arrow keys step too while the list is closed.
            {grouped &&
              ` ${groupKeys}+Scroll and Page Up/Down step ${grouped.groupLabel.toLowerCase()}s, stopping at the ends.`}
          </>
        )}{' '}
        A square marks unsaved changes.
      </small>
    </FinderFrame>
  );
});

function FinderFrame({ variant, children }: { variant: 'bar' | 'sheet'; children: ReactNode }) {
  return (
    <section aria-label="Tooltip navigation" className={styles.finder} data-variant={variant}>
      {children}
    </section>
  );
}

/** The real finder controls occupy the same slots before their catalogue arrives. */
export function TooltipNavigation({
  data,
  variant = 'bar',
}: {
  data: EditorData | null;
  variant?: 'bar' | 'sheet';
}) {
  // A painted position skeleton keeps its minimum after the catalogue arrives.
  const held = useSkeletonVisible(!data, 'catalogue', true);
  if (data && !held) return <LoadedTooltipNavigation data={data} variant={variant} />;
  return (
    <FinderFrame variant={variant}>
      <FinderPicker
        label="Category"
        className={styles.category}
        sections={[]}
        value=""
        empty="Loading…"
        onChange={() => {}}
      />
      <div className={styles.combo}>
        <div className={styles.field}>
          <input
            type="text"
            role="combobox"
            aria-label="Tooltip"
            aria-expanded={false}
            className={styles.input}
            placeholder="Loading tooltips…"
            disabled
          />
        </div>
      </div>
      <span className={styles.position}>
        <LoadingSkeleton label="Loading tooltip position…" count={1} visible={held} />
      </span>
    </FinderFrame>
  );
}
