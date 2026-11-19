import type { ReactNode } from 'react';
import styles from './InlineAlert.module.scss';

/**
 * The one inline error notice: what happened in plain words, then Retry when trying again can
 * help. Messages from a failed request go through `plainError` (services/httpError) first, so no
 * HTTP body or JSON reaches the page.
 */
export function InlineAlert({
  children,
  onRetry,
  retryLabel = 'Retry',
  retryDisabled = false,
  className,
}: {
  children: ReactNode;
  onRetry?(): void;
  retryLabel?: string;
  retryDisabled?: boolean;
  className?: string;
}) {
  return (
    <div role="alert" className={className ? `${styles.alert} ${className}` : styles.alert}>
      <span className={styles.message}>{children}</span>
      {onRetry && (
        <button type="button" disabled={retryDisabled} onClick={onRetry}>
          {retryLabel}
        </button>
      )}
    </div>
  );
}
