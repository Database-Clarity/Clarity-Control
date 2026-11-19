import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Lang } from '@clarity/core';
import {
  localizableBuiltIns,
  snippetEnglishHash,
  validateSnippetTranslation,
  type SnippetTranslation,
} from '../../../../../packages/core/src/localizedSnippets';
import { languageLabel } from '../../languageLabels';
import {
  getLocalizedSnippets,
  getSnippetTranslations,
  getTeamSnippets,
  saveSnippetTranslation,
  SnippetConflictError,
} from '../../services/snippets';
import { Dialog } from '../../ui/Dialog';
import { invalidateSnippetCatalogue } from '../editor/suggest/custom';
import { SnippetFields, saveError, type SnippetDraft, type SnippetErrors } from './SnippetFields';
import { conflictMessage } from './SnippetManager';
import styles from './Snippets.module.scss';
import { plainError } from '../../services/httpError';
import { InlineAlert } from '../../ui/InlineAlert';

interface EnglishSnippet {
  id: string;
  label: string;
  keywords: string;
  template: string;
  team: boolean;
}

/** What a translation must keep: the English skeleton (tags, fields, references, names). */
function translationErrors(english: EnglishSnippet, draft: SnippetDraft): SnippetErrors {
  const errors: SnippetErrors = {};
  const label = draft.label.trim();
  if (!label) errors.label = 'Label is required';
  else if (label.length > 40) errors.label = 'Label must be at most 40 characters';
  if (draft.keywords.length > 2000) errors.keywords = 'Keywords must be at most 2,000 characters';
  if (!draft.template) errors.template = 'Text is required';
  else
    try {
      validateSnippetTranslation(english.template, draft.template);
    } catch (error) {
      errors.template = error instanceof Error ? error.message : String(error);
    }
  return errors;
}

/**
 * Translations → Snippets: the words of built-in and team snippets in one language (translation
 * managers in their languages, maintainers in any). A translation keeps the English skeleton;
 * one made for an older English text is listed as outdated, and the menus show English until it is
 * saved again.
 */
export function SnippetTranslationsButton({ lang }: { lang: Lang }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Snippets
      </button>
      {open &&
        // Out of the page's bar, so its control styles never reach the dialog.
        createPortal(
          <SnippetTranslations lang={lang} onClose={() => setOpen(false)} />,
          document.body,
        )}
    </>
  );
}

