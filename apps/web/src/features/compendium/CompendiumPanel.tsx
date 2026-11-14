import {
  cloneElement,
  isValidElement,
  memo,
  startTransition,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { flushSync } from 'react-dom';
import {
  resolveCompendiumLink,
  snapshotCompendium,
  sameCell,
  type Tooltip,
  type CompendiumCell,
} from '@clarity/core';
import { approvalEvidence, mayHaveApprovalEvidence } from './approvalEvidence';
import { usePreparedPaneDiff } from './usePreparedPaneDiff';
import { CompendiumPaneSkeleton, rememberPaneSkeleton } from './CompendiumPaneSkeleton';
import { initializeCompendiumDiffWorker, prepareCompendiumDiff } from './compendiumDiffCache';
import { useAuthStore } from '../../stores/auth';
import { useDataStore } from '../../stores/data';
import { useDraftStore } from '../../stores/drafts';
import { useSettingsStore } from '../../stores/settings';
import { apiUrl } from '../../services/api';
import { reviewSaveChanges, useSaveState } from '../../services/save/state';
import { canonicalHash, itemFor } from '../navigation/catalog';
import {
  CellScale,
  CompendiumDiff,
  CompendiumDiffModeToggle,
  useCompendiumDiffMode,
} from './CompendiumDiff';
import { RichCell } from './RichCell';
import { SheetCell, SheetColoursToggle } from './sheetSurface';
import { ScaleControl } from './ScaleControl';
import { LinkPicker, openLinkPickerSoon } from './LinkPicker';
import { useCompendiumStore } from './store';
import { When } from '../../ui/When';
import { RightPane, RightPaneHeader, usePaneTabsWidth } from '../../ui/RightPane';
import { SkeletonStatus, useSkeletonVisible } from '../../ui/Skeleton';
import { useElementWidth } from '../../ui/useElementWidth';
import { phoneQuery, useMedia } from '../../ui/useMedia';
import { scaledPx } from '../../ui/scale';
import styles from './Compendium.module.scss';
import { confirmCompendiumSelection } from './selection';
import { usePaneMatch } from './usePaneMatch';
import { useDisplayMatches } from './useDisplayMatches';
import { preparedDecisions } from './reviewViewCache';
import { linkLocation, matchLocation } from './sourceLocation';
import { SourceRef } from './SourceRef';
import { usePaneStatus } from './paneStatus';
import { createPaneDecodeGuard } from './paneDecodeActivity';
import { useSteppingActivity } from '../navigation/steppingActivity';
import { openDraftSaveReview } from '../../services/save/openReview';

/**
 * Below this pane width (design pixels at 100 % interface scale; scaledPx() follows the scale) the
 * Changes / Before-After switch moves from the header to above the diff. Measured: title + switch +
 * Relink + sheet colours + zoom need 373px, so the default 384px pane keeps it in the header
 * with room to spare for font rounding.
 */
const HEADER_TOGGLE_MIN = 381;
/**
 * The "Compendium" title's share of HEADER_TOGGLE_MIN (design pixels, measured 83). Where pane tabs
 * replace the title (Compendium | Reports) the switch needs that much less plus the tabs' width.
 */
const HEADER_TITLE_WIDTH = 83;
const ApprovalDiff = memo(CompendiumDiff);

/** One stepping gesture, from the entry the pane showed when it started. */
type Burst = { origin: number; first?: number; moved: boolean; clock?: SkeletonClock };
type SkeletonClock = NonNullable<Parameters<typeof useSkeletonVisible>[3]>;

/** Records a destination; true once the burst has reached a second one besides its origin. */
function reachBurstTarget(burst: Burst, target: number) {
  if (target !== burst.origin) {
    burst.first ??= target;
    if (burst.first !== target) burst.moved = true;
  }
  return burst.moved;
}

/** The entry in a published stepping target (`/t/<hash>?…`). */
function steppingTargetHash(target: string | undefined) {
  const hash = target && /^\/t\/(\d+)/.exec(target)?.[1];
  return hash ? Number(hash) : undefined;
}

/** The retained source stays mounted; its entry-specific picker does not. */
function InlineLinkPicker({ children, onStep }: { children: ReactNode; onStep(): void }) {
  const stepping = useSteppingActivity((state) => state.active);
  const [closed, setClosed] = useState(false);
  const element = useRef<HTMLDivElement | null>(null);
  const paneHadFocus = useRef(false);
  const steppingRef = useRef(stepping);
  steppingRef.current = stepping;
  useLayoutEffect(
    () =>
      useSteppingActivity.subscribe((state, previous) => {
        if (!state.active || previous.active) return;
        // Capture before the commit disables the header toggle and the browser
        // moves focus to the body. The toggle is outside the picker element.
        const pane = element.current?.closest('aside');
        paneHadFocus.current = !!pane?.contains(pane.ownerDocument.activeElement);
      }),
    [],
  );
  const attach = useCallback((node: HTMLDivElement | null) => {
    const previous = element.current;
    element.current = node;
    if (
      node ||
      !steppingRef.current ||
      !previous ||
      (!paneHadFocus.current && !previous.contains(previous.ownerDocument.activeElement))
    )
      return;
    const owner = previous.ownerDocument;
    // Restore focus after the commit. The finder is stable across document
    // swaps, and its focus handler lands the newest route before more input.
    queueMicrotask(() => {
      if (
        owner.activeElement !== owner.body &&
        owner.activeElement?.isConnected &&
        // The header's Link stays painted while the entry is pending, but takes no clicks.
        !owner.activeElement.matches(':disabled, [aria-disabled="true"]') &&
        !owner.activeElement.closest('[hidden], [inert]')
      )
        return;
      const finder = owner.querySelector<HTMLInputElement>('input[aria-label="Tooltip"]');
      const target =
        finder && !finder.disabled && !finder.closest('[hidden], [inert]')
          ? finder
          : owner.querySelector<HTMLButtonElement>('[data-tooltip-finder]');
      target?.focus({ preventScroll: true });
    });
  }, []);
  useLayoutEffect(() => {
    if (!stepping) return;
    setClosed(true);
    onStep();
  }, [stepping, onStep]);
  if (stepping || closed) return null;
  return (
    <div ref={attach} className={styles.picker} data-inline-link-picker>
      {children}
    </div>
  );
}

/**
 * Let the editor finish its frame's DOM reads before replacing the rich pane. Also returns
 * whether the handoff frame for `base` is scheduled: from then on the pane may render.
 */
function usePaneFrame(
  base: Tooltip,
  prepare: (signal: AbortSignal) => Promise<void> | false | undefined,
  concurrent: boolean,
  stepping: boolean,
) {
  const [ready, setReady] = useState(base);
  const [scheduledFor, setScheduledFor] = useState<Tooltip>();
  const committed = useRef(base);
  const frame = useRef<number>();
  const generation = useRef(0);
  // A frame callback can fire just before a newer navigation render. Its queued
  // update must not make that superseded tooltip visible, even for one commit.
  const displayed = !stepping && ready === base ? base : committed.current;
  // A later visit to the same entry schedules its own frame again.
  if (displayed === base && scheduledFor) setScheduledFor(undefined);
  useLayoutEffect(() => {
    committed.current = displayed;
  }, [displayed]);
  // Cancel at commit time, before a superseded callback can run. Schedule in
  // the passive phase below, after the editor has registered its frame reads.
  useLayoutEffect(
    () => () => {
      generation.current++;
      if (frame.current !== undefined) cancelAnimationFrame(frame.current);
      frame.current = undefined;
    },
    [base, prepare, stepping],
  );
  useEffect(() => {
    if (stepping || displayed === base) return;
    const controller = new AbortController();
    const current = generation.current;
    let scheduled: number | undefined;
    const schedule = () => {
      if (controller.signal.aborted || generation.current !== current) return;
      scheduled = requestAnimationFrame(() => {
        if (frame.current !== scheduled) return;
        frame.current = undefined;
        // Commit in this paint opportunity rather than handing React another
        // frame after the editor and preview have already finished.
        if (concurrent) startTransition(() => setReady(base));
        else flushSync(() => setReady(base));
      });
      frame.current = scheduled;
      setScheduledFor(base);
    };
    const preparation = prepare(controller.signal);
    if (preparation) void preparation.then(schedule, schedule);
    else if (preparation !== false) schedule();
    return () => {
      controller.abort();
      if (scheduled !== undefined) {
        cancelAnimationFrame(scheduled);
        // A canceled attempt is not a scheduled handoff: returning to this entry (even the same
        // object) must schedule, and restart the skeleton's grace, again.
        setScheduledFor((current) => (current === base ? undefined : current));
      }
      if (frame.current === scheduled) frame.current = undefined;
    };
  }, [base, displayed, prepare, concurrent, stepping]);
  return [displayed, scheduledFor === base] as const;
}

export function CompendiumPanel({
  base: incomingBase,
  stepping = false,
  target,
}: {
  base: Tooltip;
  stepping?: boolean;
  /**
   * The entry the route already shows, when `base` follows it a frame later: the loading
   * skeleton's identity, so one step is one entry for its timing (not two).
   */
  target?: number;
}) {
  const retainedBase = useRef(incomingBase);
  const base = stepping ? retainedBase.current : incomingBase;
  useLayoutEffect(() => {
    if (!stepping) retainedBase.current = incomingBase;
  }, [incomingBase, stepping]);
  const editor = useDataStore((state) => state.data);
  const source = useCompendiumStore((state) => state.data);
  const sourceReady = !!source;
  const decodeGuard = useMemo(createPaneDecodeGuard, []);
  useLayoutEffect(() => {
    if (sourceReady) decodeGuard.begin(incomingBase.hash);
    else decodeGuard.dispose();
  }, [incomingBase.hash, sourceReady, decodeGuard]);
  useLayoutEffect(() => {
    if (!sourceReady) return;
    let previousPath = window.location.hash.split('?')[0];
    const navigation = () => {
      const path = window.location.hash.split('?')[0];
      const previous = previousPath;
      previousPath = path;
      // Language/variant history can retain an active override whose identity
      // differs from the route's base. Its incoming prop owns that handoff.
      if (path === previous) return;
      const hash = /^#\/t\/(\d+)/.exec(path)?.[1];
      const oldHash = /^#\/t\/(\d+)/.exec(previous)?.[1];
      const data = useDataStore.getState().data;
      const canonical = (value: string) =>
        data ? canonicalHash(Number(value), data) : Number(value);
      if (hash && (!oldHash || canonical(hash) !== canonical(oldHash)))
        decodeGuard.begin(canonical(hash));
    };
    window.addEventListener('hashchange', navigation, true);
    window.addEventListener('popstate', navigation, true);
    return () => {
      window.removeEventListener('hashchange', navigation, true);
      window.removeEventListener('popstate', navigation, true);
      decodeGuard.dispose();
    };
  }, [sourceReady, decodeGuard]);
  const drafts = useDraftStore((state) => state.drafts);
  const userId = useAuthStore((state) => state.user?.id);
  const diffMode = useSettingsStore((state) => state.device.remembered.compendiumDiff);
  // One subscription supplies both the incoming preparation and displayed row.
  // Repeated subscriptions each decoded the same worker reply during a switch.
  const {
    matches,
    loading: matching,
    error: matchError,
    reviewPrepared,
  } = useDisplayMatches(editor, source, drafts, userId, base.hash);
  const incomingMatch =
    base.compendium || drafts[base.hash]?.next.compendium ? undefined : matches?.get(base.hash);
  const awaitingMatch =
    !base.compendium && !drafts[base.hash]?.next.compendium && !incomingMatch && matching;
  const incomingDraft = drafts[base.hash];
  const rawIncomingLink = incomingDraft ? incomingDraft.next.compendium : base.compendium;
  const incomingKey = JSON.stringify(rawIncomingLink);
  const incomingLinkRef = useRef({ key: incomingKey, value: rawIncomingLink });
  if (incomingLinkRef.current.key !== incomingKey)
    incomingLinkRef.current = { key: incomingKey, value: rawIncomingLink };
  const incomingLink = incomingLinkRef.current.value;
  useEffect(initializeCompendiumDiffWorker, []);
  const comparison = useMemo(() => {
    if (stepping) return;
    if (incomingLink && source) {
      const resolved = resolveCompendiumLink(incomingLink, source);
      if (['ok', 'changed', 'moved'].includes(resolved.status) && 'row' in resolved)
        return { before: incomingLink.snapshot, after: resolved.row.cell };
    } else if (incomingMatch && editor) {
      const item = itemFor(base.hash, editor);
      const approved =
        item && approvalEvidence(base.hash, item.name, item.categoryId, incomingMatch);
      if (approved) return { before: approved, after: incomingMatch.row.cell };
    }
  }, [base, incomingLink, source, incomingMatch, editor, stepping]);
  const prepare = useCallback(
    (signal: AbortSignal) => {
      // Keep the old pane until the incoming row can be prepared. Committing an
      // empty pane first would paint its plain cell and then replace it again
      // when the worker projection arrives.
      if (stepping || awaitingMatch) return false;
      if (!comparison) return;
      const preparation = prepareCompendiumDiff(comparison.before, comparison.after, signal);
      if (diffMode === 'before-after') {
        void preparation?.catch(() => undefined);
        return;
      }
      return preparation;
    },
    [awaitingMatch, comparison, diffMode, stepping],
  );
  const [displayed, handoffScheduled] = usePaneFrame(
    base,
    prepare,
    !!comparison && !sameCell(comparison.before, comparison.after),
    stepping,
  );
  const draft = drafts[displayed.hash];
  const link = draft ? draft.next.compendium : displayed.compendium;
  // Draft updates clone the whole tooltip. Retain unchanged link metadata across text edits,
  // so the rich source body and resolver do not run again on each keystroke.
  const linkKey = JSON.stringify(link);
  const retainedLink = useRef({ key: linkKey, value: link });
  if (retainedLink.current.key !== linkKey) retainedLink.current = { key: linkKey, value: link };
  const currentMatch =
    displayed.compendium || drafts[displayed.hash]?.next.compendium
      ? undefined
      : matches?.get(displayed.hash);
  // A priority reply may contain only the incoming row. Preserve the visible
  // row until the handoff commits.
  const previousMatch = useRef({ base: displayed, value: currentMatch });
  const navigating = displayed !== base;
  // Entries the shipped decisions rule out need no Compendium row: the pane then offers the tab, not a review.
  const decisionAction = preparedDecisions(reviewPrepared).get(displayed.hash)?.action;
  const excluded = decisionAction === 'out-of-scope' || decisionAction === 'no-equivalent';
  const matched =
    navigating && previousMatch.current.base === displayed
      ? previousMatch.current.value
      : currentMatch;
  useLayoutEffect(() => {
    if (!navigating) previousMatch.current = { base: displayed, value: currentMatch };
  }, [displayed, currentMatch, navigating]);
  return (
    <PaneContents
      base={displayed}
      pending={displayed !== base}
      handoffScheduled={handoffScheduled}
      stepping={stepping}
      pendingBase={incomingBase}
      target={target ?? incomingBase.hash}
      pendingLink={
        stepping
          ? drafts[incomingBase.hash]
            ? drafts[incomingBase.hash].next.compendium
            : incomingBase.compendium
          : incomingLink
      }
      pendingDraft={!!drafts[incomingBase.hash]?.next.compendium}
      pendingBefore={!stepping ? comparison?.before : undefined}
      pendingCell={!stepping ? (comparison?.after ?? incomingMatch?.row.cell) : undefined}
      link={retainedLink.current.value}
      draft={!!draft && !!link}
      matched={matched}
      excluded={excluded}
      matching={matching}
      matchError={matchError}
      onCommitted={decodeGuard.committed}
    />
  );
}

// Rapid finder navigation keeps the previous styled cell until React can paint the final item.
// The cheap wrapper absorbs intermediate items; link/review actions pause while it catches up.
const PaneContents = memo(function PaneContents({
  base,
  pending: navigating,
  handoffScheduled,
  stepping,
  pendingBase,
  target,
  pendingLink,
  pendingDraft,
  pendingBefore,
  pendingCell,
  link,
  draft,
  matched,
  excluded,
  matching,
  matchError,
  onCommitted,
}: {
  base: Tooltip;
  pending: boolean;
  /** The pane's frame for the incoming entry is scheduled (its preparation is done). */
  handoffScheduled: boolean;
  stepping: boolean;
  pendingBase: Tooltip;
  target: number;
  pendingLink: Tooltip['compendium'];
  pendingDraft: boolean;
  pendingBefore?: CompendiumCell;
  pendingCell?: CompendiumCell;
  link: Tooltip['compendium'];
  draft: boolean;
  matched: ReturnType<typeof usePaneMatch>;
  /** The entry needs no Compendium row; the pane offers the tab without asking for a review. */
  excluded: boolean;
  matching: boolean;
  matchError?: string;
  onCommitted(hash: number): void;
}) {
  const { data: compendium, loading, error, load } = useCompendiumStore();
  const data = useDataStore((state) => state.data);
  const updateDraft = useDraftStore((state) => state.updateDraft);
  const hydrated = useDraftStore((state) => state.hydrated);
  const user = useAuthStore((state) => state.user);
  const saving = useSaveState((state) => state.locked);
  const [picking, setPicking] = useState(false);
  const closePickerForStep = useCallback(() => setPicking(false), []);
  // Opening runs the picker's lookups in their own task, then renders it: not in the click.
  const cancelOpen = useRef<(() => void) | undefined>(undefined);
  useEffect(() => () => cancelOpen.current?.(), []);
  const scale = useSettingsStore((state) => state.device.compendiumScale);
  const [diffMode, setDiffMode] = useCompendiumDiffMode();
  const bodyRef = useRef<HTMLDivElement>(null);
  const width = useElementWidth(bodyRef);
  // Unmeasured (no layout) counts as roomy; a narrow pane puts the switch above the diff instead.
  // Touch-sized controls (phone, coarse pointer) are wider than the measure below allows for.
  const phone = useMedia(phoneQuery);
  const coarse = useMedia('(pointer: coarse)');
  const touch = phone || coarse;
  const [headerMin, setHeaderMin] = useState(HEADER_TOGGLE_MIN);
  useEffect(() => {
    const measure = () => setHeaderMin(scaledPx(HEADER_TOGGLE_MIN));
    measure();
    window.addEventListener('clarity-ui-scale', measure);
    return () => window.removeEventListener('clarity-ui-scale', measure);
  }, []);
  const tabsWidth = usePaneTabsWidth(bodyRef);
  const tabsExtra = tabsWidth
    ? Math.max(0, tabsWidth - (headerMin / HEADER_TOGGLE_MIN) * HEADER_TITLE_WIDTH)
    : 0;
  const roomy = !touch && (width === undefined || width >= headerMin + tabsExtra);
  // Disable pending actions in place. Removing them would dirty the old pane's
  // layout during the editor's read frame, defeating the content handoff.
  const canEdit =
    !!apiUrl &&
    hydrated &&
    !saving &&
    !!user?.role &&
    ['maintainer', 'editor', 'trial'].includes(user.role);
  const canReview =
    !!apiUrl && hydrated && !saving && !!user?.role && ['maintainer', 'editor'].includes(user.role);
  useEffect(() => {
    void load();
  }, [load]);
  const resolution = useMemo(
    () => (compendium && link ? resolveCompendiumLink(link, compendium) : undefined),
    [compendium, link],
  );
  const match =
    resolution && ['ok', 'changed', 'moved'].includes(resolution.status) && 'row' in resolution
      ? resolution
      : undefined;
  const item = data && itemFor(base.hash, data);
  const approved = useMemo(
    () =>
      !link && matched && item
        ? approvalEvidence(base.hash, item.name, item.categoryId, matched)
        : undefined,
    [link, matched, item, base.hash],
  );
  // Opens the tab on this entry; a plain hash link, so Back returns to the editor where it was.
  const matchedWhere = useMemo(
    () => (matched ? matchLocation(matched, compendium) : undefined),
    [matched, compendium],
  );
  const linkedWhere = useMemo(
    () => (match ? matchLocation(match, compendium) : undefined),
    [match, compendium],
  );
  // A saved link whose row no longer resolves: its tab, but no range that may now be wrong.
  const staleWhere = useMemo(
    () =>
      // Without a loaded source (a failed load) the saved place is shown as saved.
      link && !match ? linkLocation(link, compendium, { stale: !!resolution }) : undefined,
    [link, resolution, match, compendium],
  );
  const handoff = `#/compendium?hash=${base.hash}&show=all`;
  const approvalChanged = approved && matched && !sameCell(approved, matched.row.cell);
  const comparisonBefore = link && match ? link.snapshot : !link ? approved : undefined;
  const comparisonAfter = link && match ? match.row.cell : !link ? matched?.row.cell : undefined;
  const preparedDiff = usePreparedPaneDiff(comparisonBefore, comparisonAfter, diffMode, stepping);
  const pending = navigating || preparedDiff.pending;
  const waiting = stepping || pending || loading || (!link && matching && !matched);
  // The tab's dot: linked or matched text, or an entry that needs a decision. Quiet while loading.
  const setPaneStatus = usePaneStatus((state) => state.set);
  const paneStatus =
    waiting || matchError
      ? undefined
      : link || matched
        ? ('matched' as const)
        : excluded
          ? undefined
          : ('review' as const);
  useEffect(() => {
    setPaneStatus(base.hash, paneStatus);
  }, [setPaneStatus, base.hash, paneStatus]);
  useEffect(() => {
    if (!waiting) onCommitted(base.hash);
  }, [base.hash, waiting, onCommitted]);
  const retainedPane = useRef<ReturnType<typeof RightPane>>();
  const wasStepping = useRef(false);
  const hasContent = useRef(false);
  // One discrete step (a finder pick, one Shift+wheel notch) holds the pane through the
  // stepping quiet and the preview handoff. That hold is not this entry's load time: its
  // skeleton grace (two frames) starts once the pane may render, so a warm entry shows
  // directly instead of behind a skeleton's minimum. A burst that reaches a second entry
  // (besides the one the pane shows; a wheel burst can start before its route lands)
  // keeps the skeleton rule from that move on. The finder's own target counts as well: while
  // the document is deferred mid-flick the route (and `target`) can hold the first
  // destination, though the gesture has moved on.
  const burst = useRef<Burst>();
  if (!stepping) burst.current = undefined;
  else {
    burst.current ??= { origin: base.hash, moved: false };
    reachBurstTarget(burst.current, target);
  }
  const [, setMovedBurst] = useState<Burst>();
  useLayoutEffect(
    () =>
      useSteppingActivity.subscribe((state) => {
        const current = burst.current;
        const raw = state.active ? steppingTargetHash(state.target) : undefined;
        if (!current || current.moved || raw === undefined) return;
        // The route resolves variants to their canonical entry; compare like with like.
        const data = useDataStore.getState().data;
        const hash = data ? canonicalHash(raw, data) : raw;
        // Stepping frames publish this inside flushSync; the pane re-renders after them.
        if (reachBurstTarget(current, hash)) startTransition(() => setMovedBurst(current));
      }),
    [],
  );
  // A burst that moved is one wait: its two-frame grace and minimum run once, from the move,
  // not again for each entry it passes. The skeleton keeps that identity and its own clock (the
  // page's clock follows the route entry) until it releases, so the entry a flick stops on shows
  // once ready instead of restarting the minimum.
  const skeletonBurst = useRef<Burst>();
  if (burst.current?.moved) skeletonBurst.current ??= burst.current;
  if (skeletonBurst.current) skeletonBurst.current.clock ??= { holders: new Set() };
  // After one step the pane may render once its handoff frame is scheduled (match and diff
  // prepared). Counted only from the step's end, the skeleton's two frames ran ahead of the
  // pane's own frame callback in the same frame, so a pane that committed before that frame's
  // paint still got a skeleton and its 200 ms minimum. Until the skeleton shows, scheduling the
  // handoff restarts its grace (a new identity), so the pane's frame comes first.
  const shown = useRef(false);
  const stepIdentity = useRef({ target, scheduled: handoffScheduled });
  if (
    stepIdentity.current.target !== target ||
    (!shown.current && stepIdentity.current.scheduled !== handoffScheduled)
  )
    stepIdentity.current = { target, scheduled: handoffScheduled };
  const showSkeleton = useSkeletonVisible(
    waiting && (!stepping || !!burst.current?.moved || !hasContent.current),
    skeletonBurst.current ?? stepIdentity.current,
    hasContent.current,
    skeletonBurst.current?.clock,
  );
  // A shown skeleton outlasts the load by its minimum time; until then ready content waits.
  const holding = waiting || showSkeleton;
  useLayoutEffect(() => {
    if (!holding) skeletonBurst.current = undefined;
    shown.current = showSkeleton;
  }, [holding, showSkeleton]);
  useLayoutEffect(() => {
    if (stepping) wasStepping.current = true;
    else if (!waiting) wasStepping.current = false;
  }, [stepping, waiting]);
  useLayoutEffect(() => {
    const previous = bodyRef.current?.querySelector(
      ':scope > [data-scale]:not([data-pane-skeleton])',
    );
    previous?.toggleAttribute('inert', holding);
    bodyRef.current?.previousElementSibling?.removeAttribute('inert');
  }, [holding]);
  useLayoutEffect(() => {
    if (!waiting)
      rememberPaneSkeleton(base.hash, compendium?.fetchedAt, comparisonBefore, comparisonAfter);
  }, [waiting, base.hash, compendium?.fetchedAt, comparisonBefore, comparisonAfter]);

  const diffToggle = <CompendiumDiffModeToggle mode={diffMode} onChange={setDiffMode} />;
  // One header for the loaded and the loading pane, so its controls stay painted and unchanged
  // through every entry switch (U-OWN1). Sheet colours, zoom, and the diff view are device
  // settings and never disable; Link keeps its look and only ignores clicks while the entry is
  // pending (`locked`), since it acts on the entry.
  const paneHeader = (comparison: boolean, linked: boolean, locked: boolean) => (
    <RightPaneHeader title="Compendium">
      {comparison && roomy && diffToggle}
      {canEdit && (
        <button
          type="button"
          className={styles.headerButton}
          aria-disabled={locked || undefined}
          aria-pressed={picking}
          aria-label={picking ? 'Close picker' : linked ? 'Pick other row' : 'Link a row'}
          onClick={() => {
            if (locked) return;
            // A second click before the picker commits cancels the open, as Close would.
            if (cancelOpen.current) {
              cancelOpen.current();
              cancelOpen.current = undefined;
            } else if (picking) setPicking(false);
            else {
              let opened = false;
              const cancel = openLinkPickerSoon(
                item?.categoryId ?? 'other',
                item?.name ?? base.custom?.name ?? '',
                () => {
                  opened = true;
                  cancelOpen.current = undefined;
                  setPicking(true);
                },
              );
              if (!opened) cancelOpen.current = cancel;
            }
          }}
        >
          {picking ? 'Close' : linked ? 'Relink' : 'Link'}
        </button>
      )}
      <SheetColoursToggle />
      <ScaleControl />
    </RightPaneHeader>
  );
  const pane = (
    <RightPane
      className={styles.pane}
      busy={pending}
      label={`Compendium for ${item?.name ?? base.hash}`}
      bodyRef={bodyRef}
      header={paneHeader(!!(match || approved), !!link, pending)}
    >
      <div
        className={styles.zoom}
        data-scale={scale}
        data-match-hash={base.hash}
        data-match-state={
          matchError ? 'error' : loading || (!link && matching && !matched) ? 'loading' : 'ready'
        }
      >
        {picking && canEdit && (
          <InlineLinkPicker onStep={closePickerForStep}>
            <LinkPicker
              base={base}
              name={item?.name ?? base.custom?.name ?? ''}
              category={item?.categoryId ?? 'other'}
              readOnly={pending}
              onLinked={() => setPicking(false)}
            />
          </InlineLinkPicker>
        )}
        {loading && <p role="status">Loading Compendium...</p>}
        {error && (
          <p role="alert">
            {error}{' '}
            <button type="button" onClick={() => void load(true)}>
              Retry
            </button>
          </p>
        )}
        {!link && (
          <p
            role={matching && !matched ? 'status' : undefined}
            className={styles.meta}
            style={{ minHeight: '1lh' }}
          >
            {matched ? (
              <>
                <span
                  className={styles.matched}
                  title="Matched automatically — not saved"
                  tabIndex={0}
                >
                  Matched
                </span>{' '}
                {matched.tab.name} / {matched.row.name}{' '}
                <a className={styles.handoff} href={handoff}>
                  Compendium →
                </a>
              </>
            ) : matching ? (
              'Matching Compendium…'
            ) : !loading && !matchError ? (
              <>
                No Compendium row linked yet.{' '}
                {!excluded && <strong className={styles.needsReview}>Needs review</strong>}{' '}
                <a className={styles.handoff} href={handoff}>
                  {excluded ? 'Compendium →' : 'Review in Compendium →'}
                </a>
              </>
            ) : null}
          </p>
        )}
        {!link && matchError && <p role="alert">{matchError}</p>}
        {!link && matched && (
          <>
            <p className={approvalChanged ? styles.warning : undefined}>
              {approved
                ? approvalChanged
                  ? 'Compendium sheet changed since approval.'
                  : 'Matches the approval evidence.'
                : 'No saved snapshot to compare.'}
              {matchedWhere && <SourceRef location={matchedWhere} block />}
            </p>
            <div style={{ contain: 'layout style' }}>
              {approved ? (
                <>
                  {!roomy && <div className={styles.diffModes}>{diffToggle}</div>}
                  {preparedDiff.pair ? (
                    <ApprovalDiff
                      scale={scale}
                      before={preparedDiff.pair.before}
                      after={preparedDiff.pair.after}
                      mode={diffMode}
                    />
                  ) : (
                    <CellScale scale={scale}>
                      <SheetCell background={matched.row.cell.background}>
                        <RichCell cell={matched.row.cell} />
                      </SheetCell>
                    </CellScale>
                  )}
                </>
              ) : (
                <CellScale scale={scale}>
                  <SheetCell background={matched.row.cell.background}>
                    <RichCell cell={matched.row.cell} />
                  </SheetCell>
                </CellScale>
              )}
            </div>
            {canEdit && (
              <div className={styles.actions}>
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => {
                    if (!compendium) return;
                    const confirmed = confirmCompendiumSelection(matched, compendium);
                    if (!confirmed) return;
                    updateDraft(base, (current) => ({ ...current, compendium: confirmed }));
                  }}
                >
                  Accept match (local draft)
                </button>
              </div>
            )}
          </>
        )}
        <p className={styles.meta}>
          {link && (
            <>
              <span>
                {draft && !base.compendium ? 'Draft snapshot' : 'Snapshot'}{' '}
                <When value={link.snapshotAt} />
              </span>{' '}
            </>
          )}
          {compendium && (
            <span>
              Source fetched <When value={compendium.fetchedAt} />
            </span>
          )}
        </p>
        {link && (
          <>
            {match && (
              <>
                <p className={match.status === 'ok' ? undefined : styles.warning}>
                  {match.status === 'moved'
                    ? `Moved to ${match.tab.name} / ${match.row.name}; follows automatically and is saved on the next English save or review.`
                    : match.status === 'changed'
                      ? 'Compendium text or styling has changed.'
                      : draft && !base.compendium
                        ? 'Matches the local draft snapshot.'
                        : 'Matches the saved snapshot.'}
                  {linkedWhere && <SourceRef location={linkedWhere} block />}
                </p>
                {!roomy && <div className={styles.diffModes}>{diffToggle}</div>}
                {preparedDiff.pair ? (
                  <CompendiumDiff
                    scale={scale}
                    before={preparedDiff.pair.before}
                    after={preparedDiff.pair.after}
                    mode={diffMode}
                  />
                ) : (
                  <CellScale scale={scale}>
                    <SheetCell background={match.row.cell.background}>
                      <RichCell cell={match.row.cell} />
                    </SheetCell>
                  </CellScale>
                )}
                {canReview && (
                  <div className={styles.actions}>
                    <button
                      type="button"
                      disabled={pending || !!draft || match.status === 'ok'}
                      onClick={() => {
                        reviewSaveChanges([
                          {
                            hash: base.hash,
                            base,
                            next: { ...base, compendium: snapshotCompendium(match) },
                          },
                        ]);
                      }}
                    >
                      Mark as reviewed
                    </button>
                    {draft && (
                      <small>Save or discard this tooltip's draft before marking reviewed.</small>
                    )}
                  </div>
                )}
              </>
            )}
            {(resolution?.status === 'candidates' || resolution?.status === 'relink-suggested') && (
              <>
                <p className={styles.warning}>
                  {resolution.status === 'relink-suggested'
                    ? 'A renamed row has similar content. Confirm the selected suggestion or choose another.'
                    : 'Needs relink: the old name is ambiguous or missing. Confirm a suggested row or search.'}
                </p>
                <ul className={styles.rows}>
                  {(resolution.status === 'relink-suggested'
                    ? [resolution.candidate]
                    : resolution.candidates
                  ).map((candidate) => (
                    <li
                      key={`${candidate.tab.gid}:${candidate.row.rowIndex}:${candidate.row.anchor?.col ?? 0}`}
                    >
                      <p>
                        {candidate.row.name} ({Math.round(candidate.similarity * 100)}% content
                        match)
                        <SourceRef location={matchLocation(candidate, compendium)} block />
                      </p>
                      <CellScale scale={scale}>
                        <SheetCell background={candidate.row.cell.background}>
                          <RichCell cell={candidate.row.cell} />
                        </SheetCell>
                      </CellScale>
                      {canEdit && (
                        <button
                          type="button"
                          disabled={
                            pending ||
                            !compendium ||
                            !confirmCompendiumSelection(candidate, compendium)
                          }
                          onClick={() => {
                            if (!compendium) return;
                            const confirmed = confirmCompendiumSelection(candidate, compendium);
                            if (!confirmed) return;
                            updateDraft(base, (tooltip) => ({
                              ...tooltip,
                              compendium: confirmed,
                            }));
                          }}
                        >
                          {resolution.status === 'relink-suggested' &&
                          candidate === resolution.candidate
                            ? 'Confirm suggested relink'
                            : 'Link this row'}
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
                {resolution.status === 'relink-suggested' && canEdit && (
                  <button type="button" disabled={pending} onClick={() => setPicking(true)}>
                    Choose another
                  </button>
                )}
              </>
            )}
            {resolution?.status === 'missing' && (
              <p className={styles.warning}>
                Needs relink: no matching row or similar content found.
              </p>
            )}
            {!match && staleWhere && (
              <p className={styles.staleSource}>
                Snapshot from <SourceRef location={staleWhere} />
              </p>
            )}
            {!match && (
              <CellScale scale={scale}>
                <SheetCell>
                  <RichCell cell={link.snapshot} />
                </SheetCell>
              </CellScale>
            )}
          </>
        )}
        {canEdit && link && (
          <div className={styles.actions}>
            {draft && (
              <button type="button" disabled={pending} onClick={openDraftSaveReview}>
                Review &amp; save draft
              </button>
            )}
            <button
              type="button"
              disabled={pending}
              onClick={() =>
                updateDraft(base, (tooltip) => {
                  const next = { ...tooltip };
                  delete next.compendium;
                  return next;
                })
              }
            >
              Unlink (local draft)
            </button>
          </div>
        )}
      </div>
    </RightPane>
  );
  // The header's entry-specific parts (diff view switch, Link or Relink) as last shown: a hold
  // keeps them until the next entry's content replaces it on screen, so neither a flick's
  // passing targets nor a match resolving under the skeleton blink them.
  const shownHeader = useRef<{ comparison: boolean; linked: boolean }>();
  useLayoutEffect(() => {
    if (!waiting) {
      retainedPane.current = pane;
      hasContent.current = true;
    }
    if (!holding) shownHeader.current = { comparison: !!(match || approved), linked: !!link };
  });
  if (!holding) return pane;
  if (!stepping && !wasStepping.current && !showSkeleton)
    return cloneElement(pane, {
      busy: true,
      children: (
        <>
          {pane.props.children}
          <SkeletonStatus>Loading Compendium…</SkeletonStatus>
        </>
      ),
    });
  const previous = retainedPane.current;
  const oldContent = previous?.props.children;
  const pendingItem = data && itemFor(pendingBase.hash, data);
  // A matched entry with approval evidence compares like a link: reserve its switch and rows.
  const expectComparison =
    !!pendingLink ||
    !!pendingBefore ||
    (!!pendingItem &&
      mayHaveApprovalEvidence(pendingBase.hash, pendingItem.name, pendingItem.categoryId));
  const loadingHeader = shownHeader.current
    ? paneHeader(shownHeader.current.comparison, shownHeader.current.linked, true)
    : paneHeader(expectComparison, !!pendingLink, true);
  // The skeleton stands for the route's entry, which can be ahead of the incoming document.
  const targetItem = data && itemFor(target, data);
  return cloneElement(previous ?? pane, {
    busy: true,
    // The pane's name follows what it shows: the held entry until the skeleton replaces it.
    label:
      showSkeleton || !previous
        ? `Compendium for ${targetItem?.name ?? target}`
        : previous.props.label,
    header: loadingHeader,
    children: (
      <>
        {isValidElement<{ hidden?: boolean; 'aria-hidden'?: boolean }>(oldContent) &&
          cloneElement(oldContent, {
            hidden: showSkeleton,
            'aria-hidden': showSkeleton || undefined,
          })}
        <SkeletonStatus>Loading Compendium…</SkeletonStatus>
        {showSkeleton && (
          <CompendiumPaneSkeleton
            base={pendingBase}
            link={pendingLink}
            draft={pendingDraft}
            before={pendingBefore}
            after={pendingCell}
            expectComparison={expectComparison}
            sourceFetchedAt={compendium?.fetchedAt}
            width={width}
            scale={scale}
            remPx={(headerMin / HEADER_TOGGLE_MIN) * 16}
            mode={diffMode}
            phone={phone}
            canEdit={canEdit}
            canReview={canReview}
            roomy={roomy}
            diffControl={diffToggle}
          />
        )}
      </>
    ),
  });
});
