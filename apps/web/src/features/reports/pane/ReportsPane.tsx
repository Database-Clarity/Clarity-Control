import { displayRevision, displayText, type Lang, type MarkupGlobals } from '@clarity/core';
import {
  createContext,
  memo,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type RefObject,
} from 'react';
import type { User } from '../../../services/api';
import { errorMessage } from '../../../services/http';
import { Dialog } from '../../../ui/Dialog';
import { Popover } from '../../../ui/Popover';
import { RightPane, RightPaneHeader } from '../../../ui/RightPane';
import { phoneQuery, useMedia } from '../../../ui/useMedia';
import { languageLabel } from '../../../languageLabels';
import { MarkupSnippet } from '../../preview/TooltipPreview';
import previewStyles from '../../preview/TooltipPreview.module.scss';
import {
  deleteReport,
  fetchScreenshot,
  postReportAction,
  ReportsHttpError,
  type PaneAction,
  type PaneReport,
  type RejectReason,
} from './api';
import { HighlightLayer } from './HighlightLayer';
import { openCount, refreshReportsIndex, useReportsIndex } from './indexStore';
import { resolveNote } from './previewText';
import { isActive, reportsKey, useTooltipReports } from './reportsCache';
import { useReportsTab } from './tabStore';
import { useReportHighlights, type HighlightTarget, type NoteTarget } from './useReportHighlights';
import styles from './ReportsPane.module.scss';

export const categoryLabels: Record<string, string> = {
  'wrong-value': 'Wrong value',
  outdated: 'Outdated',
  wording: 'Typo or wording',
  translation: 'Translation',
  missing: 'Missing information',
  other: 'Other',
};
const rejectReasons: { value: RejectReason; label: string }[] = [
  { value: 'not-an-issue', label: 'Not an issue' },
  { value: 'works-as-described', label: 'Works as described' },
  { value: 'out-of-scope', label: 'Out of scope' },
  { value: 'unclear', label: 'Unclear' },
];
const statusLabels: Record<PaneReport['status'], string> = {
  open: 'open',
  triaged: 'triaged',
  fixed: 'fixed',
  closed: 'closed',
  rejected: 'rejected',
  duplicate: 'duplicate',
  spam: 'spam',
  withdrawn: 'withdrawn',
};
const pastTense: Partial<Record<PaneAction['action'], string>> = {
  triage: 'triaged',
  claim: 'claimed',
  reopen: 'reopened',
  close: 'closed',
  reject: 'rejected',
  duplicate: 'marked duplicate',
  spam: 'marked spam',
};

export function age(seconds: number, now = Date.now() / 1000): string {
  const delta = Math.max(0, now - seconds);
  if (delta < 3600) return `${Math.max(1, Math.floor(delta / 60))} min`;
  if (delta < 86400) return `${Math.floor(delta / 3600)} h`;
  return `${Math.floor(delta / 86400)} d`;
}

export interface ReportsPaneProps {
  hash: number;
  lang: Lang;
  user: User;
  /** The text the base preview shows (drafts included) and its globals: the pane's own copy. */
  text: string;
  globals: MarkupGlobals;
  /** The enhanced versions the preview can show, as rendered: a note anchors to the one viewed. */
  variants?: readonly PaneVariant[];
  /** Where the page renders its preview (inline or in the shell column). Read, never changed. */
  previewHost: RefObject<HTMLElement | null>;
  /** A navigation burst is running: show the count only, start nothing. */
  suspended: boolean;
  /** The preview painted this tooltip: fetches and highlights may start. */
  ready: boolean;
}

/**
 * The Reports tab: this tooltip's reports in this language, their notes, evidence, and the trust
 * signal, one action bar for the selected report, and highlights on the rendered preview. Mounted
 * only while the tab is open; the label count comes from the index, so a tooltip with no open
 * reports costs no request.
 */
export function ReportsPane(props: ReportsPaneProps) {
  // Typing changes the text on every key; the pane takes it once typing pauses, so a key costs
  // these hooks and one memo comparison, and the highlights pause meanwhile.
  const latest = props.variants ?? noVariants;
  const text = useSettled(props.text, sameText);
  const variants = useSettled(latest, sameVariants);
  const typing = text !== props.text || !sameVariants(variants, latest);
  return <ReportsPaneMemo {...props} text={text} variants={variants} typing={typing} />;
}

