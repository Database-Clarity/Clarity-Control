import { useEffect, useState } from 'react';
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { languageLabel } from '../../../languageLabels';
import {
  reportReceipt,
  ReportApiError,
  viewOwnReport,
  withdrawReport,
  type ReporterDetail,
  type ReportReceipt as Receipt,
} from '../../../services/reports';
import { useAuthStore } from '../../../stores/auth';
import { Dialog } from '../../../ui/Dialog';
import { rememberSecret, storedSecret } from './draft';
import type { ReceiptState } from './ReportForm';
import { reportCatalog } from './tooltipRender';
import styles from './ReportPage.module.scss';

export const statusText: Record<string, string> = {
  open: 'Editors see it the next time they work on this tooltip.',
  triaged: 'An editor has looked at it and will work on it.',
  fixed: 'Fixed: the corrected text goes live with the next publish.',
  closed: 'Closed.',
  rejected: 'Closed without a change.',
  duplicate: 'Closed as a duplicate of another report.',
  spam: 'Closed.',
  withdrawn: 'Withdrawn: its text, links, and screenshots were deleted.',
};
/** What the reporter sees as the status word (spam reads as closed). */
export const statusLabel = (status: string) => (status === 'spam' ? 'closed' : status);
export const withdrawable = (status: string) => status === 'open' || status === 'triaged';

/** The canonical receipt link: the only key to an anonymous report. */
export function receiptLink(id: string, secret: string): string {
  return `${location.origin}${location.pathname}#/report/r/${id}?w=${encodeURIComponent(secret)}`;
}

