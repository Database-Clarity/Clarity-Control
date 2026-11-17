import { useEffect, useRef, useState } from 'react';
import type { Lang } from '@clarity/core';
import { languageLabel } from '../../languageLabels';
import { errorMessage } from '../../services/http';
import { applyRollback, getRollbackPlan, type RollbackPlan } from '../../services/managers';
import { acceptSaved } from '../../services/save/drafts';
import { useNames } from '../review/batches/names';
import styles from './History.module.scss';

/** Whether a commit is an upload (a /save by a person) that changed `lang` (its trailer). */
export function uploadChanged(message: string, lang: Lang): boolean {
  const line = message.split(/\r?\n/).find((value) => value.startsWith('Clarity-Changed: '));
  return !!line
    ?.slice('Clarity-Changed: '.length)
    .split(';')
    .some((part) => (part.split('=')[1] ?? '').split(',').includes(lang));
}

const listed = (names: string[]) =>
  names.length > 6
    ? `${names.slice(0, 6).join(', ')}, and ${names.length - 6} more`
    : names.join(', ');

/**
 * Upload rollback (PRODUCT "Translation managers"): revert one language of a whole upload as a
 * new save. Checking reads only; nothing changes until the confirm names what reverts and what
 * a later save already changed (those are restored per perk instead).
 */
export function UploadRollback({ commit, lang }: { commit: string; lang: Lang }) {
  const names = useNames();
  const [plan, setPlan] = useState<RollbackPlan>();
  const [state, setState] = useState<'idle' | 'checking' | 'confirm' | 'applying'>('idle');
  const [error, setError] = useState<string>();
  const [done, setDone] = useState<string>();
  const trigger = useRef<HTMLButtonElement>(null);
  const confirm = useRef<HTMLButtonElement>(null);
  const language = languageLabel(lang);
  useEffect(() => {
    if (state === 'confirm') confirm.current?.focus();
  }, [state]);

  async function check() {
    setError(undefined);
    setDone(undefined);
    setState('checking');
    try {
      setPlan(await getRollbackPlan(commit, lang));
      setState('confirm');
    } catch (cause) {
      setError(errorMessage(cause));
      setState('idle');
    }
  }
  async function apply() {
    setState('applying');
    try {
      const result = await applyRollback(commit, lang);
      acceptSaved({}, result.tooltips, result.commit, [], result.savedAt);
      setDone(
        `Rolled back ${language} in ${result.reverted.length} ${result.reverted.length === 1 ? 'tooltip' : 'tooltips'} as a new save.`,
      );
      setPlan(undefined);
      setState('idle');
    } catch (cause) {
      setError(errorMessage(cause));
      setState('confirm');
    }
  }
  function cancel() {
    setPlan(undefined);
    setState('idle');
    trigger.current?.focus();
  }

  const reverted = plan?.reverted.map(names) ?? [];
  const skipped = plan?.skipped.map(({ hash }) => names(hash)) ?? [];
  return (
    <div className={styles.revisionActions}>
      {error && <p role="alert">{error}</p>}
      {done && <p role="status">{done}</p>}
      {state === 'idle' || state === 'checking' ? (
        <button
          ref={trigger}
          type="button"
          disabled={state === 'checking'}
          title={`Revert ${language} in every tooltip this upload changed, as a new save`}
          onClick={() => void check()}
        >
          {state === 'checking' ? 'Checking upload...' : `Roll back this upload (${language})`}
        </button>
      ) : (
        <>
          {reverted.length ? (
            <p>
              Roll back {language} in this upload as a new save? Reverts {reverted.length}:{' '}
              {listed(reverted)}.
            </p>
          ) : (
            <p>Nothing to roll back: a later save changed every {language} text in this upload.</p>
          )}
          {skipped.length > 0 && (
            <p>
              Skips {skipped.length} changed by a later save (restore those per tooltip):{' '}
              {listed(skipped)}.
            </p>
          )}
          <span className={styles.confirmRow}>
            {reverted.length > 0 && (
              <button
                ref={confirm}
                type="button"
                disabled={state === 'applying'}
                onClick={() => void apply()}
              >
                {state === 'applying' ? 'Rolling back...' : `Roll back ${reverted.length}`}
              </button>
            )}
            <button
              ref={reverted.length ? undefined : confirm}
              type="button"
              disabled={state === 'applying'}
              onClick={cancel}
            >
              {reverted.length ? 'Cancel' : 'Close'}
            </button>
          </span>
        </>
      )}
    </div>
  );
}
