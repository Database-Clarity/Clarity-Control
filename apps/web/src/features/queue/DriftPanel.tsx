import { useState } from 'react';
import { apiUrl } from '../../services/api';
import { errorMessage } from '../../services/http';
import { reviewSaveChanges, useSaveState } from '../../services/save/state';
import { useAuthStore } from '../../stores/auth';
import { useDataStore } from '../../stores/data';
import { WordDiff } from '../../ui/diff';
import { When } from '../../ui/When';
import { canEditTooltipFields } from '../auth/permissions';
import { reviewedSnapshot } from '../drift/review';
import type { QueueItem } from './model';
import { stillDrifts } from './sources';
import styles from './QueueControl.module.scss';

/**
 * Bungie drift's finishing action in the editor: the in-game description's change since the
 * saved snapshot, and Mark reviewed (the same save the Drift list makes: only the snapshot).
 */
export default function DriftPanel({ item }: { item: QueueItem }) {
  const data = useDataStore((state) => state.data);
  const user = useAuthStore((state) => state.user);
  const locked = useSaveState((state) => state.locked);
  const [error, setError] = useState('');
  if (!data) return null;
  const tooltip = data.bundle.tooltips[item.hash];
  const description = data.items[item.hash]?.inGameDescription;
  if (!tooltip || description === undefined)
    return <p className={styles.panelNote}>This tooltip is no longer in the manifest.</p>;
  if (!stillDrifts(item.hash, data))
    return (
      <p className={styles.panelNote}>
        Reviewed: the saved snapshot matches the in-game description.
      </p>
    );
  const canReview = Boolean(apiUrl && canEditTooltipFields(user));
  return (
    <div className={styles.panel}>
      <p className={styles.panelNote}>
        Snapshot <When value={tooltip.bungieSnapshot?.snapshotAt} fallback="none" />. Removed words
        are struck through; added words are underlined.
      </p>
      <div className={styles.diff}>
        <WordDiff before={tooltip.bungieSnapshot?.description ?? ''} after={description} />
      </div>
      {error && <p role="alert">{error}</p>}
      <div className={styles.panelActions}>
        <button
          type="button"
          disabled={!canReview || locked}
          title={
            canReview
              ? 'Save the new in-game description as the reviewed snapshot (no text changes)'
              : 'Sign in as a maintainer, editor or trial editor to mark descriptions reviewed'
          }
          onClick={() => {
            setError('');
            try {
              reviewSaveChanges([
                {
                  hash: tooltip.hash,
                  base: tooltip,
                  next: reviewedSnapshot(tooltip, description, new Date().toISOString()),
                },
              ]);
            } catch (cause) {
              setError(errorMessage(cause));
            }
          }}
        >
          Mark reviewed
        </button>
        <span className={styles.panelNote}>Uses the saved tooltip, not this draft.</span>
      </div>
    </div>
  );
}
