import { useState, type FormEvent } from 'react';
import type { Lang } from '@clarity/core';
import {
  glossaryKey,
  glossaryValueSchema,
  type GlossaryEntry,
  type GlossaryOp,
} from '../../../../../packages/core/src/glossary/schema';
import { GlossaryConflictError } from '../../services/glossary';
import { errorMessage } from '../../services/http';
import { saveGlossary, useGlossaryStore } from '../../stores/glossary';
import styles from './TermForm.module.scss';

export function TermForm({
  lang,
  entry,
  english = '',
  onClose,
}: {
  lang: Lang;
  entry?: GlossaryEntry;
  english?: string;
  onClose(): void;
}) {
  const [en, setEn] = useState(entry?.en ?? english);
  const [term, setTerm] = useState(entry?.term ?? '');
  const [also, setAlso] = useState(entry?.also?.join('\n') ?? '');
  const [forms, setForms] = useState(entry?.forms?.join('\n') ?? '');
  const [note, setNote] = useState(entry?.note ?? '');
  const [matchCase, setMatchCase] = useState(entry?.matchCase ?? false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [conflict, setConflict] = useState<GlossaryConflictError>();
  const [retryOps, setRetryOps] = useState<GlossaryOp[]>();
  const pending = useGlossaryStore((state) => state.byLang[lang]?.pending);
  const run = async (ops: GlossaryOp[]) => {
    setBusy(true);
    setError('');
    setConflict(undefined);
    setRetryOps(ops);
    try {
      await saveGlossary(lang, ops);
      onClose();
    } catch (error) {
      setError(errorMessage(error));
      if (error instanceof GlossaryConflictError) setConflict(error);
    } finally {
      setBusy(false);
    }
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (error && !conflict && retryOps) {
      void run(retryOps);
      return;
    }
    const lines = (text: string) =>
      text
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);
    const parsed = glossaryValueSchema.safeParse({
      en,
      term,
      also: lines(also),
      forms: lines(forms),
      note,
      ...(matchCase ? { matchCase: true } : {}),
    });
    if (!parsed.success) {
      setError(parsed.error.issues.map((issue) => issue.message).join('; '));
      return;
    }
    const key = glossaryKey(parsed.data.en);
    const oldKey = entry ? glossaryKey(entry.en) : key;
    const ops: GlossaryOp[] = [
      { key, base: oldKey === key ? (entry ?? null) : null, next: parsed.data },
    ];
    if (entry && oldKey !== key) ops.unshift({ key: oldKey, base: entry, next: null });
    void run(ops);
  };
  return (
    <form
      className={styles.form}
      onSubmit={submit}
      onChangeCapture={() => {
        setError('');
        setConflict(undefined);
      }}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === 'Escape' && !busy) {
          event.preventDefault();
          onClose();
        }
        if (event.key === 'Enter' && event.target instanceof HTMLInputElement) {
          event.preventDefault();
          event.currentTarget.requestSubmit();
        }
      }}
    >
      <label>
        English
        <input value={en} maxLength={60} required onChange={(e) => setEn(e.target.value)} />
      </label>
      <label>
        Agreed term
        <input
          autoFocus
          data-autofocus
          value={term}
          maxLength={80}
          required
          onChange={(e) => setTerm(e.target.value)}
        />
      </label>
      <label>
        Also matches
        <textarea
          rows={2}
          value={also}
          onChange={(e) => setAlso(e.target.value)}
          placeholder="One English spelling per line"
        />
      </label>
      <small>Regular endings match automatically: -s, -es, -ed, -d, and -ing.</small>
      <label>
        Accepted forms
        <textarea
          rows={2}
          value={forms}
          onChange={(e) => setForms(e.target.value)}
          placeholder="One translated form per line"
        />
      </label>
      <label>
        Note
        <textarea rows={2} maxLength={240} value={note} onChange={(e) => setNote(e.target.value)} />
      </label>
      <label className={styles.check}>
        <input
          type="checkbox"
          checked={matchCase}
          onChange={(e) => setMatchCase(e.target.checked)}
        />
        Match English case
      </label>
      {error && <p role="alert">{error}</p>}
      {conflict && (
        <div className={styles.conflict}>
          {conflict.conflicts.map(({ key, head }) => (
            <p key={key}>
              {head ? `Changed by ${head.updatedBy}: ${head.term}` : 'This term was removed.'}
            </p>
          ))}
          <button
            type="button"
            onClick={() => {
              useGlossaryStore.setState((state) => {
                const current = state.byLang[lang];
                if (!current?.remote) return state;
                const terms = { ...current.remote.glossary.terms };
                for (const { key, head } of conflict.conflicts) {
                  if (head) terms[key] = head;
                  else delete terms[key];
                }
                return {
                  byLang: {
                    ...state.byLang,
                    [lang]: {
                      ...current,
                      remote: {
                        ...current.remote,
                        glossary: { ...current.remote.glossary, terms },
                      },
                    },
                  },
                };
              });
              onClose();
            }}
          >
            Use theirs
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              const heads = new Map(conflict.conflicts.map(({ key, head }) => [key, head]));
              void run(
                retryOps!.map((op) =>
                  heads.has(op.key) ? { ...op, base: heads.get(op.key)! } : op,
                ),
              );
            }}
          >
            Keep mine
          </button>
        </div>
      )}
      <div className={styles.actions}>
        {entry && (
          <button
            type="button"
            disabled={busy || pending}
            onClick={() => void run([{ key: glossaryKey(entry.en), base: entry, next: null }])}
          >
            Remove
          </button>
        )}
        <button type="button" disabled={busy} onClick={onClose}>
          Cancel
        </button>
        <button className={styles.primary} type="submit" disabled={busy || pending}>
          {busy ? 'Saving…' : error && !conflict ? 'Retry' : 'Save'}
        </button>
      </div>
    </form>
  );
}