export function SnippetTranslations({ lang, onClose }: { lang: Lang; onClose(): void }) {
  const [english, setEnglish] = useState<EnglishSnippet[] | null>(null);
  const [translations, setTranslations] = useState<Record<string, SnippetTranslation>>({});
  const [outdated, setOutdated] = useState<ReadonlySet<string>>(new Set());
  const [loadError, setLoadError] = useState<string | null>(null);
  const [editing, setEditing] = useState<EnglishSnippet | null>(null);
  const [draft, setDraft] = useState<SnippetDraft>({ label: '', keywords: '', template: '' });
  const [errors, setErrors] = useState<SnippetErrors>({});
  const [checked, setChecked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  const [notice, setNotice] = useState<{
    text: string;
    kind: 'done' | 'conflict' | 'error';
  } | null>(null);

  // Where keyboard focus goes after an action, so it never drops out of the dialog.
  const root = useRef<HTMLDivElement>(null);
  const loadVersion = useRef(0);
  const [focus, setFocus] = useState<string | null>(null);
  useLayoutEffect(() => {
    if (!focus) return;
    const target = root.current?.querySelector<HTMLElement>(focus);
    if (!target || (target as HTMLButtonElement).disabled) return;
    target.focus();
    setFocus(null);
  }, [focus, busy, english, loadError]);

  const reload = useCallback(() => {
    const version = ++loadVersion.current;
    setLoadError(null);
    setNotice(null);
    setRemoving(null);
    setFocus('[data-edit]');
    setEnglish(null);
    setEditing(null);
    Promise.all([getTeamSnippets(), getSnippetTranslations(lang), getLocalizedSnippets(lang)])
      .then(([team, stored, effective]) => {
        if (version !== loadVersion.current) return;
        setEnglish([
          ...localizableBuiltIns.map((snippet) => ({
            id: snippet.id,
            label: snippet.label,
            keywords: snippet.keywords,
            template: snippet.template,
            team: false,
          })),
          ...team.team.snippets.map((snippet) => ({
            id: snippet.id,
            label: snippet.label,
            keywords: snippet.keywords ?? '',
            template: snippet.template,
            team: true,
          })),
        ]);
        setTranslations(stored.translations);
        setOutdated(new Set(effective.outdated));
      })
      .catch((error: unknown) => {
        if (version === loadVersion.current) {
          setLoadError(`Snippet translations could not load: ${saveError(error)}`);
          setFocus('[data-retry]');
        }
      });
  }, [lang]);
  useEffect(() => {
    reload();
    return () => {
      // This is a request generation, not a DOM ref: invalidate the latest reload on cleanup.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      loadVersion.current++;
    };
  }, [reload]);

  function start(snippet: EnglishSnippet) {
    const current = translations[snippet.id];
    setEditing(snippet);
    setDraft(
      current
        ? { label: current.label, keywords: current.keywords, template: current.template }
        : { label: snippet.label, keywords: snippet.keywords, template: snippet.template },
    );
    setErrors({});
    setChecked(false);
    setNotice(null);
  }

  async function write(
    snippet: EnglishSnippet,
    next: SnippetTranslation | null,
    done: string,
    /** Focus after a refused write: Save, or the remove confirm. */
    retry: string,
  ) {
    setBusy(true);
    setNotice(null);
    try {
      const saved = await saveSnippetTranslation(lang, {
        id: snippet.id,
        base: translations[snippet.id] ?? null,
        next,
      });
      setTranslations(saved.translations);
      setOutdated((ids) => new Set([...ids].filter((id) => id !== snippet.id)));
      setEditing(null);
      setRemoving(null);
      setNotice({ text: done, kind: 'done' });
      setFocus(`[data-edit="${snippet.id}"]`);
      invalidateSnippetCatalogue();
    } catch (error) {
      setFocus(retry);
      setNotice(
        error instanceof SnippetConflictError
          ? { text: conflictMessage, kind: 'conflict' }
          : { text: saveError(error), kind: 'error' },
      );
    } finally {
      setBusy(false);
    }
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!editing || busy) return;
    const found = translationErrors(editing, draft);
    setErrors(found);
    setChecked(true);
    if (Object.keys(found).length) return;
    await write(
      editing,
      {
        label: draft.label.trim(),
        keywords: draft.keywords.trim(),
        template: draft.template,
        enHash: await snippetEnglishHash(editing.template),
      },
      `Saved the ${languageLabel(lang)} words for “${editing.label}”.`,
      '[data-save]',
    );
  }

  const stateOf = (id: string) =>
    outdated.has(id) ? 'outdated' : translations[id] ? 'translated' : 'missing';
  const stale = (english ?? []).filter((snippet) => outdated.has(snippet.id));
  const ordered = [...(english ?? [])].sort(
    (a, b) => Number(outdated.has(b.id)) - Number(outdated.has(a.id)),
  );

  return (
    <Dialog title={`Snippet translations · ${languageLabel(lang)}`} busy={busy} onClose={onClose}>
      <div ref={root} className={styles.manager}>
        <p className={styles.hintText}>
          While translating into {languageLabel(lang)}, Ctrl+Space and the markup menus use these
          words; snippets without a current translation show in English, marked EN. Change only the
          words: tags, fields, references, names, and line breaks stay as in English.
        </p>
        {notice &&
          (notice.kind === 'done' ? (
            <p className={styles.notice} role="status">
              {notice.text}
            </p>
          ) : (
            <InlineAlert
              retryLabel="Reload"
              onRetry={notice.kind === 'conflict' ? reload : undefined}
            >
              {plainError(notice.text)}
            </InlineAlert>
          ))}
        {loadError ? (
          <InlineAlert onRetry={reload}>{plainError(loadError)}</InlineAlert>
        ) : !english ? (
          <p className={styles.muted} role="status">
            Loading snippet translations…
          </p>
        ) : (
          <>
            {stale.length > 0 && (
              <div className={styles.outdated} role="group" aria-label="Outdated">
                <p>
                  Outdated ({stale.length}): the English changed after these were translated. The
                  menus show English until each is saved again.
                </p>
              </div>
            )}
            <ul className={styles.list} aria-label={`${languageLabel(lang)} snippet words`}>
              {ordered.map((snippet) => {
                const state = stateOf(snippet.id);
                const current = translations[snippet.id];
                return (
                  <li key={snippet.id} className={styles.row}>
                    {editing?.id === snippet.id ? (
                      <form
                        className={styles.form}
                        onSubmit={(event) => void submit(event)}
                        noValidate
                      >
                        <SnippetFields
                          draft={draft}
                          errors={errors}
                          disabled={busy}
                          autoFocus
                          english={{
                            label: snippet.label,
                            keywords: snippet.keywords,
                            template: snippet.template,
                          }}
                          onChange={(next) => {
                            setDraft(next);
                            if (checked) setErrors(translationErrors(snippet, next));
                          }}
                        />
                        <div className={styles.actions}>
                          <button type="submit" data-primary data-save disabled={busy}>
                            {busy ? 'Saving…' : 'Save translation'}
                          </button>
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => {
                              setEditing(null);
                              setFocus(`[data-edit="${snippet.id}"]`);
                            }}
                          >
                            Cancel
                          </button>
                        </div>
                      </form>
                    ) : (
                      <>
                        <div className={styles.summary}>
                          <span className={styles.label}>
                            {current && state !== 'outdated' ? current.label : snippet.label}
                          </span>
                          <code className={styles.text}>
                            {current && state !== 'outdated' ? current.template : snippet.template}
                          </code>
                        </div>
                        <span className={styles.state} data-state={state}>
                          {snippet.team ? 'Team · ' : ''}
                          {state === 'outdated'
                            ? 'Outdated'
                            : state === 'translated'
                              ? 'Current'
                              : 'Missing'}
                        </span>
                        <span className={styles.rowActions}>
                          <button
                            type="button"
                            data-edit={snippet.id}
                            aria-label={`Translate ${snippet.label}`}
                            disabled={busy}
                            onClick={() => start(snippet)}
                          >
                            {current ? 'Edit' : 'Translate'}
                          </button>
                          {current &&
                            (removing === snippet.id ? (
                              <>
                                <button
                                  type="button"
                                  data-confirm
                                  disabled={busy}
                                  onClick={() =>
                                    void write(
                                      snippet,
                                      null,
                                      `Removed the ${languageLabel(lang)} words for “${snippet.label}”.`,
                                      '[data-confirm]',
                                    )
                                  }
                                >
                                  Remove translation
                                </button>
                                <button
                                  type="button"
                                  disabled={busy}
                                  onClick={() => {
                                    setRemoving(null);
                                    setFocus(`[data-remove="${snippet.id}"]`);
                                  }}
                                >
                                  Keep
                                </button>
                              </>
                            ) : (
                              <button
                                type="button"
                                data-remove={snippet.id}
                                aria-label={`Remove the ${languageLabel(lang)} words for ${snippet.label}`}
                                disabled={busy}
                                onClick={() => {
                                  setRemoving(snippet.id);
                                  setFocus('[data-confirm]');
                                }}
                              >
                                Remove
                              </button>
                            ))}
                        </span>
                      </>
                    )}
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </div>
    </Dialog>
  );
}
