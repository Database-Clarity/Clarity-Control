import { useState } from 'react';
import { errorMessage } from '../../services/http';
import { replaceDraft } from '../../services/save/drafts';
import { useSaveState } from '../../services/save/state';
import { useAuthStore } from '../../stores/auth';
import { useDataStore } from '../../stores/data';
import { useDraftStore } from '../../stores/drafts';
import { When } from '../../ui/When';
import { ReadingTooltip } from '../preview/ReadingTooltip';
import { dismissRecord, isDismissed, useLostDecisions } from '../lost-text/decisions';
import { canRecover, recoveryDraft, type LostText } from '../lost-text/model';
import type { QueueItem } from './model';
import styles from './QueueControl.module.scss';

/**
 * Lost text's finishing actions in the editor: the last non-empty text, Recover as draft (into
 * this editor, saved through the normal flow), and Dismiss (this browser only), as on the list.
 */
export default function LostPanel({ item }: { item: QueueItem }) {
  const record = item.detail as LostText;
  const data = useDataStore((state) => state.data);
  const user = useAuthStore((state) => state.user);
  const hydrated = useDraftStore((state) => state.hydrated);
  const draft = useDraftStore((state) => state.drafts[record.hash]);
  const locked = useSaveState((state) => state.locked);
  const decisions = useLostDecisions(user);
  const [error, setError] = useState('');
  if (!data) return null;
  const base = data.bundle.tooltips[record.hash];
  const current = draft?.next ?? base;
  const hasText = Boolean(current?.text[record.lang]?.text.trim());
  const editable = canRecover(user);
  return (
    <div className={styles.panel}>
      <p className={styles.panelNote}>
        {record.classification}: {record.reason} Cleared <When nowrap value={record.clearingDate} />{' '}
        by {record.clearingAuthor}.
      </p>
      <div className={styles.reading}>
        <ReadingTooltip text={record.text} lang={record.lang} hash={record.hash} />
      </div>
      {error && <p role="alert">{error}</p>}
      {hasText ? (
        <p className={styles.panelNote}>This language has text now (a draft or saved).</p>
      ) : isDismissed(decisions, record) ? (
        <p className={styles.panelNote}>Dismissed in this browser.</p>
      ) : null}
      {editable && (
        <div className={styles.panelActions}>
          <button
            type="button"
            disabled={!hydrated || locked || !base || hasText}
            title="Put the earlier text into this editor as an unsaved draft"
            onClick={() => {
              if (!base || !current || !user) return;
              setError('');
              try {
                replaceDraft(base, recoveryDraft(current, record, user));
              } catch (cause) {
                setError(errorMessage(cause));
              }
            }}
          >
            Recover as draft
          </button>
          <button
            type="button"
            disabled={locked || isDismissed(decisions, record)}
            title="Hide this record for you in this browser; it reopens if its history changes"
            onClick={() => {
              setError('');
              try {
                dismissRecord(user, record);
              } catch (cause) {
                setError(`Dismissal was not stored: ${errorMessage(cause)}`);
              }
            }}
          >
            Dismiss
          </button>
        </div>
      )}
    </div>
  );
}
