import { BatchRefusal, PartialBatchSave } from '../../../services/scheduled/api';
import { errorMessage } from '../../../services/http';
import { fieldList } from './model';
import styles from './Batches.module.scss';

/**
 * A refused batch request, shown as the Worker worded it, with what it listed per tooltip
 * (stale fields, unpublished fields, conflicts). The server rules stay the guard; this only shows
 * them.
 */
export function Refusal({ error, names }: { error: unknown; names: (hash: number) => string }) {
  const partial = error instanceof PartialBatchSave ? error : null;
  const refusal =
    error instanceof BatchRefusal
      ? error
      : partial?.reason instanceof BatchRefusal
        ? partial.reason
        : null;
  const message = refusal?.message ?? errorMessage(partial?.reason ?? error);
  return (
    <div role="alert" className={styles.refusal} data-refusal>
      <p>{message}</p>
      {refusal && refusal.members.length > 0 && (
        <ul>
          {refusal.members.map((member) => (
            <li key={member.hash}>
              {names(member.hash)} <span className={styles.muted}>{member.hash}</span>
              {member.fields?.length ? `: ${fieldList(member.fields)}` : ''}
              {member.reason ? ` (${member.reason})` : ''}
            </li>
          ))}
        </ul>
      )}
      {refusal?.missing?.length ? <p>Needs a choice: {fieldList(refusal.missing)}</p> : null}
    </div>
  );
}
