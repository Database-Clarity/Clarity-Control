import { useLayoutEffect, useRef } from 'react';
import { Popover } from '../../../ui/Popover';
import type { FindResponse } from './client';
import type { FindResult } from './index';
import styles from './Results.module.scss';

export function Results({
  anchor,
  id,
  open,
  response,
  active,
  pending,
  failed,
  onClose,
  onOpen,
}: {
  anchor: HTMLElement;
  id: string;
  open: boolean;
  response: FindResponse;
  active: number;
  pending: boolean;
  failed: boolean;
  onClose(): void;
  onOpen(result: FindResult): void;
}) {
  const list = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView?.({ block: 'nearest' });
  }, [active]);
  return (
    <Popover
      label="Find across entries"
      open={open}
      onOpenChange={(value) => {
        if (!value) onClose();
      }}
      anchorElement={anchor}
      flush
    >
      <div className={styles.results}>
        <div role="status" className={styles.status}>
          {failed
            ? 'Search unavailable'
            : pending
              ? 'Updating index…'
              : response.results.length
                ? `${response.results.length}${response.capped ? '+' : ''} results`
                : 'No results'}
        </div>
        <div role="listbox" aria-label="Matching entries" id={`${id}-results`} ref={list}>
          {!pending &&
            response.results.map((result, index) => (
              <button
                key={`${result.hash}:${result.from}`}
                type="button"
                role="option"
                id={`${id}-result-${index}`}
                aria-selected={index === active}
                tabIndex={-1}
                className={styles.result}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => onOpen(result)}
              >
                <span className={styles.name}>{result.name}</span>
                <span className={styles.category}>
                  {result.category} · L{result.line}
                </span>
                <span className={styles.snippet} data-prefix={result.markFrom > 0}>
                  <span className={styles.prefix}>{result.snippet.slice(0, result.markFrom)}</span>
                  <mark>{result.snippet.slice(result.markFrom, result.markTo)}</mark>
                  {result.snippet.slice(result.markTo)}
                </span>
              </button>
            ))}
        </div>
      </div>
    </Popover>
  );
}
