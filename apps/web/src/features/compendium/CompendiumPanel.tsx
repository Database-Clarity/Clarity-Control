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
import { approvalEvidence } from './approvalEvidence';
import { usePreparedPaneDiff } from './usePreparedPaneDiff';
import { CompendiumPaneSkeleton, rememberPaneSkeleton } from './CompendiumPaneSkeleton';
import { initializeCompendiumDiffWorker, prepareCompendiumDiff } from './compendiumDiffCache';
import { useAuthStore } from '../../stores/auth';
import { useDataStore } from '../../stores/data';
import { useDraftStore } from '../../stores/drafts';
import { compendiumScales, useSettingsStore } from '../../stores/settings';
import { apiUrl } from '../../services/api';
import { reviewSaveChanges, useSaveState } from '../../services/save/state';
import { canonicalHash, itemFor } from '../navigation/catalog';
import { CompendiumDiff, CompendiumDiffModeToggle, useCompendiumDiffMode } from './CompendiumDiff';
import { RichCell } from './RichCell';
import { SheetCell, SheetColoursToggle } from './sheetSurface';
import { LinkPicker } from './LinkPicker';
import { useCompendiumStore } from './store';
import { When } from '../../ui/When';
import { RightPane, RightPaneHeader } from '../../ui/RightPane';
import { SkeletonStatus, useSkeletonVisible } from '../../ui/Skeleton';
import { useElementWidth } from '../../ui/useElementWidth';
import { phoneQuery, useMedia } from '../../ui/useMedia';
import { scaledPx } from '../../ui/scale';
import styles from './Compendium.module.scss';
import { confirmCompendiumSelection } from './selection';
import { usePaneMatch } from './usePaneMatch';
import { useDisplayMatches } from './useDisplayMatches';
import { preparedDecisions } from './reviewViewCache';
import { matchLocation } from './sourceLocation';
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
const ApprovalDiff = memo(CompendiumDiff);

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
        !owner.activeElement.matches(':disabled') &&
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

/** Compendium zoom (70–100 %), kept on this device: − / value / +. */
function ScaleControl({ disabled = false }: { disabled?: boolean } = {}) {
  const scale = useSettingsStore((state) => state.device.compendiumScale);
  const updateDevice = useSettingsStore((state) => state.updateDevice);
  const index = Math.max(0, compendiumScales.indexOf(scale as (typeof compendiumScales)[number]));
  const step = (by: number) =>
    updateDevice({ compendiumScale: compendiumScales[index + by] ?? scale });
  return (
    <span className={styles.scale} role="group" aria-label="Compendium zoom">
      <button
        type="button"
        aria-label="Smaller"
        disabled={disabled || index === 0}
        onClick={() => step(-1)}
      >
        −
      </button>
      <output aria-live="polite">{scale}%</output>
      <button
        type="button"
        aria-label="Larger"
        disabled={disabled || index === compendiumScales.length - 1}
        onClick={() => step(1)}
      >
        +
      </button>
    </span>
  );
}

/** Let the editor finish its frame's DOM reads before replacing the rich pane. */
function usePaneFrame(
  base: Tooltip,
  prepare: (signal: AbortSignal) => Promise<void> | false | undefined,
  concurrent: boolean,
  stepping: boolean,
) {
  const [ready, setReady] = useState(base);
  const committed = useRef(base);
  const frame = useRef<number>();
  const generation = useRef(0);
  // A frame callback can fire just before a newer navigation render. Its queued
  // update must not make that superseded tooltip visible, even for one commit.
  const displayed = !stepping && ready === base ? base : committed.current;
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
    };
    const preparation = prepare(controller.signal);
    if (preparation) void preparation.then(schedule, schedule);
    else if (preparation !== false) schedule();
    return () => {
      controller.abort();
      if (scheduled !== undefined) cancelAnimationFrame(scheduled);
      if (frame.current === scheduled) frame.current = undefined;
    };
  }, [base, displayed, prepare, concurrent, stepping]);
  return displayed;
}

