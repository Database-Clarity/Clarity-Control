import type { ReactNode } from 'react';
import styles from './PlaceholderPage.module.scss';

interface PlaceholderPageProps {
  title: string;
  children: ReactNode;
}

/** Not-found and not-yet-built pages: the app's compact title row and one plain line. */
export function PlaceholderPage({ title, children }: PlaceholderPageProps) {
  return (
    <section className={styles.page}>
      <h1>{title}</h1>
      <p>{children}</p>
    </section>
  );
}
