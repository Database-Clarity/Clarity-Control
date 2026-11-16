import { memo, useCallback, useMemo } from 'react';
import { useDraftStore } from '../../stores/drafts';
import { upcomingStore } from '../tooltip/UpcomingSwitch.store';
import { TitleAnchor } from '../preview/MarkupRenderer';
import { Missing, Outdated } from './finderMarkerState';
import styles from './FinderMarkers.module.scss';

const markers = [
  {
    flag: Missing,
    kind: 'missing',
    label: 'Missing tooltip',
    explanation: 'English tooltip text is needed but has not been saved.',
  },
  {
    flag: Outdated,
    kind: 'outdated',
    label: 'Outdated',
    explanation:
      'The Compendium source changed since the English snapshot, or this translation is behind English.',
  },
  {
    flag: 4,
    kind: 'scheduled',
    label: 'Scheduled',
    explanation: 'An entry is waiting in an open scheduled publish batch.',
  },
  {
    flag: 8,
    kind: 'unsaved',
    label: 'Unsaved changes',
    explanation: 'An entry has local changes that have not been saved.',
  },
] as const;

/** A schedule still being prepared or that failed preparation keeps the marker, with its state. */
const pendingMarkers = {
  preparing: {
    ...markers[2],
    label: 'Scheduled · preparing',
    explanation:
      'An entry is in a batch whose schedule is being prepared; it is not scheduled yet.',
  },
  needs_attention: {
    ...markers[2],
    kind: 'attention',
    label: 'Scheduled · needs attention',
    explanation:
      'Preparing the schedule of this entry’s batch failed, so it will not publish. Review → Batches shows the reasons.',
  },
} as const;

function ScheduledMarker({ hashes }: { hashes: ReadonlySet<number> }) {
  // A primitive selection: only a change of the shown state re-renders the row.
  const state = upcomingStore()((store) => {
    let found: 'scheduled' | 'preparing' | 'needs_attention' | null = null;
    for (const [hash, batch] of Object.entries(store.memberOf)) {
      if (!hashes.has(Number(hash))) continue;
      if (batch.status === 'needs_attention' && batch.notBefore !== null) return batch.status;
      if (batch.status === 'preparing' && batch.notBefore !== null) found = batch.status;
      else if (batch.status === 'scheduled') found ??= 'scheduled';
    }
    return found;
  });
  if (!state) return null;
  return <Glyph marker={state === 'scheduled' ? markers[2] : pendingMarkers[state]} />;
}

function Glyph({
  marker,
}: {
  marker: (typeof markers)[number] | (typeof pendingMarkers)[keyof typeof pendingMarkers];
}) {
  return (
    <TitleAnchor part={{ text: '', title: [{ linesContent: [{ text: marker.explanation }] }] }}>
      <span role="img" aria-label={marker.label} className={styles.glyph} data-kind={marker.kind} />
    </TitleAnchor>
  );
}

/** Boolean selectors keep ordinary edits from reconciling the finder or its category lists. */
export const FinderMarkers = memo(function FinderMarkers({
  hashes,
  flags = 0,
}: {
  hashes: readonly number[];
  flags?: number;
}) {
  const members = useMemo(() => new Set(hashes), [hashes]);
  const selectUnsaved = useCallback(
    (state: ReturnType<typeof useDraftStore.getState>) =>
      hashes.some((hash) => !!state.drafts[hash]),
    [hashes],
  );
  const unsaved = useDraftStore(selectUnsaved);
  return (
    <span
      className={styles.slot}
      onClick={(event) => {
        // The glyph opens its explanation; unused slot space still selects the row.
        if (event.target instanceof Element && event.target.closest('[aria-describedby]'))
          event.stopPropagation();
      }}
    >
      {markers
        .slice(0, 2)
        .map((marker) =>
          flags & marker.flag ? <Glyph key={marker.kind} marker={marker} /> : null,
        )}
      {import.meta.env.VITE_SCHEDULED_ENABLED === '1' && <ScheduledMarker hashes={members} />}
      {unsaved && <Glyph marker={markers[3]} />}
    </span>
  );
});
