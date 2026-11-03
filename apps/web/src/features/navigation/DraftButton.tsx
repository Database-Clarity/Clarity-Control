import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { resolveAlias, type Lang, type Tooltip } from '@clarity/core';
import { languageLabel } from '../../languageLabels';
import { SavePanel } from '../../services/save/SavePanel';
import { useSaveState } from '../../services/save/state';
import { useDataStore, type EditorData } from '../../stores/data';
import { useDraftStore } from '../../stores/drafts';
import { Dialog } from '../../ui/Dialog';
import { When } from '../../ui/When';
import { itemFor } from './catalog';
import { ShellOverlay } from './ShellOverlay';
import { tooltipPath } from './stepping';
import styles from './DraftButton.module.scss';

/** Drafts whose hash now shares another tooltip: kept, never deleted, until the user decides. */
export function staleDraftHashes(drafts: Record<string, unknown>, data: EditorData | null) {
  return data
    ? Object.keys(drafts).filter(
        (hash) => resolveAlias(Number(hash), data.aliases) !== Number(hash),
      )
    : [];
}

/** Recovered-draft conflicts: the preserved text, a way to the shared tooltip, and a discard. */
export function RecoveredDrafts({
  data,
  onOpen,
}: {
  data: EditorData;
  onOpen(hash: number): void;
}) {
  const drafts = useDraftStore((state) => state.drafts);
  const discard = useDraftStore((state) => state.discard);
  return (
    <>
      {staleDraftHashes(drafts, data).map((hash) => {
        const draft = drafts[Number(hash)];
        const canonical = resolveAlias(Number(hash), data.aliases);
        return (
          <details key={hash} className={styles.recovered}>
            <summary role="alert">
              Recovered draft conflict: {hash} now shares tooltip {canonical}
            </summary>
            <p>
              This draft is preserved, but cannot be saved separately. Copy any text you want to
              keep into the shared tooltip before discarding it.
            </p>
            <button type="button" onClick={() => onOpen(canonical)}>
              Open shared tooltip {canonical}
            </button>
            {Object.entries(draft.next.text).map(([language, value]) => (
              <div key={language}>
                <strong>{languageLabel(language)}</strong>
                <pre className={styles.recoveredText}>{value.text}</pre>
              </div>
            ))}
            <button type="button" onClick={() => discard(Number(hash))}>
              Discard recovered draft {hash}
            </button>
          </details>
        );
      })}
    </>
  );
}

interface DraftPair {
  base: Tooltip;
  next: Tooltip;
}

function changedLanguages(draft: DraftPair) {
  return Object.keys(draft.next.text).filter(
    (language) =>
      draft.next.text[language as Lang]?.text !== draft.base.text[language as Lang]?.text,
  );
}

function latest(draft: DraftPair, languages: string[]) {
  return languages
    .map((language) => draft.next.text[language as Lang]?.updatedAt ?? '')
    .sort()
    .at(-1);
}

/**
 * The drafts popover (phone: sheet): the count and review action, the last save result, one row
 * per draft (tooltip, languages, time) with guarded open and a confirmed discard. It is only the
 * view: the save session itself lives in the always-mounted SaveController.
 */