/** One enhanced version as the preview renders it. */
export interface PaneVariant {
  hash: number;
  text: string;
  globals: MarkupGlobals;
}
const noVariants: readonly PaneVariant[] = [];
const sameText = (a: string, b: string) => a === b;
const sameVariants = (a: readonly PaneVariant[], b: readonly PaneVariant[]) =>
  a === b ||
  (a.length === b.length &&
    a.every(
      (view, i) =>
        view.hash === b[i]!.hash && view.text === b[i]!.text && view.globals === b[i]!.globals,
    ));

/** The tooltip whose text a report quotes: the base, or the enhanced version it was made on. */
const quotedHash = (report: PaneReport, base: number) =>
  report.variant === 'base' ? base : report.viewed_hash;

type PaneProps = ReportsPaneProps & { variants: readonly PaneVariant[]; typing: boolean };

const ReportsPaneMemo = memo(function ReportsPaneInner(props: PaneProps) {
  const { hash, lang, suspended } = props;
  const entry = useTooltipReports((state) => state.entries[reportsKey(hash, lang)]);
  const load = useTooltipReports((state) => state.load);
  const count = useReportsIndex((state) => openCount(state.open, hash, lang));
  const phone = useMedia(phoneQuery);
  return (
    <RightPane
      label="Reports"
      busy={entry?.loading}
      className={styles.pane}
      header={
        <RightPaneHeader title="Reports">
          {/* A phone's header row would hold only this; Retry covers a failed load there. */}
          {!phone && (
            <button
              type="button"
              className={styles.tool}
              disabled={suspended || entry?.loading}
              title="Load this tooltip's reports again"
              onClick={() => {
                void load(hash, lang, true, count);
                refreshReportsIndex();
              }}
            >
              Reload
            </button>
          )}
        </RightPaneHeader>
      }
    >
      <ReportsBodyMemo key={`${hash}:${lang}`} {...props} />
      <HighlightLayerMemo />
    </RightPane>
  );
});

/** A value, held while it keeps changing: the latest one once it has been still for 400 ms. */
function useSettled<T>(value: T, same: (a: T, b: T) => boolean) {
  const [settled, setSettled] = useState(value);
  const fresh = same(value, settled);
  useEffect(() => {
    if (fresh) return;
    const timer = setTimeout(() => setSettled(value), 400);
    return () => clearTimeout(timer);
  }, [value, fresh]);
  return settled;
}

const HighlightLayerMemo = memo(HighlightLayer);

