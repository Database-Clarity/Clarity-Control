import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Dialog } from '../../ui/Dialog';
import { savePersonalSnippet } from '../../services/snippets';
import { invalidateSnippetCatalogue } from '../editor/suggest/custom';
import {
  SnippetFields,
  saveError,
  snippetErrors,
  type SnippetDraft,
  type SnippetErrors,
} from './SnippetFields';
import styles from './Snippets.module.scss';

/**
 * "Save as snippet" (Ctrl+Space with text selected): the selection becomes one of your snippets
 * under a label, with optional keywords. The shared validator's messages show under each field.
 */
export function SaveSnippetDialog({
  text,
  onClose,
  existingLabels = [],
}: {
  text: string;
  onClose(): void;
  /** Labels of your other snippets, when known: a duplicate is refused before saving. */
  existingLabels?: readonly string[];
}) {
  const [draft, setDraft] = useState<SnippetDraft>({ label: '', keywords: '', template: text });
  const [errors, setErrors] = useState<SnippetErrors>({});
  const [checked, setChecked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const form = useRef<HTMLFormElement>(null);
  // After the dialog opens (showModal moves focus to its first control): start on Label.
  useEffect(() => form.current?.querySelector<HTMLInputElement>('input')?.focus(), []);

  async function save(event?: React.FormEvent) {
    event?.preventDefault();
    if (busy) return;
    const found = snippetErrors(draft, existingLabels);
    setErrors(found);
    setChecked(true);
    if (Object.keys(found).length) return;
    setBusy(true);
    setFailure(null);
    try {
      const id = `me:${crypto.randomUUID()}`;
      await savePersonalSnippet(
        id,
        {
          id,
          label: draft.label.trim(),
          template: draft.template,
          ...(draft.keywords.trim() ? { keywords: draft.keywords.trim() } : {}),
        },
        null,
      );
      invalidateSnippetCatalogue();
      onClose();
    } catch (error) {
      setFailure(saveError(error));
      setBusy(false);
    }
  }

  // Out of the editor's tree, so none of its styles reach the form.
  return createPortal(
    <Dialog
      title="Save as snippet"
      form
      busy={busy}
      onClose={onClose}
      footer={
        <>
          <button type="submit" form="save-snippet" data-primary disabled={busy}>
            {busy ? 'Saving…' : 'Save snippet'}
          </button>
          <button type="button" disabled={busy} onClick={onClose}>
            Cancel
          </button>
        </>
      }
    >
      <form
        ref={form}
        id="save-snippet"
        className={styles.form}
        onSubmit={(event) => void save(event)}
        noValidate
      >
        <SnippetFields
          draft={draft}
          errors={errors}
          disabled={busy}
          textReadOnly

          onChange={(next) => {
            setDraft(next);
            if (checked) setErrors(snippetErrors(next, existingLabels));
          }}
        />
        <p className={styles.hintText}>
          Shown in Ctrl+Space marked Mine. Edit or delete it in Settings → Snippets.
        </p>
        {failure && (
          <p className={styles.error} role="alert">
            {failure}
          </p>
        )}
      </form>
    </Dialog>,
    document.body,
  );
}
