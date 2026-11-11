import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { languageLabel } from '../../../languageLabels';
import { myReports, ReportApiError, type MyReport } from '../../../services/reports';
import { useAuthStore } from '../../../stores/auth';
import { statusLabel } from './ReportReceipt';
import { reportCatalog } from './tooltipRender';
import { changedSince, markSeen } from './seen';
import styles from './ReportPage.module.scss';

const day = 86400;
function when(seconds: number): string {
  const elapsed = Date.now() / 1000 - seconds;
  if (elapsed < day) return 'today';
  if (elapsed < 2 * day) return 'yesterday';
  if (elapsed < 30 * day) return `${Math.floor(elapsed / day)} days ago`;
  return new Date(seconds * 1000).toLocaleDateString('en', { dateStyle: 'medium' });
}

/** #/report/mine: the signed-in account's reports, newest first; changed ones carry a dot. */
export function MyReports() {
  const user = useAuthStore((state) => state.user);
  const loading = useAuthStore((state) => state.loading);
  const [rows, setRows] = useState<MyReport[] | null>(null);
  const [names, setNames] = useState<Record<string, string>>({});
  const [changed, setChanged] = useState<Set<string>>(new Set());
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    if (!user) return;
    const controller = new AbortController();
    myReports(controller.signal).then(
      (list) => {
        if (controller.signal.aborted) return;
        setChanged(changedSince(list));
        setRows(list);
        markSeen(list);
      },
      (error: unknown) =>
        !controller.signal.aborted &&
        setProblem(
          error instanceof ReportApiError ? error.message : 'Your reports could not load.',
        ),
    );
    return () => controller.abort();
  }, [user]);

  useEffect(() => {
    if (!rows?.length) return;
    let live = true;
    reportCatalog().then(
      (catalog) => {
        if (!live) return;
        const byOwner: Record<string, string> = {};
        for (const [hash, item] of Object.entries(catalog.items))
          if (Number(hash) === item.owner || !byOwner[item.owner]) byOwner[item.owner] = item.name;
        setNames(byOwner);
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [rows]);

  if (loading)
    return (
      <div className={styles.page}>
        <p role="status" className={styles.muted}>
          Checking sign-in…
        </p>
      </div>
    );
  if (!user)
    return (
      <div className={`${styles.page} ${styles.receipt}`}>
        <h1 className={styles.receiptTitle}>My reports</h1>
        <p className={styles.muted}>
          Sign in (top right) to see the reports you sent under your name. Anonymous reports are
          found through their receipt links.
        </p>
      </div>
    );
  return (
    <div className={`${styles.page} ${styles.mine}`}>
      <div className={styles.mineHead}>
        <h1 className={styles.visuallyHidden}>My reports</h1>
        <Link className={`${styles.linkButton} ${styles.flush}`} to="/report">
          Report an issue
        </Link>
      </div>
      {problem && (
        <p role="alert" className={styles.notice}>
          {problem}
        </p>
      )}
      {!rows && !problem && (
        <p role="status" className={styles.muted}>
          Loading your reports…
        </p>
      )}
      {rows?.length === 0 && <p className={styles.muted}>You have not sent a report yet.</p>}
      {rows && rows.length > 0 && (
        <ul className={styles.mineList}>
          {rows.map((row) => (
            <li key={row.id}>
              <Link className={styles.mineRow} to={`/report/r/${row.id}`}>
                <span className={styles.mineName}>
                  {changed.has(row.id) && (
                    <span className={styles.mineDot}>
                      <span className={styles.visuallyHidden}>Changed since your last visit: </span>
                    </span>
                  )}
                  {names[row.owner_hash] ?? `Tooltip ${row.owner_hash}`}
                </span>
                <span className={styles.mineMeta}>
                  {row.id} · {languageLabel(row.lang)} · {when(row.created_at)}
                </span>
                <span className={styles.status} data-status={statusLabel(row.status)}>
                  {statusLabel(row.status)}
                </span>
                {row.closed_note && <span className={styles.mineNote}>{row.closed_note}</span>}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
