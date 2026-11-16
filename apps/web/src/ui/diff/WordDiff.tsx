import { diffWords } from './diffWords';
import styles from './WordDiff.module.scss';
import type { ReactNode } from 'react';

export function WordDiff({
  before,
  after,
  renderAfter,
}: {
  before: string;
  after: string;
  renderAfter?(text: string, offset: number): ReactNode;
}) {
  let offset = 0;
  return (
    <div
      className={styles.diff}
      aria-label="Word diff: removed text struck through, added text underlined"
    >
      {diffWords(before, after).map((part, index) => {
        const from = offset;
        if (part.kind !== 'delete') offset += part.text.length;
        const content =
          part.kind !== 'delete' && renderAfter ? renderAfter(part.text, from) : part.text;
        return part.kind === 'delete' ? (
          <del key={index}>{part.text}</del>
        ) : part.kind === 'insert' ? (
          <ins key={index}>{content}</ins>
        ) : (
          <span key={index}>{content}</span>
        );
      })}
      {!before && !after && <span>No text</span>}
    </div>
  );
}