function ReportsBody({
  hash,
  lang,
  user,
  text,
  globals,
  variants,
  previewHost,
  suspended,
  ready,
  typing,
}: PaneProps) {
  const count = useReportsIndex((state) => openCount(state.open, hash, lang));
  const indexFailed = useReportsIndex((state) => state.failed && !state.open);
  const entry = useTooltipReports((state) => state.entries[reportsKey(hash, lang)]);
  const load = useTooltipReports((state) => state.load);
  const [showResolved, setShowResolved] = useState(false);
  const reports = entry?.reports ?? null;
  const active = useMemo(() => reports?.filter(isActive) ?? [], [reports]);
  const resolved = useMemo(() => reports?.filter((report) => !isActive(report)) ?? [], [reports]);
  // The index decides whether there is anything to fetch: 0 open = no request unless asked.
  const wanted = count === null ? !indexFailed || showResolved : count > 0 || showResolved;
  // The index moved since these reports were fetched and now disagrees with them: fetch again
  // (once per index change; a list the index still disagrees with is kept as it is).
  const stale =
    reports !== null && count !== null && entry?.indexCount !== count && active.length !== count;
  const settled = !suspended && ready;
  useEffect(() => {
    if (!settled || !wanted || entry?.loading || entry?.error) return;
    if (reports && !stale) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // After the stepper settled and the preview painted: one frame later, off the paint.
    const frame = requestAnimationFrame(() => {
      timer = setTimeout(() => void load(hash, lang, stale, count), 0);
    });
    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(timer);
    };
  }, [settled, wanted, reports, stale, entry?.loading, entry?.error, load, hash, lang, count]);

  const shown = useMemo(
    () => (showResolved ? [...active, ...resolved] : active),
    [active, resolved, showResolved],
  );
  const [selectedId, setSelected] = useState<string | null>(null);
  const selected = shown.find((report) => report.id === selectedId) ?? shown[0] ?? null;

  // Badge numbers: the open reports' notes that sit on today's text of the version they were made
  // on, in list order (a stale or whole-tooltip note has no highlight, so no number). Resolved
  // reports get note states too, so a quote whose text is gone reads as changed.
  const contexts = useMemo(
    () => [{ hash, text, globals }, ...variants.filter((view) => view.hash !== hash)],
    [hash, text, globals, variants],
  );
  const display = useDisplays(contexts, settled && (reports?.length ?? 0) > 0);
  const numbered = useMemo(() => {
    const targets: NoteTarget[] = [];
    if (!display) return targets;
    let number = 0;
    for (const report of active) {
      const variant = quotedHash(report, hash);
      const today = display.get(variant);
      if (!today) continue;
      for (const note of report.notes) {
        const kind = resolveNote(today.text, today.rev, report, note).kind;
        if (kind === 'exact' || kind === 'moved')
          targets.push({ report, note, number: ++number, variant });
      }
    }
    return targets;
  }, [active, display, hash]);
  const numberOf = (report: PaneReport, n: number) =>
    numbered.find((target) => target.report.id === report.id && target.note.n === n)?.number;

  // The pane's own copy of the tooltip when the preview is not on screen (toggle, phone, or a
  // collapsed preview column): the highlights need a rendering to sit on.
  const previewVisible = usePreviewVisible(previewHost);
  const copy = useRef<HTMLDivElement>(null);
  // The copy is the base text: it carries the base's marks (a variant's show on its own preview).
  const showCopy = !previewVisible && numbered.some((target) => target.variant === hash);
  const targets = useCallback(() => {
    const found: HighlightTarget[] = [];
    const host = previewHost.current;
    if (host)
      for (const element of host.querySelectorAll(`.${previewStyles.description}`)) {
        if (element.closest(`.${previewStyles.associated}`)) continue;
        // Each preview body names the tooltip it renders; Compare's diff names none.
        const variant = Number(
          element.closest('[data-preview-hash]')?.getAttribute('data-preview-hash'),
        );
        if (variant) found.push({ element, variant });
      }
    if (copy.current)
      found.push({ element: copy.current.firstElementChild ?? copy.current, variant: hash });
    return found;
  }, [previewHost, hash]);
  const list = useRef<HTMLDivElement>(null);
  const rebuild = useReportHighlights({
    key: `pane:${hash}:${lang}`,
    targets,
    notes: numbered,
    selected: selected?.id ?? null,
    // Registered ranges make Chrome re-check every highlight on each DOM change (a frame per
    // key while typing): the marks pause while the text changes and return once it settles.
    enabled: settled && !typing && numbered.length > 0,
    onSelect: (id) => {
      setSelected(id);
      list.current?.querySelector<HTMLElement>(`[data-report="${id}"]`)?.scrollIntoView({
        block: 'nearest',
      });
    },
  });
  useEffect(() => {
    rebuild.current();
  }, [showCopy, previewVisible, rebuild]);

  // Alt+R or the header entry: focus the first report once it is there.
  const focusPending = useReportsTab((state) => state.focusPending);
  const hasRows = shown.length > 0;
  useEffect(() => {
    if (!focusPending) return;
    if (hasRows) list.current?.focus();
    // Nothing to focus once this tooltip has answered (no reports, or an error): drop the request
    // rather than steal focus later.
    else if (!wanted || reports || entry?.error) useReportsTab.getState().focusDone();
    else return;
    useReportsTab.getState().focusDone();
  }, [focusPending, hasRows, wanted, reports, entry?.error]);

  const [message, setMessage] = useState<string>('');
  const [undo, setUndo] = useState<{ report: PaneReport; version: number; label: string } | null>(
    null,
  );
  useEffect(() => {
    if (!undo) return;
    const timer = setTimeout(() => setUndo(null), 5000);
    return () => clearTimeout(timer);
  }, [undo]);
  const update = useTooltipReports((state) => state.update);
  const remove = useTooltipReports((state) => state.remove);
  const [pending, setPending] = useState<string | null>(null);
  async function act(report: PaneReport, action: PaneAction, expected = report.version) {
    setPending(report.id);
    setMessage('');
    try {
      const result = await postReportAction(report.id, expected, action);
      const patch: Partial<PaneReport> = { status: result.status, version: result.version };
      if (action.action === 'claim') patch.claimed_by = user.login;
      if (action.action === 'reject') patch.closed_note = action.reason;
      if (action.action === 'duplicate') patch.duplicate_of = action.of;
      // Spam deletes the screenshots for good (Undo restores the status only): drop them here
      // too, which unmounts the thumbnails and revokes their blobs, including reads in flight.
      if (action.action === 'spam') patch.files_count = 0;
      update(hash, lang, report.id, patch);
      setMessage(`${report.id} ${pastTense[action.action] ?? result.status}.`);
      // Undo is the reverse action with the version it expects; triage and claim have none.
      if (['reject', 'duplicate', 'close', 'spam'].includes(action.action))
        setUndo({
          report: { ...report, ...patch },
          version: result.version,
          label:
            action.action === 'spam'
              ? `${report.id} marked spam; its screenshots are deleted. Undo restores the status only.`
              : `${report.id} ${pastTense[action.action]}.`,
        });
      else setUndo(null);
      refreshReportsIndex();
    } catch (error) {
      if (error instanceof ReportsHttpError && error.status === 409) {
        setMessage(`${report.id}: ${error.message}. Reloaded.`);
        void load(hash, lang, true, count);
      } else setMessage(`${report.id}: ${errorMessage(error)}`);
    } finally {
      setPending(null);
    }
  }
  const [confirmDelete, setConfirmDelete] = useState<PaneReport | null>(null);
  async function removeReport(report: PaneReport) {
    setPending(report.id);
    try {
      await deleteReport(report.id);
      remove(hash, lang, report.id);
      setMessage(`${report.id} deleted.`);
      setUndo(null);
      refreshReportsIndex();
    } catch (error) {
      setMessage(`${report.id}: ${errorMessage(error)}`);
    } finally {
      setPending(null);
      setConfirmDelete(null);
    }
  }

  function onListKey(event: KeyboardEvent) {
    // Only keys pressed on the list itself: a dialog opened from a row (the screenshot lightbox,
    // portalled but still a React child) or a control inside a row keeps its own keys.
    if (!shown.length || event.defaultPrevented || event.target !== event.currentTarget) return;
    const at = Math.max(
      0,
      shown.findIndex((report) => report.id === selected?.id),
    );
    const to =
      event.key === 'ArrowDown'
        ? Math.min(shown.length - 1, at + 1)
        : event.key === 'ArrowUp'
          ? Math.max(0, at - 1)
          : event.key === 'Home' || event.key === 'PageUp'
            ? 0
            : event.key === 'End' || event.key === 'PageDown'
              ? shown.length - 1
              : -1;
    if (to >= 0) {
      event.preventDefault();
      setSelected(shown[to]!.id);
      list.current
        ?.querySelector<HTMLElement>(`[data-report="${shown[to]!.id}"]`)
        ?.scrollIntoView({ block: 'nearest' });
      return;
    }
    if (event.altKey || event.ctrlKey || event.metaKey || !selected || pending) return;
    if (event.key === 't' && selected.status === 'open') {
      event.preventDefault();
      void act(selected, { action: 'triage' });
    } else if (event.key === 'u' && undo) {
      event.preventDefault();
      void act(undo.report, { action: 'reopen' }, undo.version);
    }
  }

  const listId = useId();
  const maintainer = user.role === 'maintainer';
  const loadingFirst = wanted && !reports && !entry?.error;
  return (
    <DisplayContext.Provider value={display ? { displays: display, base: hash } : null}>
      <div className={styles.body}>
        {showCopy && (
          <div className={styles.copy} ref={copy}>
            <MarkupSnippet text={text} lang={lang} globals={globals} />
          </div>
        )}
        {previewVisible && numbered.length > 0 && (
          <p className={styles.hint}>Highlights in the preview · click one to select its report</p>
        )}
        {entry?.error && (
          <p className={styles.error} role="alert">
            Cannot load reports: {entry.error}{' '}
            <button
              type="button"
              className={styles.linkButton}
              onClick={() => void load(hash, lang, true, count)}
            >
              Retry
            </button>
          </p>
        )}
        {indexFailed && count === null && !reports && (
          <p className={styles.muted}>Report counts are unavailable right now.</p>
        )}
        {loadingFirst && settled && (
          <p className={styles.muted} role="status">
            Loading reports…
          </p>
        )}
        {!settled && !reports && count !== null && count > 0 && (
          <p className={styles.empty}>
            {count} open {count === 1 ? 'report' : 'reports'}
          </p>
        )}
        {!loadingFirst && !active.length && !entry?.error && (
          <p className={styles.empty}>No open reports in {languageLabel(lang)}</p>
        )}
        <div
          ref={list}
          className={styles.list}
          role="listbox"
          aria-label="Reports"
          aria-activedescendant={selected ? `${listId}-${selected.id}` : undefined}
          tabIndex={shown.length ? 0 : -1}
          onKeyDown={onListKey}
          hidden={!shown.length}
        >
          {shown.map((report, index) => (
            <ReportRow
              key={report.id}
              id={`${listId}-${report.id}`}
              report={report}
              selected={report.id === selected?.id}
              first={index === active.length && index > 0}
              numberOf={(n) => numberOf(report, n)}
              onSelect={() => setSelected(report.id)}
            />
          ))}
        </div>
        {(resolved.length > 0 || (reports === null && !showResolved && count === 0)) && (
          <button
            type="button"
            className={styles.linkButton}
            onClick={() => setShowResolved((value) => !value)}
          >
            {showResolved
              ? 'Hide resolved reports'
              : reports === null
                ? 'Show resolved reports'
                : `Show ${resolved.length} resolved`}
          </button>
        )}
        <div
          className={styles.bar}
          role="group"
          aria-label="Report actions"
          // The live region stays mounted for announcements; with nothing in it the bar has no chrome.
          data-empty={(!selected && !undo && !message) || undefined}
        >
          <p className={styles.status} role="status" aria-live="polite">
            {undo ? (
              <>
                {undo.label}{' '}
                <button
                  type="button"
                  className={styles.linkButton}
                  disabled={Boolean(pending)}
                  onClick={() => void act(undo.report, { action: 'reopen' }, undo.version)}
                >
                  Undo
                </button>
              </>
            ) : (
              message
            )}
          </p>
          {selected && (
            <ActionBar
              report={selected}
              others={shown.filter(
                (report) =>
                  report.id !== selected.id &&
                  !['duplicate', 'withdrawn', 'spam'].includes(report.status),
              )}
              login={user.login}
              maintainer={maintainer}
              busy={pending !== null}
              onAction={(action) => void act(selected, action)}
              onDelete={() => setConfirmDelete(selected)}
            />
          )}
          {selected && (
            <p className={styles.keys} aria-hidden="true">
              ↑↓ select · T triage · U undo · Alt+R opens this tab
            </p>
          )}
        </div>
        {confirmDelete && (
          <Dialog
            title={`Delete ${confirmDelete.id}?`}
            compact
            busy={pending !== null}
            onClose={() => setConfirmDelete(null)}
            footer={
              <>
                <button type="button" data-autofocus onClick={() => setConfirmDelete(null)}>
                  Cancel
                </button>
                <button type="button" onClick={() => void removeReport(confirmDelete)}>
                  Delete report
                </button>
              </>
            }
          >
            <p>
              The report, its notes, its history, and its screenshots are removed for good. This
              cannot be undone.
            </p>
          </Dialog>
        )}
      </div>
    </DisplayContext.Provider>
  );
}

