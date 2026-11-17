import { useId } from 'react';
import { snippetContentSchema } from '../../../../../packages/core/src/customSnippets';
import styles from './Snippets.module.scss';

export interface SnippetDraft {
  label: string;
  keywords: string;
  template: string;
}

export type SnippetErrors = Partial<Record<keyof SnippetDraft | 'form', string>>;

/** The shared validator's verdict on a draft, one message per field, by the field's name. */
export function snippetErrors(draft: SnippetDraft, takenLabels: readonly string[] = []) {
  const errors: SnippetErrors = {};
  const parsed = snippetContentSchema.safeParse({
    label: draft.label,
    template: draft.template,
    ...(draft.keywords.trim() ? { keywords: draft.keywords } : {}),
  });
  if (!parsed.success)
    for (const issue of parsed.error.issues) {
      const field = issue.path[0] as keyof SnippetDraft;
      errors[field] ??= issue.message;
    }
  const label = draft.label.trim().toLowerCase();
  if (!errors.label && takenLabels.some((taken) => taken.toLowerCase() === label))
    errors.label = 'Another snippet here already has this label';
  return errors;
}

/** A refused save, worded for the form: the Worker's own message, without the HTTP prefix. */
export function saveError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const body = /^API HTTP \d+: ([\s\S]*)$/.exec(message)?.[1] ?? message;
  try {
    const parsed: unknown = JSON.parse(body);
    if (parsed && typeof parsed === 'object' && 'error' in parsed)
      return String((parsed as { error: unknown }).error);
  } catch {
    // Plain text.
  }
  return body || 'The snippet could not be saved.';
}

/**
 * Label, keywords, and text of one snippet, each with its validation message under it. The text
 * is markup with optional fields written {{1:default}}.
 */
export function SnippetFields({
  draft,
  errors,
  onChange,
  disabled = false,
  textReadOnly = false,
  english,
}: {
  draft: SnippetDraft;
  errors: SnippetErrors;
  onChange(draft: SnippetDraft): void;
  disabled?: boolean;
  /** Save as snippet: the selected text is shown, not edited here. */
  textReadOnly?: boolean;
  /** Translating: the English beside each field. */
  english?: SnippetDraft;
}) {
  const id = useId();
  const field = (
    name: keyof SnippetDraft,
    label: string,
    control: React.ReactNode,
    hint?: string,
  ) => (
    <div className={styles.field}>
      <label htmlFor={`${id}-${name}`}>{label}</label>
      {english && <code className={styles.english}>{english[name] || '—'}</code>}
      {control}
      {errors[name] ? (
        <p id={`${id}-${name}-error`} className={styles.error} role="alert">
          {errors[name]}
        </p>
      ) : (
        hint && <p className={styles.hintText}>{hint}</p>
      )}
    </div>
  );
  const described = (name: keyof SnippetDraft) =>
    errors[name]
      ? { 'aria-invalid': true, 'aria-describedby': `${id}-${name}-error` }
      : { 'aria-invalid': false };
  return (
    <div className={styles.fields}>
      {field(
        'label',
        'Label',
        <input
          id={`${id}-label`}
          value={draft.label}
          maxLength={40}
          disabled={disabled}
          autoComplete="off"
          {...described('label')}
          onChange={(event) => onChange({ ...draft, label: event.target.value })}
        />,
      )}
      {field(
        'keywords',
        'Keywords',
        <input
          id={`${id}-keywords`}
          value={draft.keywords}
          maxLength={2000}
          disabled={disabled}
          autoComplete="off"
          placeholder="Optional words the menu filter also matches"
          {...described('keywords')}
          onChange={(event) => onChange({ ...draft, keywords: event.target.value })}
        />,
      )}
      {field(
        'template',
        'Text',
        <textarea
          id={`${id}-template`}
          className={styles.template}
          value={draft.template}
          maxLength={2000}
          disabled={disabled}
          readOnly={textReadOnly}
          spellCheck={false}
          {...described('template')}
          onChange={(event) => onChange({ ...draft, template: event.target.value })}
        />,
        textReadOnly
          ? undefined
          : `${draft.template.length.toLocaleString()} of 2,000 characters. Fields: {{1:default}}, caret end: {{0}}.`,
      )}
    </div>
  );
}
