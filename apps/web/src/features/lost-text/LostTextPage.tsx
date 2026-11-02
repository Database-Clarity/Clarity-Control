import { useMemo, useState } from 'react';
import { Link, Navigate, useSearchParams } from 'react-router-dom';
import artifact from './lost-text.json';
import {
  artifactSchema,
  canRecover,
  fingerprint,
  recordKey,
  recoveryDraft,
  visibleRecords,
} from './model';
import { useAuthStore } from '../../stores/auth';
import { useDataStore } from '../../stores/data';
import { useDraftStore } from '../../stores/drafts';
import { useSaveState } from '../../services/save/state';
import { replaceDraft } from '../../services/save/drafts';
import { errorMessage } from '../../services/http';
import { TooltipPreview } from '../preview/TooltipPreview';
import { tooltipImports } from '../../services/tooltipImports';
import { When } from '../../ui/When';
import styles from './LostText.module.scss';

const parsed = artifactSchema.safeParse(artifact);
export function LostTextPage() {
  const data = useDataStore((s) => s.data);
  const user = useAuthStore((s) => s.user);
  const { drafts, hydrated } = useDraftStore();
  const locked = useSaveState((s) => s.locked);
  const [params, setParams] = useSearchParams();
  const [showDismissed, setShowDismissed] = useState(false);
  const [classFilter, setClassFilter] = useState('');
  const [query, setQuery] = useState('');
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const storageKey = `clarity-lost-text:v1:${user?.id ?? 'anonymous'}`;
  const [stored, setStored] = useState<{ key: string; decisions: Record<string, string> }>({
    key: '',
    decisions: {},
  });
  const progress = useMemo(() => {
    if (stored.key === storageKey) return { decisions: stored.decisions, error: '' };
    try {
      const raw: unknown = JSON.parse(localStorage.getItem(storageKey) ?? '{}');
      if (
        !raw ||
        typeof raw !== 'object' ||
        Array.isArray(raw) ||
        Object.values(raw).some((v) => typeof v !== 'string')
      )
        throw new Error('Invalid stored decisions');
      return { decisions: raw as Record<string, string>, error: '' };
    } catch {
      return {
        decisions: {},
        error: 'Local dismissals could not be loaded. You can still review and recover text.',
      };
    }
  }, [stored, storageKey]);
  if (user?.role === 'translator') return <Navigate to="/translations" replace />;
  if (!data) return <p role="status">Loading checker data…</p>;
  if (!parsed.success)
    return (
      <article>
        <h1>Lost-tooltip checker</h1>
        <p role="alert">Checker data is missing or invalid; regenerate lost-text.json.</p>
      </article>
    );
  const result = parsed.data;
  const rows = visibleRecords(
    result.records,
    data.bundle.tooltips,
    progress.decisions,
    classFilter !== '',
    classFilter === 'all' ? '' : classFilter,
    showDismissed,
  ).filter((r) => `${r.name} ${r.hash}`.toLowerCase().includes(query.trim().toLowerCase()));
  const selected = result.records.find((r) => recordKey(r) === params.get('item'));
  const base = selected && data.bundle.tooltips[selected.hash];
  const current = base && (drafts[base.hash]?.next ?? base);
  const editable = canRecover(user);
  const imports = selected
    ? tooltipImports(data.bundle.tooltips, drafts, selected.lang, data.aliases)
    : {};
  function dismiss() {
    if (!selected || !editable) return;
    try {
      const decisions = { ...progress.decisions, [recordKey(selected)]: fingerprint(selected) };
      localStorage.setItem(storageKey, JSON.stringify(decisions));
      setStored({ key: storageKey, decisions });
      setParams({});
      setNotice('Dismissed locally. Changed history will reopen this record.');
    } catch (cause) {
      setError(`Dismissal was not stored: ${errorMessage(cause)}`);
    }
  }
  function recover() {
    if (!selected || !base || !current || !user || !hydrated || locked) return;
    try {
      replaceDraft(base, recoveryDraft(current, selected, user));
      setNotice(
        'Recovered as a local draft. Review in the editor and save through the normal flow.',
      );
      setError('');
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }
  return (
    <article className={styles.page}>
      <h1>Lost-tooltip checker</h1>
      <p>
        Blank saved tooltips with earlier text. Classification is evidence, not a judgment about why
        text was cleared.
      </p>
      {result.sourceCommit !== data.bundle.sourceCommit && (
        <p role="status">
          Checker data is from {result.sourceCommit.slice(0, 12)}; regenerate. Historical records
          remain viewable.
        </p>
      )}
      {(error || progress.error) && <p role="alert">{error || progress.error}</p>}
      {notice && <p role="status">{notice}</p>}
      <div className={styles.workspace} data-detail={Boolean(selected)}>
        <section className={styles.list} aria-label="Possibly lost text">
          <label>
            Filter by name or hash
            <input value={query} onChange={(e) => setQuery(e.target.value)} />
          </label>
          <label>
            Authorship class
            <select value={classFilter} onChange={(e) => setClassFilter(e.target.value)}>
              <option value="">Possibly authored — human and unclear</option>
              <option value="all">All classes — including copies and placeholders</option>
              <option value="human">
                Human — authorship evidence, differs from available manifest
              </option>
              <option value="unclear">
                Unclear — authorship or manifest evidence is inconclusive
              </option>
              <option value="manifest-copy">
                Manifest copy — matches an available manifest description
              </option>
              <option value="placeholder">Placeholder — only comments or import directives</option>
            </select>
          </label>
          <label className={styles.check}>
            <input
              type="checkbox"
              checked={showDismissed}
              onChange={(e) => setShowDismissed(e.target.checked)}
            />
            Show dismissed
          </label>
          <p role="status">
            {rows.length} of {result.records.length} records shown
          </p>
          {!rows.length && (
            <p>
              No blank tooltips with earlier authored text found.
              {(query || classFilter) && ' Try another filter.'}
            </p>
          )}
          {rows.map((r) => (
            <button
              type="button"
              className={styles.row}
              key={recordKey(r)}
              aria-pressed={selected && recordKey(selected) === recordKey(r)}
              onClick={() => {
                setParams({ item: recordKey(r) });
                setNotice('');
                setError('');
              }}
            >
              <strong>{data.items[r.hash]?.name ?? r.name}</strong>
              <span>
                {r.lang} · {r.classification} · {r.hash}
              </span>
            </button>
          ))}
        </section>
        {selected && (
          <section className={styles.detail} aria-label="Historical text detail">
            <button type="button" onClick={() => setParams({})}>
              Back to list
            </button>
            <h2>
              {data.items[selected.hash]?.name ?? selected.name} · {selected.lang}
            </h2>
            <p>
              {selected.classification}: {selected.reason}
            </p>
            <p>
              Cleared <When value={selected.clearingDate} /> by {selected.clearingAuthor}.{' '}
              <a
                href={`https://github.com/Database-Clarity/Live-Clarity-Database/commit/${selected.clearingCommit}`}
                target="_blank"
                rel="noreferrer"
              >
                Clearing commit {selected.clearingCommit.slice(0, 12)}
              </a>
            </p>
            <p>
              Last nonempty:{' '}
              <a
                href={`https://github.com/Database-Clarity/Live-Clarity-Database/commit/${selected.lastNonemptyCommit}`}
                target="_blank"
                rel="noreferrer"
              >
                {selected.lastNonemptyCommit.slice(0, 12)}
              </a>
            </p>
            <h3>Historical text (last non-empty)</h3>
            <p>Current saved text: {base?.text[selected.lang]?.text || '(blank)'}</p>
            <TooltipPreview
              text={selected.text}
              lang={selected.lang}
              name={selected.name}
              globals={{ variables: imports[2] ?? '', titles: imports[3] ?? '', imports }}
            />
            <details>
              <summary>Historical source text</summary>
              <pre>{selected.text}</pre>
            </details>
            {current?.text[selected.lang]?.text.trim() && (
              <p>A local draft or saved text already exists. Review it in the editor first.</p>
            )}
            <div className={styles.actions}>
              {editable && (
                <>
                  <p className={styles.consequences}>
                    Recover creates an unsaved local draft; nothing is saved automatically. Dismiss
                    hides this record for you in this browser only; it reopens if history changes.
                  </p>
                  <button
                    type="button"
                    disabled={
                      !hydrated ||
                      locked ||
                      !base ||
                      Boolean(current?.text[selected.lang]?.text.trim())
                    }
                    onClick={recover}
                  >
                    Recover as draft
                  </button>
                  <button type="button" disabled={locked} onClick={dismiss}>
                    Dismiss
                  </button>
                </>
              )}
              <Link to={`/t/${selected.hash}?lang=${selected.lang}`}>Open in editor</Link>
            </div>
          </section>
        )}
      </div>
    </article>
  );
}