/** Whether the page's preview is on screen (a hidden or collapsed one measures 0 × 0). */
function usePreviewVisible(host: RefObject<HTMLElement | null>) {
  const [visible, setVisible] = useState(false);
  const watched = useRef<{ element: HTMLElement | null; observer?: ResizeObserver }>({
    element: null,
  });
  // The host element changes when the preview moves between the column and the page, so check
  // after every render, but subscribe again only for a different element.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    const element = host.current;
    if (watched.current.element === element && watched.current.observer) return;
    watched.current.observer?.disconnect();
    watched.current = { element };
    if (!element) {
      setVisible(false);
      return;
    }
    const rect = element.getBoundingClientRect();
    setVisible(rect.width > 0 && rect.height > 0);
    // The observer's own box: no layout read on each resize (the preview grows as you type).
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setVisible(entry.contentRect.width > 0 && entry.contentRect.height > 0);
    });
    observer.observe(element);
    watched.current.observer = observer;
  });
  useEffect(() => () => watched.current.observer?.disconnect(), []);
  return visible;
}

function Trust({ report }: { report: PaneReport }) {
  if (report.trust === 'anonymous')
    return (
      <span
        className={styles.trust}
        data-trust="anonymous"
        title="Anonymous report: counts for much less"
      >
        ○ anonymous
      </span>
    );
  const history = report.reporter_history;
  const login = report.reporter_login ?? 'account';
  if (report.trust === 'role')
    return (
      <span className={styles.trust} data-trust="role" title="Filed by a role holder">
        ◆ {login}
      </span>
    );
  return (
    <span
      className={styles.trust}
      data-trust="account"
      title="Signed-in reporter; accepted = fixed or closed"
    >
      ● {login}
      {history && ` · filed ${history.filed}, accepted ${history.accepted}`}
    </span>
  );
}

