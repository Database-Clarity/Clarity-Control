import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { CustomSnippet } from '../../../../../packages/core/src/customSnippets';
import { SnippetConflictError } from '../../services/snippets';
import {
  SnippetFields,
  saveError,
  snippetErrors,
  type SnippetDraft,
  type SnippetErrors,
} from './SnippetFields';
import styles from './Snippets.module.scss';
import { plainError } from '../../services/httpError';
import { InlineAlert } from '../../ui/InlineAlert';

const blank: SnippetDraft = { label: '', keywords: '', template: '' };
const draftOf = (snippet: CustomSnippet): SnippetDraft => ({
  label: snippet.label,
  keywords: snippet.keywords ?? '',
  template: snippet.template,
});

export const conflictMessage =
  'This snippet changed somewhere else since this list loaded. Reload to see the current version, then make your change again.';

/**
 * A list of snippets with edit, delete, and new: Settings → Snippets (yours) and Management →
 * Team snippets share it. `save` writes one entry (null deletes) and throws SnippetConflictError
 * when the stored entry moved on; the list then says so and offers Reload.
 */
export function SnippetManager({
  name,
  snippets,
  limit,
  status,
  onReload,
  save,
  newId,
  actions,
  rowActions,
}: {
  /** "snippet" wording in buttons stays the same; this names the list for screen readers. */
  name: string;
  snippets: readonly CustomSnippet[] | null;
  limit: number;
  /** Loading or a load error, shown in place of the list. */
  status: { loading: boolean; error: string | null };
  onReload(): void;
  save(current: CustomSnippet | null, next: CustomSnippet | null): Promise<void>;
  newId(): string;
  /** Extra list-level actions (Copy from my snippets, Add the starter snippets). */
  actions?: ReactNode;
  /** Extra per-row actions. */
  rowActions?(snippet: CustomSnippet, busy: boolean): ReactNode;
}) {
  const [editing, setEditing] = useState<CustomSnippet | 'new' | null>(null);
  const [draft, setDraft] = useState<SnippetDraft>(blank);
  const [errors, setErrors] = useState<SnippetErrors>({});
  const [checked, setChecked] = useState(false);
  const [deleting, setDeleting] = useState<CustomSnippet | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{
    text: string;
    kind: 'done' | 'conflict' | 'error';
  } | null>(null);
  const list = snippets ?? [];
  const full = list.length >= limit;
  // Where keyboard focus goes after an action (Edit/New focus Label through SnippetFields).
  const root = useRef<HTMLDivElement>(null);
  const [focus, setFocus] = useState<string | null>(null);
  useLayoutEffect(() => {
    if (!focus) return;
    const target = root.current?.querySelector<HTMLElement>(focus);
    // A control disabled while saving takes focus once the save settles.
    if (!target || (target as HTMLButtonElement).disabled) return;
    target.focus();
    setFocus(null);
  }, [focus, busy]);
  const back = (target: CustomSnippet | 'new' | null) =>
    setFocus(target && target !== 'new' ? `[data-edit="${target.id}"]` : '[data-new]');

  const others = (except: CustomSnippet | 'new' | null) =>
    list.filter((snippet) => except === 'new' || snippet.id !== except?.id).map((s) => s.label);

  function start(target: CustomSnippet | 'new') {
    setEditing(target);
    setDraft(target === 'new' ? blank : draftOf(target));
    setErrors({});
    setChecked(false);
    setDeleting(null);
    setNotice(null);
  }

  async function run(action: () => Promise<void>, done: string) {
    setBusy(true);
    setNotice(null);
    try {
      await action();
      setNotice({ text: done, kind: 'done' });
      return true;
    } catch (error) {
      setNotice(
        error instanceof SnippetConflictError
          ? { text: conflictMessage, kind: 'conflict' }
          : { text: saveError(error), kind: 'error' },
      );
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!editing || busy) return;
    const found = snippetErrors(draft, others(editing));
    setErrors(found);
    setChecked(true);
    if (Object.keys(found).length) return;
    const next: CustomSnippet = {
      id: editing === 'new' ? newId() : editing.id,
      label: draft.label.trim(),
      template: draft.template,
      ...(draft.keywords.trim() ? { keywords: draft.keywords.trim() } : {}),
    };
    const ok = await run(
      () => save(editing === 'new' ? null : editing, next),
      editing === 'new' ? `Saved “${next.label}”.` : `Updated “${next.label}”.`,
    );
    if (ok) {
      setEditing(null);
      setFocus(`[data-edit="${next.id}"]`);
    } else setFocus('[data-save]'); // A refused save keeps the form: focus back on Save.
  }

  async function remove(snippet: CustomSnippet) {
    const ok = await run(() => save(snippet, null), `Deleted “${snippet.label}”.`);
    if (ok) {
      setDeleting(null);
      setFocus('[data-new]');
    } else setFocus('[data-confirm]');
  }

  const form = editing && (
    <form className={styles.form} onSubmit={(event) => void submit(event)} noValidate>
      <SnippetFields
        draft={draft}
        errors={errors}
        disabled={busy}
        autoFocus
        onChange={(next) => {
          setDraft(next);
          // Once a save was refused, the messages follow the edits.
          if (checked) setErrors(snippetErrors(next, others(editing)));
        }}
      />
      <div className={styles.actions}>
        <button type="submit" data-primary data-save disabled={busy}>
          {busy ? 'Saving…' : editing === 'new' ? 'Save snippet' : 'Save changes'}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            back(editing);
            setEditing(null);
          }}
        >
          Cancel
        </button>
      </div>
    </form>
  );

  return (
    <div ref={root} className={styles.manager}>
      <div className={styles.toolbar}>
        <span className={styles.count}>
          {snippets ? `${list.length} of ${limit}${full ? ' · limit reached' : ''}` : ''}
        </span>
        <button
          type="button"
          data-new
          disabled={busy || full || !snippets || editing === 'new'}
          title={full ? `The limit is ${limit} snippets` : undefined}
          onClick={() => start('new')}
        >
          New snippet
        </button>
        {actions}
      </div>
      {notice && (
        <p
          className={notice.kind === 'done' ? styles.notice : styles.conflict}
          role={notice.kind === 'done' ? 'status' : 'alert'}
        >
          {notice.text}{' '}
          {notice.kind === 'conflict' && (
            <button
              type="button"
              onClick={() => {
                setNotice(null);
                setEditing(null);
                onReload();
              }}
            >
              Reload
            </button>
          )}
        </p>
      )}
      {editing === 'new' && form}
      {status.loading && !snippets ? (
        <p className={styles.muted} role="status">
          Loading snippets…
        </p>
      ) : status.error ? (
        <InlineAlert onRetry={onReload}>{plainError(status.error)}</InlineAlert>
      ) : !list.length ? (
        editing !== 'new' && (
          <p className={styles.muted}>No snippets yet. Add one with New snippet.</p>
        )
      ) : (
        <ul className={styles.list} aria-label={name}>
          {list.map((snippet) => (
            <li key={snippet.id} className={styles.row}>
              {editing !== 'new' && editing?.id === snippet.id ? (
                form
              ) : (
                <>
                  <div className={styles.summary}>
                    <span className={styles.label}>{snippet.label}</span>
                    <code className={styles.text}>{snippet.template}</code>
                  </div>
                  {deleting?.id === snippet.id ? (
                    <div className={styles.rowActions} role="group" aria-label="Confirm delete">
                      <button
                        type="button"
                        data-confirm
                        aria-label={`Delete “${snippet.label}”`}
                        disabled={busy}
                        onClick={() => void remove(snippet)}
                      >
                        Delete
                      </button>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => {
                          setDeleting(null);
                          setFocus(`[data-delete="${snippet.id}"]`);
                        }}
                      >
                        Keep
                      </button>
                    </div>
                  ) : (
                    <div className={styles.rowActions}>
                      {rowActions?.(snippet, busy)}
                      <button
                        type="button"
                        data-edit={snippet.id}
                        aria-label={`Edit ${snippet.label}`}
                        disabled={busy}
                        onClick={() => start(snippet)}
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        data-delete={snippet.id}
                        aria-label={`Delete ${snippet.label}`}
                        disabled={busy}
                        onClick={() => {
                          setDeleting(snippet);
                          setFocus('[data-confirm]');
                          setNotice(null);
                        }}
                      >
                        Delete
                      </button>
                    </div>
                  )}
                </>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
