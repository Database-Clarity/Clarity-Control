import {
  memo,
  startTransition,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { flushSync } from 'react-dom';
import { resolveCompendiumLink, snapshotCompendium, sameCell, type Tooltip } from '@clarity/core';
import { approvalEvidence } from './approvalEvidence';
import { usePreparedPaneDiff } from './usePreparedPaneDiff';
import { initializeCompendiumDiffWorker, prepareCompendiumDiff } from './compendiumDiffCache';
import { useAuthStore } from '../../stores/auth';
import { useDataStore } from '../../stores/data';
import { useDraftStore } from '../../stores/drafts';
import { compendiumScales, useSettingsStore } from '../../stores/settings';
import { apiUrl } from '../../services/api';
import { reviewSaveChanges, useSaveState } from '../../services/save/state';
import { itemFor } from '../navigation/catalog';
import { CompendiumDiff, CompendiumDiffModeToggle, useCompendiumDiffMode } from './CompendiumDiff';
import { RichCell } from './RichCell';
import { SheetCell, SheetColoursToggle } from './sheetSurface';
import { LinkPicker } from './LinkPicker';
import { useCompendiumStore } from './store';
import { When } from '../../ui/When';
import { RightPane, RightPaneHeader } from '../../ui/RightPane';
import { useElementWidth } from '../../ui/useElementWidth';
import { phoneQuery, useMedia } from '../../ui/useMedia';
import { scaledPx } from '../../ui/scale';
import styles from './Compendium.module.scss';
import { confirmCompendiumSelection } from './selection';
import { usePaneMatch } from './usePaneMatch';
import { useDisplayMatches } from './useDisplayMatches';
import { openDraftSaveReview } from '../../services/save/openReview';

/**
 * Below this pane width (design pixels at 100 % interface scale; scaledPx() follows the scale) the
 * Changes / Before-After switch moves from the header to above the diff. Measured: title + switch +
 * Relink + sheet colours + zoom need 373px, so the default 384px pane keeps it in the header
 * with room to spare for font rounding.
 */
const HEADER_TOGGLE_MIN = 381;
const ApprovalDiff = memo(CompendiumDiff);

/** Compendium zoom (70–100 %), kept on this device: − / value / +. */
function ScaleControl() {
  const scale = useSettingsStore((state) => state.device.compendiumScale);
  const updateDevice = useSettingsStore((state) => state.updateDevice);
  const index = Math.max(0, compendiumScales.indexOf(scale as (typeof compendiumScales)[number]));
  const step = (by: number) =>
    updateDevice({ compendiumScale: compendiumScales[index + by] ?? scale });
  return (
    <span className={styles.scale} role="group" aria-label="Compendium zoom">
      <button type="button" aria-label="Smaller" disabled={index === 0} onClick={() => step(-1)}>
        −
      </button>
      <output aria-live="polite">{scale}%</output>
      <button
        type="button"
        aria-label="Larger"
        disabled={index === compendiumScales.length - 1}
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
) {
  const [ready, setReady] = useState(base);
  const committed = useRef(base);
  const frame = useRef<number>();
  const generation = useRef(0);
  // A frame callback can fire just before a newer navigation render. Its queued
  // update must not make that superseded tooltip visible, even for one commit.
  const displayed = ready === base ? base : committed.current;
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
    [base, prepare],
  );
  useEffect(() => {
    if (displayed === base) return;
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
  }, [base, displayed, prepare, concurrent]);
  return displayed;
}

export function CompendiumPanel({ base }: { base: Tooltip }) {
  const editor = useDataStore((state) => state.data);
  const source = useCompendiumStore((state) => state.data);
  const drafts = useDraftStore((state) => state.drafts);
  const userId = useAuthStore((state) => state.user?.id);
  const diffMode = useSettingsStore((state) => state.device.remembered.compendiumDiff);
  // One subscription supplies both the incoming preparation and displayed row.
  // Repeated subscriptions each decoded the same worker reply during a switch.
  const {
    matches,
    loading: matching,
    error: matchError,
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
  }, [base, incomingLink, source, incomingMatch, editor]);
  const prepare = useCallback(
    (signal: AbortSignal) => {
      // Keep the old pane until the incoming row can be prepared. Committing an
      // empty pane first would paint its plain cell and then replace it again
      // when the worker projection arrives.
      if (awaitingMatch) return false;
      if (!comparison) return;
      const preparation = prepareCompendiumDiff(comparison.before, comparison.after, signal);
      if (diffMode === 'before-after') {
        void preparation?.catch(() => undefined);
        return;
      }
      return preparation;
    },
    [awaitingMatch, comparison, diffMode],
  );
  const displayed = usePaneFrame(
    base,
    prepare,
    !!comparison && !sameCell(comparison.before, comparison.after),
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
      link={retainedLink.current.value}
      draft={!!draft && !!link}
      matched={matched}
      matching={matching}
      matchError={matchError}
    />
  );
}

// Rapid finder navigation keeps the previous styled cell until React can paint the final item.
// The cheap wrapper absorbs intermediate items; link/review actions pause while it catches up.
const PaneContents = memo(function PaneContents({
  base,
  pending: navigating,
  link,
  draft,
  matched,
  matching,
  matchError,
}: {
  base: Tooltip;
  pending: boolean;
  link: Tooltip['compendium'];
  draft: boolean;
  matched: ReturnType<typeof usePaneMatch>;
  matching: boolean;
  matchError?: string;
}) {
  const { data: compendium, loading, error, load } = useCompendiumStore();
  const data = useDataStore((state) => state.data);
  const updateDraft = useDraftStore((state) => state.updateDraft);
  const hydrated = useDraftStore((state) => state.hydrated);
  const user = useAuthStore((state) => state.user);
  const saving = useSaveState((state) => state.locked);
  const [picking, setPicking] = useState(false);
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
  const approvalChanged = approved && matched && !sameCell(approved, matched.row.cell);
  const comparisonBefore = link && match ? link.snapshot : !link ? approved : undefined;
  const comparisonAfter = link && match ? match.row.cell : !link ? matched?.row.cell : undefined;
  const preparedDiff = usePreparedPaneDiff(comparisonBefore, comparisonAfter, diffMode);
  const pending = navigating || preparedDiff.pending;

  const diffToggle = <CompendiumDiffModeToggle mode={diffMode} onChange={setDiffMode} />;
  return (
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
          <div className={styles.picker}>
            <LinkPicker
              base={base}
              name={item?.name ?? base.custom?.name ?? ''}
              category={item?.categoryId ?? 'other'}
              readOnly={pending}
              onLinked={() => setPicking(false)}
            />
          </div>
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
                {matched.tab.name} / {matched.row.name}
              </>
            ) : matching ? (
              'Matching Compendium…'
            ) : !loading && !matchError ? (
              'No Compendium row linked yet.'
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
                href={`https://docs.google.com/spreadsheets/d/1WaxvbLx7UoSZaBqdFr1u32F2uWVLo-CJunJB4nlGUE4/htmlview#gid=${matched.tab.gid}`}
                target="_blank"
                rel="noreferrer"
              >
                Open source tab
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
                    href={`https://docs.google.com/spreadsheets/d/1WaxvbLx7UoSZaBqdFr1u32F2uWVLo-CJunJB4nlGUE4/htmlview#gid=${match.tab.gid}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Open source tab
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
});
