import { useReducer, useState } from 'react';
import type { Change, SaveConflict } from '../../services/api';
import { Dialog } from '../../ui/Dialog';
import { conflictReducer, displayField, resolutionKey, resolveConflicts } from './reducer';
import styles from './ConflictDialog.module.scss';

export function ConflictDialog({
  changes,
  conflicts,
  onResolve,
  onClose,
}: {
  changes: Change[];
  conflicts: SaveConflict[];
  onResolve(result: ReturnType<typeof resolveConflicts>): void;
  onClose(): void;
}) {
  const [resolutions, dispatch] = useReducer(conflictReducer, {});
  const [error, setError] = useState<string | null>(null);
  const complete = conflicts.every((conflict) =>
    conflict.fields.every((field) => resolutions[resolutionKey(conflict.hash, field)]),
  );
  return (
    <Dialog
      title="Resolve concurrent changes"
      onClose={onClose}
      footer={
        <button
          type="button"
          disabled={!complete}
          onClick={() => {
            try {
              onResolve(resolveConflicts(changes, conflicts, resolutions));
            } catch (error) {
              setError(error instanceof Error ? error.message : String(error));
            }
          }}
        >
          Review resolved changes
        </button>
      }
    >
      <p>
        Nothing was saved. Resolve each field, then review and save again against the server's
        latest version.
      </p>
      {conflicts.map((conflict) => (
        <section key={conflict.hash}>
          <h3>Tooltip {conflict.hash}</h3>
          {conflict.fields.map((field) => {
            const resolution = resolutions[resolutionKey(conflict.hash, field)];
            return (
              <fieldset key={field}>
                <legend>{field}</legend>
                <div className={styles.versions}>
                  {(['head', 'next'] as const).map((version) => (
                    <section key={version}>
                      <h4>{version === 'head' ? 'Theirs' : 'Mine'}</h4>
                      <pre>{displayField(conflict[version], field)}</pre>
                    </section>
                  ))}
                </div>
                <details className={styles.base}>
                  <summary>Show base (common ancestor)</summary>
                  <pre>{displayField(conflict.base, field)}</pre>
                </details>
                <div className={styles.actions}>
                  <button
                    type="button"
                    aria-pressed={resolution?.choice === 'theirs'}
                    onClick={() =>
                      dispatch({ hash: conflict.hash, field, resolution: { choice: 'theirs' } })
                    }
                  >
                    Use theirs
                  </button>
                  <button
                    type="button"
                    aria-pressed={resolution?.choice === 'mine'}
                    onClick={() =>
                      dispatch({ hash: conflict.hash, field, resolution: { choice: 'mine' } })
                    }
                  >
                    Use mine
                  </button>
                  <button
                    type="button"
                    aria-pressed={resolution?.choice === 'edit'}
                    onClick={() =>
                      dispatch({
                        hash: conflict.hash,
                        field,
                        resolution: {
                          choice: 'edit',
                          text: displayField(conflict.next, field),
                        },
                      })
                    }
                  >
                    Edit merged {field.startsWith('text.') ? 'text' : 'JSON'}
                  </button>
                </div>
                {resolution?.choice === 'edit' && (
                  <label>
                    Merged {field}
                    <textarea
                      value={resolution.text}
                      onChange={(event) =>
                        dispatch({
                          hash: conflict.hash,
                          field,
                          resolution: { choice: 'edit', text: event.target.value },
                        })
                      }
                    />
                  </label>
                )}
              </fieldset>
            );
          })}
        </section>
      ))}
      {error && <p role="alert">{error}</p>}
    </Dialog>
  );
}
