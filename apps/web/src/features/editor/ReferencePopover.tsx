import { useMemo } from 'react';
import type { Lang, MarkupGlobals } from '@clarity/core';
import { MarkupSnippet } from '../preview';
import { WithArrows } from '../../ui/EnhancedArrow';
import type { ResolvedReference } from './references';
import styles from './ReferencePopover.module.scss';

const maxRenderedLines = 30;

export interface ReferencePopoverProps {
  resolved: ResolvedReference;
  lang: Lang;
  /** Globals plus the open document's own definitions, so nested references expand. */
  globals: MarkupGlobals;
  /** Present only when the definition can be reached. */
  onOpen?: () => void;
  openShortcut: string;
}

function kindLabel(resolved: ResolvedReference): string {
  if (resolved.kind === 'variable') return 'Variable';
  if (resolved.kind === 'title') return 'Title';
  return resolved.whole ? 'Import' : 'Export';
}

function originLabel(resolved: ResolvedReference): string {
  if (resolved.scope === 'local') return 'local · this tooltip';
  if (resolved.scope === 'import')
    return resolved.whole
      ? `main text of tooltip ${resolved.hash}`
      : `from tooltip ${resolved.hash}`;
  return `global · ${resolved.kind === 'variable' ? 'Variables' : 'Titles'} (${resolved.hash})`;
}

/** One line of raw markup: newlines shown as a return mark so the line never grows. */
function rawLine(value: string): string {
  return value === '' ? '(empty)' : value.replace(/\n/g, ' ⏎ ');
}

export function ReferencePopover({
  resolved,
  lang,
  globals,
  onOpen,
  openShortcut,
}: ReferencePopoverProps) {
  const { shown, hidden } = useMemo(() => {
    const lines = (resolved.value ?? '').split('\n');
    return {
      shown: lines.slice(0, maxRenderedLines).join('\n'),
      hidden: Math.max(0, lines.length - maxRenderedLines),
    };
  }, [resolved.value]);
  if (resolved.status === 'missing') {
    return (
      <div className={styles.popover}>
        <div className={styles.head}>
          <code className={styles.name}>{resolved.label}</code>
          <strong className={styles.missing}>Not defined</strong>
        </div>
        <p className={styles.note}>{resolved.reason}</p>
      </div>
    );
  }
  return (
    <div className={styles.popover}>
      <div className={styles.head}>
        <span className={styles.kind}>{kindLabel(resolved)}</span>
        <code className={styles.name}>{resolved.label}</code>
        {resolved.fallback && (
          <abbr className={styles.fallback} title="Shown in English: not defined in this language">
            EN
          </abbr>
        )}
        <span className={styles.origin}>{originLabel(resolved)}</span>
      </div>
      {resolved.value === '' ? (
        <p className={styles.note}>Empty (renders as nothing).</p>
      ) : (
        <div className={styles.value}>
          <MarkupSnippet text={shown} lang={resolved.lang ?? lang} globals={globals} />
          {hidden > 0 && <p className={styles.more}>… {hidden} more lines</p>}
        </div>
      )}
      <code className={styles.raw} title={resolved.value}>
        <WithArrows text={rawLine(shown)} />
      </code>
      {resolved.note && <p className={styles.note}>{resolved.note}</p>}
      {onOpen && (
        <button type="button" className={styles.open} onClick={onOpen}>
          Open definition <kbd>{openShortcut}</kbd>
        </button>
      )}
    </div>
  );
}