/** #/report/r/<id>: status, the editors' note, the receipt link, Withdraw. */
export function ReportReceipt() {
  const { id = '' } = useParams();
  const [params] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();
  const sent = (location.state as ReceiptState | null)?.sent
    ? (location.state as ReceiptState)
    : null;
  const user = useAuthStore((state) => state.user);
  const authLoading = useAuthStore((state) => state.loading);
  const fromLink = params.get('w');
  const [secret] = useState(() => fromLink ?? storedSecret(id));
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [detail, setDetail] = useState<ReporterDetail | null>(null);
  const [name, setName] = useState<string | null>(sent?.name ?? null);
  const [problem, setProblem] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [withdrawing, setWithdrawing] = useState(false);

  // The secret moves from the location into this tab's storage before anything renders it.
  useEffect(() => {
    if (!fromLink) return;
    rememberSecret(id, fromLink);
    navigate({ pathname: `/report/r/${id}`, search: '' }, { replace: true, state: location.state });
  }, [fromLink, id, navigate, location.state]);

  useEffect(() => {
    if (authLoading) return;
    const controller = new AbortController();
    reportReceipt(id, controller.signal).then(setReceipt, (error: unknown) => {
      if (controller.signal.aborted) return;
      setProblem(
        error instanceof ReportApiError && error.status === 404
          ? `There is no report ${id}. It may have been deleted.`
          : error instanceof ReportApiError
            ? error.message
            : 'The report could not load.',
      );
    });
    if (secret || user)
      viewOwnReport(id, secret, controller.signal).then(setDetail, () => setDetail(null));
    return () => controller.abort();
  }, [id, secret, user, authLoading]);

  useEffect(() => {
    if (name || !detail) return;
    let live = true;
    reportCatalog().then(
      (catalog) => live && setName(catalog.items[String(detail.viewed_hash)]?.name ?? null),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [detail, name]);

  const status = detail?.status ?? receipt?.status;
  const own = Boolean(detail);
  const withdraw = async () => {
    setWithdrawing(true);
    try {
      const result = await withdrawReport(id, secret);
      setReceipt({ status: result.status, closed_note: null });
      setDetail((current) => (current ? { ...current, status: result.status } : current));
      setConfirming(false);
    } catch (error) {
      setProblem(
        error instanceof ReportApiError ? error.message : 'The report could not be withdrawn.',
      );
      setConfirming(false);
    } finally {
      setWithdrawing(false);
    }
  };

  const link = secret ? receiptLink(id, secret) : null;
  const lang = detail?.lang ?? sent?.lang;
  const notes = detail?.notes.length ?? sent?.notes;
  const owner = detail?.owner_hash ?? sent?.owner;
  const meta = [
    name,
    lang && languageLabel(lang),
    notes !== undefined && `${notes} ${notes === 1 ? 'note' : 'notes'}`,
  ].filter(Boolean);

  return (
    <div className={`${styles.page} ${styles.receipt}`}>
      <h1 className={styles.receiptTitle}>
        Report {id}
        {sent ? ' sent' : ''}
      </h1>
      {(meta.length > 0 || status) && (
        <p className={styles.receiptMeta}>
          {meta.join(' · ')}
          {status && (
            <>
              {meta.length > 0 && ' · '}
              <span className={styles.status} data-status={statusLabel(status)}>
                {statusLabel(status)}
              </span>
            </>
          )}
        </p>
      )}
      {!status && !problem && (
        <p className={styles.muted} role="status">
          Loading the report…
        </p>
      )}
      {status && <p className={styles.muted}>{statusText[status]}</p>}
      {receipt?.closed_note && (
        <p className={styles.closedNote}>
          <span className={styles.label}>Editors’ note</span> {receipt.closed_note}
        </p>
      )}
      {problem && (
        <p role="alert" className={styles.notice}>
          {problem}
        </p>
      )}
      {sent && sent.uploads.length > 0 && (
        <div role="alert" className={styles.notice}>
          {sent.uploads.map((line) => (
            <p key={line}>{line}</p>
          ))}
        </div>
      )}
      {link && (
        <>
          <label className={styles.label} htmlFor="receipt-link">
            {sent ? 'Check its status any time at this link:' : 'Receipt link'}
          </label>
          <textarea
            id="receipt-link"
            className={styles.receiptLink}
            readOnly
            rows={2}
            value={link}
            onFocus={(event) => event.currentTarget.select()}
          />
          <p className={styles.muted}>
            Keep this link: it is the only way to check or withdraw an anonymous report.
          </p>
        </>
      )}
      <div className={styles.actions}>
        {link && (
          <button
            type="button"
            className={styles.button}
            onClick={() =>
              void navigator.clipboard?.writeText(link).then(
                () => setCopied(true),
                () => setCopied(false),
              )
            }
          >
            {copied ? 'Copied' : 'Copy link'}
          </button>
        )}
        {owner !== undefined && (
          <Link className={styles.linkButton} to={`/t/${owner}`}>
            View this tooltip
          </Link>
        )}
        {own && status && withdrawable(status) && (
          <button type="button" className={styles.dangerText} onClick={() => setConfirming(true)}>
            Withdraw…
          </button>
        )}
      </div>
      <p className={styles.muted}>
        {user ? (
          <>
            Find every report you sent under <Link to="/report/mine">My reports</Link>.
          </>
        ) : (
          'Anonymous reports have no notifications; sign in next time to find your reports under your name.'
        )}
      </p>
      <Link className={`${styles.button} ${styles.another}`} to="/report">
        Report another issue
      </Link>
      {confirming && (
        <Dialog
          title={`Withdraw report ${id}?`}
          compact
          busy={withdrawing}
          onClose={() => setConfirming(false)}
          footer={
            <>
              <button
                type="button"
                className={styles.danger}
                onClick={() => void withdraw()}
                disabled={withdrawing}
              >
                {withdrawing ? 'Withdrawing…' : 'Withdraw report'}
              </button>
              <button type="button" className={styles.button} onClick={() => setConfirming(false)}>
                Keep it
              </button>
            </>
          }
        >
          <p>Its text, links, and screenshots are deleted now. This cannot be undone.</p>
        </Dialog>
      )}
    </div>
  );
}
