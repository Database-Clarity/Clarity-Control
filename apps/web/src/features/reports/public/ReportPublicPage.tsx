import { lazy, Suspense, useEffect } from 'react';
import { Link, useLocation, useParams, useRoutes } from 'react-router-dom';
import { useAuthStore } from '../../../stores/auth';
import { phoneQuery, useMedia } from '../../../ui/useMedia';
import { Brand } from '../../navigation/Brand';
import { ReportIdentityMenu } from './ReportIdentityMenu';
const MyReports = lazy(() => import('./MyReports').then((m) => ({ default: m.MyReports })));
import { ReportForm } from './ReportForm';
const ReportPicker = lazy(() =>
  import('./ReportPicker').then((m) => ({ default: m.ReportPicker })),
);
const ReportReceipt = lazy(() =>
  import('./ReportReceipt').then((m) => ({ default: m.ReportReceipt })),
);
import styles from './ReportPage.module.scss';

/** A new item gets a fresh form (its own draft, render, and human check). */
function FormForItem() {
  const { hash } = useParams();
  return <ReportForm key={hash} />;
}

/** Receipt and My reports state belongs to one report and one account: either change starts afresh. */
const useAccount = () => useAuthStore((state) => state.user?.login ?? '');

export function ReceiptForReport() {
  const { id } = useParams();
  const account = useAccount();
  return (
    <Suspense fallback={<p role="status">Loading…</p>}>
      <ReportReceipt key={`${id}:${account}`} />
    </Suspense>
  );
}

export function MyReportsForAccount() {
  const account = useAccount();
  return (
    <Suspense fallback={<p role="status">Loading…</p>}>
      <MyReports key={account} />
    </Suspense>
  );
}

const routes = [
  { index: true, element: <ReportPicker /> },
  { path: 'mine', element: <MyReportsForAccount /> },
  { path: 'r/:id', element: <ReceiptForReport /> },
  { path: ':hash', element: <FormForItem /> },
];

function pageTitle(pathname: string): string {
  if (/^\/report\/mine\/?$/.test(pathname)) return 'My reports';
  if (/^\/report\/r\//.test(pathname)) return 'Report receipt';
  return 'Report an issue';
}

/**
 * The public report pages (#/report/*), mounted outside the editor workspace: a minimal header
 * (lockup, page title, the one sign-in control) and the picker, form, receipt, or My reports. It
 * loads neither the editor bundle nor the generator data.
 */
export function ReportPublicPage() {
  const phone = useMedia(phoneQuery);
  const { pathname } = useLocation();
  const title = pageTitle(pathname);
  const element = useRoutes(routes);
  useEffect(() => {
    document.title = `${title} · Clarity Control`;
  }, [title]);
  return (
    <div className={styles.shell}>
      <header className={styles.header}>
        <Link to="/report" className={styles.brandLink} aria-label="Report an issue: start">
          <Brand compact={phone} />
        </Link>
        <span className={styles.title}>{title}</span>
        <span className={styles.headerEnd}>
          <ReportIdentityMenu />
        </span>
      </header>
      <main className={styles.main}>
        <Suspense fallback={<p role="status">Loading…</p>}>{element}</Suspense>
      </main>
    </div>
  );
}

export default ReportPublicPage;