const hostOf = (url: string) => {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
};
const safeLink = (url: string | null | undefined) =>
  url && /^https:\/\//i.test(url) && hostOf(url) ? url : undefined;

function ReportRow({
  id,
  report,
  selected,
  first,
  numberOf,
  onSelect,
}: {
  id: string;
  report: PaneReport;
  selected: boolean;
  /** The first resolved report: a rule above it. */
  first: boolean;
  numberOf(n: number): number | undefined;
  onSelect(): void;
}) {
  const variant =
    report.variant === 'base' ? null : report.variant === 'enhanced' ? 'Enhanced' : 'Override';
  const source = safeLink(report.source_url);
  return (
    <div
      id={id}
      role="option"
      aria-selected={selected}
      data-report={report.id}
      data-first-resolved={first || undefined}
      className={styles.report}
      onClick={onSelect}
    >
      <div className={styles.reportHead}>
        <span className={styles.id}>{report.id}</span>
        <span className={styles.statusText} data-status={report.status}>
          {statusLabels[report.status]}
        </span>
        {report.claimed_by && <span className={styles.meta}>claimed by {report.claimed_by}</span>}
        <span className={styles.category}>
          {categoryLabels[report.category] ?? report.category}
        </span>
        {report.same_count > 0 && (
          <span className={styles.meta}>same issue ×{report.same_count + 1}</span>
        )}
        {variant && <span className={styles.meta}>{variant}</span>}
        {report.seen_lang && report.seen_lang !== report.lang && (
          <span className={styles.meta}>seen in {languageLabel(report.seen_lang as Lang)}</span>
        )}
        <span className={styles.right}>
          <span className={styles.meta} title={new Date(report.created_at * 1000).toLocaleString()}>
            {age(report.created_at)}
          </span>
          <Trust report={report} />
        </span>
      </div>
      {report.status === 'withdrawn' ? (
        <p className={styles.muted}>Withdrawn by the reporter; the text is removed.</p>
      ) : (
        <>
          {report.notes.map((note) => (
            <NoteView key={note.n} report={report} note={note} number={numberOf(note.n)} />
          ))}
          {report.note && <p className={styles.overall}>{report.note}</p>}
          {(report.links.length > 0 || source || report.files_count > 0) && (
            <div className={styles.evidence}>
              {report.files_count > 0 && <Screenshots report={report} />}
              {report.links.map((link) => {
                const href = safeLink(link);
                return (
                  <span key={link} className={styles.link}>
                    Video:{' '}
                    {href ? (
                      <a href={href} target="_blank" rel="noopener noreferrer">
                        {link.replace(/^https:\/\//, '')}
                      </a>
                    ) : (
                      link
                    )}{' '}
                    <span className={styles.meta}>({hostOf(link)})</span>
                  </span>
                );
              })}
              {report.source_url && (
                <span className={styles.link}>
                  Source:{' '}
                  {source ? (
                    <a href={source} target="_blank" rel="noopener noreferrer">
                      {report.source_url.replace(/^https:\/\//, '')}
                    </a>
                  ) : (
                    report.source_url
                  )}
                </span>
              )}
            </div>
          )}
        </>
      )}
      {report.duplicate_of && <p className={styles.muted}>Duplicate of {report.duplicate_of}</p>}
      {report.closed_note && report.status === 'rejected' && (
        <p className={styles.muted}>
          Reason:{' '}
          {rejectReasons.find((r) => r.value === report.closed_note)?.label ?? report.closed_note}
        </p>
      )}
    </div>
  );
}

/** The note's place in today's text, from the core resolver (same text the preview renders). */
function NoteView({
  report,
  note,
  number,
}: {
  report: PaneReport;
  note: PaneReport['notes'][number];
  number: number | undefined;
}) {
  const category =
    note.category !== report.category ? (categoryLabels[note.category] ?? note.category) : null;
  const whole = note.whole || !note.exact;
  return (
    <div className={styles.note}>
      <span
        className={styles.number}
        data-empty={number === undefined || undefined}
        aria-hidden={number === undefined || undefined}
      >
        {number ?? ''}
      </span>
      <div className={styles.noteBody}>
        {whole ? (
          <span className={styles.quoteLine}>
            <span className={styles.whole}>Whole tooltip</span>
            {category && <span className={styles.meta}> · {category}</span>}
          </span>
        ) : (
          <NoteQuote report={report} note={note} category={category} />
        )}
        {note.text && <p className={styles.noteText}>{note.text}</p>}
      </div>
    </div>
  );
}

function NoteQuote({
  report,
  note,
  category,
}: {
  report: PaneReport;
  note: PaneReport['notes'][number];
  category: string | null;
}) {
  const state = useNoteState(report, note);
  if (state === 'stale')
    return (
      <span className={styles.stale}>
        <strong>Text changed since this report.</strong> Original:{' '}
        <q className={styles.quote}>{note.exact}</q>
        {category && <span className={styles.meta}> · {category}</span>}
      </span>
    );
  return (
    <span className={styles.quoteLine}>
      <q className={styles.quote}>{note.exact}</q>
      {state === 'moved' && <span className={styles.meta}> · moved</span>}
      {category && <span className={styles.meta}> · {category}</span>}
    </span>
  );
}

type Display = { text: string; rev: string };

/** Today's display text and revision of the base and each enhanced version, for note states. */
const DisplayContext = createContext<{ displays: Map<number, Display>; base: number } | null>(null);

function useNoteState(report: PaneReport, note: PaneReport['notes'][number]) {
  const context = useContext(DisplayContext);
  // Not computed yet, or a version the preview cannot show now: the quote, with no verdict.
  const today = context?.displays.get(quotedHash(report, context.base));
  if (!today) return 'unknown';
  return resolveNote(today.text, today.rev, report, note).kind;
}

/** Each version's display text, once per text change (core displayText, the selectors' basis). */
function useDisplays(contexts: readonly PaneVariant[], enabled: boolean) {
  const displays = useMemo(
    () =>
      enabled
        ? contexts.map((context) => ({
            hash: context.hash,
            text: displayText(context.text, context.globals),
          }))
        : null,
    [contexts, enabled],
  );
  const [value, setValue] = useState<{
    source: typeof displays;
    map: Map<number, Display>;
  } | null>(null);
  useEffect(() => {
    if (displays === null) return;
    let live = true;
    void Promise.all(
      displays.map(({ hash, text }) =>
        displayRevision(text).then((rev) => [hash, { text, rev }] as const),
      ),
    ).then((entries) => {
      if (live) setValue({ source: displays, map: new Map(entries) });
    });
    return () => {
      live = false;
    };
  }, [displays]);
  return value?.source === displays ? value.map : null;
}

function Screenshots({ report }: { report: PaneReport }) {
  const [open, setOpen] = useState(false);
  const [images, setImages] = useState<{ n: number; url: string | null | 'error' }[] | null>(null);
  const [zoom, setZoom] = useState<number | null>(null);
  useEffect(() => {
    if (!open) return;
    let live = true;
    const urls: string[] = [];
    // files_count is how many survive, not the highest slot (deleting 1 of 2 leaves slot 2):
    // probe every slot (the Worker keeps at most three) and show the ones that answer.
    void Promise.all(
      [1, 2, 3].map((n) =>
        fetchScreenshot(report.id, n).then(
          (url) => {
            if (url && live) urls.push(url);
            else if (url) URL.revokeObjectURL(url);
            return { n, url };
          },
          () => ({ n, url: 'error' as const }),
        ),
      ),
    ).then((result) => {
      if (live) setImages(result.filter((image) => image.url !== null));
    });
    return () => {
      live = false;
      for (const url of urls) URL.revokeObjectURL(url);
      setImages(null);
    };
  }, [open, report.id, report.files_count]);
  const shownImage =
    zoom === null ? null : (images?.find((image) => image.n === zoom)?.url ?? null);
  return (
    <div className={styles.shots}>
      <button
        type="button"
        className={styles.linkButton}
        aria-expanded={open}
        onClick={(event) => {
          event.stopPropagation();
          setOpen((value) => !value);
        }}
      >
        {open ? '▾' : '▸'} {report.files_count}{' '}
        {report.files_count === 1 ? 'screenshot' : 'screenshots'}
      </button>
      {open && (
        <span className={styles.thumbs}>
          {images === null && <span className={styles.meta}>Loading…</span>}
          {images?.length === 0 && <span className={styles.meta}>Screenshots removed</span>}
          {images?.map(({ n, url }) =>
            url === 'error' ? (
              <span key={n} className={styles.meta}>
                Cannot load {n}
              </span>
            ) : (
              <button
                key={n}
                type="button"
                className={styles.thumb}
                aria-label={`Open screenshot ${n}`}
                onClick={(event) => {
                  event.stopPropagation();
                  setZoom(n);
                }}
              >
                <img src={url ?? undefined} alt="" />
              </button>
            ),
          )}
        </span>
      )}
      {typeof shownImage === 'string' && shownImage !== 'error' && (
        <Dialog title={`${report.id} · screenshot ${zoom}`} onClose={() => setZoom(null)}>
          <img
            className={styles.full}
            src={shownImage}
            alt={`Screenshot ${zoom} of ${report.id}`}
          />
        </Dialog>
      )}
    </div>
  );
}

function ActionBar({
  report,
  others,
  login,
  maintainer,
  busy,
  onAction,
  onDelete,
}: {
  report: PaneReport;
  others: PaneReport[];
  login: string;
  maintainer: boolean;
  busy: boolean;
  onAction(action: PaneAction): void;
  onDelete(): void;
}) {
  const live = isActive(report);
  if (report.status === 'withdrawn') return <p className={styles.scope}>{report.id} · withdrawn</p>;
  const canReopen = !live && (report.status !== 'spam' || maintainer);
  const more: { label: string; run(): void; danger?: boolean }[] = [];
  if (live || report.status === 'fixed')
    more.push({ label: 'Close', run: () => onAction({ action: 'close' }) });
  if (live && maintainer)
    more.push({ label: 'Spam', run: () => onAction({ action: 'spam' }), danger: true });
  if (maintainer) more.push({ label: 'Delete…', run: onDelete, danger: true });
  return (
    <>
      <p className={styles.scope}>
        {report.id} · {statusLabels[report.status]}
      </p>
      <span className={styles.actions}>
        {live && report.status === 'open' && (
          <button
            type="button"
            className={styles.action}
            disabled={busy}
            title="Triage (T)"
            onClick={() => onAction({ action: 'triage' })}
          >
            Triage
          </button>
        )}
        {live && report.claimed_by !== login && (
          <button
            type="button"
            className={styles.action}
            disabled={busy}
            onClick={() => onAction({ action: 'claim' })}
          >
            Claim
          </button>
        )}
        {live && (
          <Popover
            label="Reject reason"
            className={styles.action}
            flush
            width={208}
            trigger={
              <>
                Reject <span className={styles.caret}>▾</span>
              </>
            }
          >
            {(close) => (
              <ul className={styles.menu}>
                {rejectReasons.map((reason) => (
                  <li key={reason.value}>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => {
                        close();
                        onAction({ action: 'reject', reason: reason.value });
                      }}
                    >
                      {reason.label}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </Popover>
        )}
        {live && others.length > 0 && (
          <Popover
            label="Duplicate of"
            className={styles.action}
            flush
            width={288}
            trigger={<>Duplicate of…</>}
          >
            {(close) => (
              <ul className={styles.menu}>
                {others.map((other) => (
                  <li key={other.id}>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => {
                        close();
                        onAction({ action: 'duplicate', of: other.id });
                      }}
                    >
                      <span className={styles.id}>{other.id}</span>{' '}
                      {categoryLabels[other.category] ?? other.category}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </Popover>
        )}
        {canReopen && (
          <button
            type="button"
            className={styles.action}
            disabled={busy}
            onClick={() => onAction({ action: 'reopen' })}
          >
            Reopen
          </button>
        )}
        {more.length > 0 && (
          <Popover
            label="More report actions"
            className={styles.action}
            flush
            width={176}
            triggerLabel="More report actions"
            trigger={<>⋯</>}
          >
            {(close) => (
              <ul className={styles.menu}>
                {more.map((item) => (
                  <li key={item.label}>
                    <button
                      type="button"
                      disabled={busy}
                      data-danger={item.danger || undefined}
                      onClick={() => {
                        close();
                        item.run();
                      }}
                    >
                      {item.label}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </Popover>
        )}
      </span>
    </>
  );
}

const ReportsBodyMemo = memo(ReportsBody);