export function CompendiumPanel({
  base: incomingBase,
  stepping = false,
}: {
  base: Tooltip;
  stepping?: boolean;
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
  const displayed = usePaneFrame(
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
      stepping={stepping}
      pendingBase={incomingBase}
      pendingLink={
        stepping
          ? drafts[incomingBase.hash]
            ? drafts[incomingBase.hash].next.compendium
            : incomingBase.compendium
          : incomingLink
      }
      pendingDraft={!!drafts[incomingBase.hash]?.next.compendium}
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
  stepping,
  pendingBase,
  pendingLink,
  pendingDraft,
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
  stepping: boolean;
  pendingBase: Tooltip;
  pendingLink: Tooltip['compendium'];
  pendingDraft: boolean;
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
  const roomy = !touch && (width === undefined || width >= headerMin);
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
    if (!waiting) setPaneStatus(base.hash, paneStatus);
  }, [setPaneStatus, base.hash, paneStatus, waiting]);
  useEffect(() => {
    if (!waiting) onCommitted(base.hash);
  }, [base.hash, waiting, onCommitted]);
  const retainedPane = useRef<ReturnType<typeof RightPane>>();
  const hasContent = useRef(false);
  const wasStepping = useRef(false);
  const showSkeleton = useSkeletonVisible(waiting, pendingBase.hash, hasContent.current);
  useLayoutEffect(() => {
    if (stepping) wasStepping.current = true;
    else if (!waiting) wasStepping.current = false;
  }, [stepping, waiting]);
  useLayoutEffect(() => {
    const previous = bodyRef.current?.querySelector(
      ':scope > [data-scale]:not([data-pane-skeleton])',
    );
    previous?.toggleAttribute('inert', waiting);
    bodyRef.current?.previousElementSibling?.removeAttribute('inert');
  }, [waiting, showSkeleton]);
  useLayoutEffect(() => {
    if (!waiting)
      rememberPaneSkeleton(base.hash, compendium?.fetchedAt, comparisonBefore, comparisonAfter);
  }, [waiting, base.hash, compendium?.fetchedAt, comparisonBefore, comparisonAfter]);

  const diffToggle = <CompendiumDiffModeToggle mode={diffMode} onChange={setDiffMode} />;
  const pane = (
    <RightPane
      className={styles.pane}
      busy={pending}
      label={`Compendium for ${item?.name ?? base.hash}`}
      bodyRef={bodyRef}
      header={
        <RightPaneHeader title="Compendium">
          {(match || approved) && roomy && diffToggle}
          {canEdit && (
            <button
              type="button"
              className={styles.headerButton}
              disabled={pending}
              aria-pressed={picking}
              aria-label={picking ? 'Close picker' : link ? 'Pick other row' : 'Link a row'}
              onClick={() => setPicking(!picking)}
            >
              {picking ? 'Close' : link ? 'Relink' : 'Link row'}
            </button>
          )}
          <SheetColoursToggle />
          <ScaleControl />
        </RightPaneHeader>
      }
    >
      <div
        className={styles.zoom}
        style={{ zoom: scale / 100 }}
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
                : 'No saved snapshot to compare.'}{' '}
              <a
                href={matchedWhere?.href}
                target="_blank"
                rel="noreferrer"
                title="Open in the sheet"
              >
                {matchedWhere?.label} ↗
              </a>
            </p>
            <div style={{ contain: 'layout style' }}>
              {approved ? (
                <>
                  {!roomy && <div className={styles.diffModes}>{diffToggle}</div>}
                  {preparedDiff.pair ? (
                    <ApprovalDiff
                      before={preparedDiff.pair.before}
                      after={preparedDiff.pair.after}
                      mode={diffMode}
                    />
                  ) : (
                    <SheetCell background={matched.row.cell.background}>
                      <RichCell cell={matched.row.cell} />
                    </SheetCell>
                  )}
                </>
              ) : (
                <SheetCell background={matched.row.cell.background}>
                  <RichCell cell={matched.row.cell} />
                </SheetCell>
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
                {link.rowKey} {link.section && `/ ${link.section}`} / tab {link.gid}
              </span>{' '}
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
                        : 'Matches the saved snapshot.'}{' '}
                  <a
                    href={linkedWhere?.href}
                    target="_blank"
                    rel="noreferrer"
                    title="Open in the sheet"
                  >
                    {linkedWhere?.label} ↗
                  </a>
                </p>
                {!roomy && <div className={styles.diffModes}>{diffToggle}</div>}
                {preparedDiff.pair ? (
                  <CompendiumDiff
                    before={preparedDiff.pair.before}
                    after={preparedDiff.pair.after}
                    mode={diffMode}
                  />
                ) : (
                  <SheetCell background={match.row.cell.background}>
                    <RichCell cell={match.row.cell} />
                  </SheetCell>
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
                        {candidate.tab.name} / {candidate.row.name}{' '}
                        {candidate.row.section && `/ ${candidate.row.section}`} (
                        {Math.round(candidate.similarity * 100)}% content match)
                      </p>
                      <SheetCell background={candidate.row.cell.background}>
                        <RichCell cell={candidate.row.cell} />
                      </SheetCell>
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
            {!match && (
              <SheetCell>
                <RichCell cell={link.snapshot} />
              </SheetCell>
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
  useLayoutEffect(() => {
    if (!waiting) {
      retainedPane.current = pane;
      hasContent.current = true;
    }
  });
  if (!waiting) return pane;
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
  const loadingHeader = (
    <RightPaneHeader title="Compendium">
      {pendingLink && roomy && (
        <CompendiumDiffModeToggle mode={diffMode} onChange={setDiffMode} disabled />
      )}
      {canEdit && (
        <button type="button" disabled>
          {pendingLink ? 'Relink' : 'Link row'}
        </button>
      )}
      <SheetColoursToggle disabled />
      <ScaleControl disabled />
    </RightPaneHeader>
  );
  return cloneElement(previous ?? pane, {
    busy: true,
    label: `Compendium for ${pendingItem?.name ?? pendingBase.hash}`,
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
            after={pendingCell}
            sourceFetchedAt={compendium?.fetchedAt}
            width={width}
            scale={scale}
            remPx={(headerMin / HEADER_TOGGLE_MIN) * 16}
            mode={diffMode}
            phone={phone}
            canEdit={canEdit}
            canReview={canReview}
            roomy={roomy}
            diffControl={
              <CompendiumDiffModeToggle mode={diffMode} onChange={setDiffMode} disabled />
            }
          />
        )}
      </>
    ),
  });
});
