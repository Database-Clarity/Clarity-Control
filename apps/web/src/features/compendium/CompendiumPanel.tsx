import { memo, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { resolveCompendiumLink, snapshotCompendium, type Tooltip } from '@clarity/core';
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

export function CompendiumPanel({ base }: { base: Tooltip }) {
  const displayed = useDeferredValue(base);
  return <PaneContents base={displayed} pending={displayed !== base} />;
}

// Rapid finder navigation keeps the previous styled cell until React can paint the final item.
// The cheap wrapper absorbs intermediate items; link/review actions pause while it catches up.
const PaneContents = memo(function PaneContents({
  base,
  pending,
}: {
  base: Tooltip;
  pending: boolean;
}) {
  const { data: compendium, loading, error, load } = useCompendiumStore();
  const data = useDataStore((state) => state.data);
  const drafts = useDraftStore((state) => state.drafts);
  const draft = drafts[base.hash];
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
  const roomy = !touch && (width === undefined || width >= scaledPx(HEADER_TOGGLE_MIN));
  const tooltip = draft?.next ?? base;
  const link = tooltip.compendium;
  const matched = usePaneMatch(base, data, compendium, drafts, user?.id);
  const { loading: matching, error: matchError } = useDisplayMatches(
    data,
    compendium,
    drafts,
    user?.id,
  );
  const canEdit =
    !pending &&
    !!apiUrl &&
    hydrated &&
    !saving &&
    !!user?.role &&
    ['maintainer', 'editor', 'trial'].includes(user.role);
  const canReview =
    !pending &&
    !!apiUrl &&
    hydrated &&
    !saving &&
    !!user?.role &&
    ['maintainer', 'editor'].includes(user.role);
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
  const diffToggle = <CompendiumDiffModeToggle mode={diffMode} onChange={setDiffMode} />;
  return (
    <RightPane
      label={`Compendium for ${item?.name ?? base.hash}`}
      bodyRef={bodyRef}
      header={
        <RightPaneHeader title="Compendium">
          {match && roomy && diffToggle}
          {canEdit && (
            <button
              type="button"
              className={styles.headerButton}
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
      <div className={styles.zoom} style={{ zoom: scale / 100 }} data-scale={scale}>
        {picking && canEdit && (
          <div className={styles.picker}>
            <LinkPicker
              base={base}
              name={item?.name ?? base.custom?.name ?? ''}
              category={item?.categoryId ?? 'other'}
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
        {!link && matching && <p role="status">Matching Compendium…</p>}
        {!link && matchError && <p role="alert">{matchError}</p>}
        {!link && !matched && !matching && !loading && !matchError && (
          <p>No Compendium row linked yet.</p>
        )}
        {!link && matched && (
          <>
            <p className={styles.meta}>
              <span
                className={styles.matched}
                title="Matched automatically — not saved"
                tabIndex={0}
              >
                Matched
              </span>{' '}
              {matched.tab.name} / {matched.row.name}
            </p>
            <p>
              No saved snapshot to compare.{' '}
              <a
                href={`https://docs.google.com/spreadsheets/d/1WaxvbLx7UoSZaBqdFr1u32F2uWVLo-CJunJB4nlGUE4/htmlview#gid=${matched.tab.gid}`}
                target="_blank"
                rel="noreferrer"
              >
                Open source tab
              </a>
            </p>
            <SheetCell background={matched.row.cell.background}>
              <RichCell cell={matched.row.cell} />
            </SheetCell>
            {canEdit && (
              <div className={styles.actions}>
                <button
                  type="button"
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
                <CompendiumDiff before={link.snapshot} after={match.row.cell} mode={diffMode} />
                {canReview && (
                  <div className={styles.actions}>
                    <button
                      type="button"
                      disabled={!!draft || match.status === 'ok'}
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
                            !compendium || !confirmCompendiumSelection(candidate, compendium)
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
                  <button type="button" onClick={() => setPicking(true)}>
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
              <button type="button" onClick={openDraftSaveReview}>
                Review &amp; save draft
              </button>
            )}
            <button
              type="button"
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
