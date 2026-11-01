import type { ReactNode } from 'react';
import styles from './PlaceholderPage.module.scss';

interface PlaceholderPageProps {
  title: string;
  children: ReactNode;
}

export function PlaceholderPage({ title, children }: PlaceholderPageProps) {
  return (
    <section className={styles.page}>
      <p className={styles.eyebrow}>Clarity editor</p>
      <h1>{title}</h1>
      <div className={styles.panel}>
        <p>{children}</p>
      </div>
    </section>
  );
}
