import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { Lang } from '@clarity/core';
import { languageLabel } from '../../languageLabels';
import { errorMessage } from '../../services/http';
import {
  addTranslator,
  getTranslators,
  removeTranslator,
  type Translator,
} from '../../services/managers';
import { Popover } from '../../ui/Popover';
import { scaledPx } from '../../ui/scale';
import { LoadingSkeleton, useSkeletonVisible } from '../../ui/Skeleton';
import styles from './TranslatorsPanel.module.scss';

/**
 * Translation managers (PRODUCT "Translation managers"): the translators of one managed language,
 * beside the queue's filters. Managers add a translator by GitHub login and remove one; the Worker
 * refuses everything else (other roles, other managers, themselves).
 */
export function TranslatorsButton({ lang, selfId }: { lang: Lang; selfId: number | string }) {
  return (
    <Popover
      label={`${languageLabel(lang)} translators`}
      trigger="Translators"
      // Scales with the interface, like its content.
      width={scaledPx(320)}
    >
      <TranslatorsPanel lang={lang} selfId={Number(selfId)} />
    </Popover>
  );
}

function TranslatorsPanel({ lang, selfId }: { lang: Lang; selfId: number }) {
  const [list, setList] = useState<Translator[]>();
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [login, setLogin] = useState('');
  const [attempt, setAttempt] = useState(0);
  const field = useRef<HTMLInputElement>(null);
  // After an add or remove, focus returns to the login field (a removed row's button is gone).
  const refocus = useRef(false);
  useEffect(() => {
    const controller = new AbortController();
    setError(undefined);
    getTranslators(lang, controller.signal).then(setList, (cause: unknown) => {
      if (!controller.signal.aborted) setError(errorMessage(cause));
    });
    return () => controller.abort();
  }, [lang, attempt]);
  useEffect(() => {
    if (busy || !refocus.current) return;
    refocus.current = false;
    field.current?.focus();
  }, [busy]);
  const skeleton = useSkeletonVisible(!list && !error, `translators:${lang}`, !!list);

  async function run(action: () => Promise<Translator[]>, done: string) {
    refocus.current = true;
    setBusy(true);
    setError(undefined);
    setNotice(undefined);
    try {
      setList(await action());
      setNotice(done);
      return true;
    } catch (cause) {
      setError(errorMessage(cause));
      return false;
    } finally {
      setBusy(false);
    }
  }
  async function add(event: FormEvent) {
    event.preventDefault();
    const name = login.trim();
    if (!name || busy) return;
    if (await run(() => addTranslator(lang, name), `Added ${name}.`)) setLogin('');
  }

  return (
    <div className={styles.panel} aria-busy={busy || !list}>
      {!list && !error && (
        <LoadingSkeleton label="Loading translators..." shape="rows" visible={skeleton} />
      )}
      {list && (
        <ul className={styles.list} aria-label={`${languageLabel(lang)} translators`}>
          {list.map((translator) => (
            <li key={translator.id}>
              <span className={styles.login} title={translator.login}>
                {translator.login}
              </span>
              {translator.manager || translator.id === selfId ? (
                <span className={styles.role}>Manager</span>
              ) : (
                <button
                  type="button"
                  disabled={busy}
                  aria-label={`Remove ${translator.login} as ${languageLabel(lang)} translator`}
                  onClick={() =>
                    void run(
                      () => removeTranslator(lang, translator.id),
                      `Removed ${translator.login}.`,
                    )
                  }
                >
                  Remove
                </button>
              )}
            </li>
          ))}
          {!list.length && <li className={styles.empty}>No translators yet.</li>}
        </ul>
      )}
      <form className={styles.add} onSubmit={(event) => void add(event)}>
        <input
          ref={field}
          required
          autoComplete="off"
          spellCheck={false}
          aria-label="GitHub login to add"
          placeholder="GitHub login"
          value={login}
          // Read-only, not disabled, while a change runs: a disabled field drops focus.
          readOnly={busy}
          disabled={!list}
          onChange={(event) => setLogin(event.target.value)}
        />
        <button type="submit" disabled={busy || !list || !login.trim()}>
          Add
        </button>
      </form>
      {/* Outcomes by the field the person typed in. */}
      {error && (
        <p role="alert" className={styles.error}>
          {error}
          {!list && (
            <button type="button" onClick={() => setAttempt((value) => value + 1)}>
              Retry
            </button>
          )}
        </p>
      )}
      {notice && (
        <p role="status" className={styles.notice}>
          {notice}
        </p>
      )}
    </div>
  );
}