export function DraftsContent({ onClose }: { onClose(): void }) {
  const data = useDataStore((state) => state.data);
  const drafts = useDraftStore((state) => state.drafts);
  const discard = useDraftStore((state) => state.discard);
  const navigate = useNavigate();
  const [confirm, setConfirm] = useState<number | null>(null);
  const rows = Object.entries(drafts)
    .map(([hash, draft]) => {
      const languages = changedLanguages(draft);
      return { hash: Number(hash), draft, languages, time: latest(draft, languages) };
    })
    .sort((a, b) => (b.time ?? '').localeCompare(a.time ?? '') || a.hash - b.hash);
  const stale = new Set(staleDraftHashes(drafts, data));
  const name = (hash: number) =>
    stale.has(String(hash))
      ? `Recovered draft ${hash}`
      : (data && itemFor(resolveAlias(hash, data.aliases), data)?.name) || `Tooltip ${hash}`;
  const open = (hash: number) => {
    // Close first, then go: the leave guard may answer with its own prompt, which then owns focus.
    onClose();
    navigate(tooltipPath(data ? resolveAlias(hash, data.aliases) : hash, ''));
  };
  return (
    <div className={styles.drafts}>
      <SavePanel className={styles.summary} onReview={onClose} />
      {data && <RecoveredDrafts data={data} onOpen={open} />}
      {rows.length > 0 && (
        <ul className={styles.list} aria-label="Local drafts">
          {rows.map(({ hash, languages, time }) => (
            <li key={hash}>
              <div className={styles.what}>
                <button
                  type="button"
                  className={styles.open}
                  disabled={stale.has(String(hash))}
                  onClick={() => open(hash)}
                >
                  {name(hash)}
                </button>
                <small>
                  {languages.length ? languages.map(languageLabel).join(', ') : 'Other fields'}
                  {time && (
                    <>
                      {' · '}
                      <When value={time} />
                    </>
                  )}
                </small>
              </div>
              <button
                type="button"
                className={styles.discard}
                aria-label={`Discard draft ${name(hash)}`}
                onClick={() => setConfirm(hash)}
              >
                Discard
              </button>
            </li>
          ))}
        </ul>
      )}
      {confirm !== null && (
        <Dialog
          title="Discard draft"
          compact
          onClose={() => setConfirm(null)}
          footer={
            <>
              <button
                type="button"
                onClick={() => {
                  const hash = confirm;
                  setConfirm(null);
                  discard(hash);
                  // The row is gone with its button. Keep the list when drafts remain, else close
                  // so focus lands on the drafts button in the header.
                  setTimeout(() => {
                    if (Object.keys(useDraftStore.getState().drafts).length === 0) onClose();
                    else document.querySelector<HTMLElement>('[data-drafts-review]')?.focus();
                  }, 0);
                }}
              >
                Discard draft
              </button>
              <button type="button" onClick={() => setConfirm(null)}>
                Keep draft
              </button>
            </>
          }
        >
          <p>
            Discard the local draft of {name(confirm)}? Its unsaved changes are lost; the saved text
            is not affected.
          </p>
        </Dialog>
      )}
    </div>
  );
}

/** Header button: the draft count, a dot while anything needs attention. */
export function DraftButton({ iconOnly = false }: { iconOnly?: boolean }) {
  const drafts = useDraftStore((state) => state.drafts);
  const draftError = useDraftStore((state) => state.error);
  const data = useDataStore((state) => state.data);
  const reviewing = useSaveState((state) => state.review !== null);
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const { pathname, search } = useLocation();
  // Back/Forward or any navigation moves the page behind a modal popover: close it.
  useEffect(() => setOpen(false), [pathname, search]);
  const count = Object.keys(drafts).length;
  const attention = Boolean(draftError) || staleDraftHashes(drafts, data).length > 0;
  // A review in progress belongs to the native dialog, not to this popover.
  useEffect(() => {
    if (reviewing) setOpen(false);
  }, [reviewing]);
  const label = `Drafts: ${count} local draft${count === 1 ? '' : 's'}${attention ? ', needs attention' : ''}`;
  return (
    <>
      <button
        ref={button}
        type="button"
        className={styles.button}
        data-drafts-button
        data-attention={attention || undefined}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={label}
        title={label}
        onClick={() => setOpen((value) => !value)}
      >
        {iconOnly ? <span className={styles.icon} aria-hidden="true" /> : 'Drafts'}
        {count > 0 && (
          <span className={styles.count} aria-hidden="true">
            {count}
          </span>
        )}
        {attention && <span className={styles.alertDot} aria-hidden="true" />}
      </button>
      <ShellOverlay
        open={open}
        onClose={() => setOpen(false)}
        label="Drafts"
        anchorRef={button}
        width={380}
        align="end"
      >
        <DraftsContent onClose={() => setOpen(false)} />
      </ShellOverlay>
    </>
  );
}
