import { useEffect } from 'react';
import { Link, useLocation, useParams, useRoutes } from 'react-router-dom';
import { phoneQuery, useMedia } from '../../../ui/useMedia';
import { Brand } from '../../navigation/Brand';
import { IdentityMenu } from '../../navigation/IdentityMenu';
import { MyReports } from './MyReports';
import { ReportForm } from './ReportForm';
import { ReportPicker } from './ReportPicker';
import { ReportReceipt } from './ReportReceipt';
import styles from './ReportPage.module.scss';

/** A new item gets a fresh form (its own draft, render, and human check). */
function FormForItem() {
  const { hash } = useParams();
  return <ReportForm key={hash} />;
}

const routes = [
  { index: true, element: <ReportPicker /> },
  { path: 'mine', element: <MyReports /> },
  { path: 'r/:id', element: <ReportReceipt /> },
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
          <IdentityMenu />
        </span>
      </header>
      <main className={styles.main}>{element}</main>
    </div>
  );
}

export default ReportPublicPage;
