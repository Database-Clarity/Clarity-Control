import type { CSSProperties, ReactNode } from 'react';
import type { CompendiumCell, CompendiumRun } from '@clarity/core';
import styles from './RichCell.module.scss';

function runStyle(run: CompendiumRun): CSSProperties {
  return {
    color: run.color,
    fontSize: run.sizePt === undefined ? undefined : `${run.sizePt}pt`,
    fontWeight: run.bold ? 700 : 400,
    fontStyle: run.italic ? 'italic' : 'normal',
    textDecoration:
      [run.underline && 'underline', run.strike && 'line-through'].filter(Boolean).join(' ') ||
      'none',
  };
}
export function Multiline({ children }: { children: ReactNode }) {
  return (
    <span className={styles.multiline} data-multiline="true">
      {children}
    </span>
  );
}
export function RichCell({ cell, links = true }: { cell: CompendiumCell; links?: boolean }) {
  return (
    <Multiline>
      {cell.runs.map((run, index) => {
        const content = <span style={runStyle(run)}>{run.text}</span>;
        return run.href && links ? (
          <a key={index} href={run.href} target="_blank" rel="noreferrer">
            {content}
          </a>
        ) : (
          <span key={index}>{content}</span>
        );
      })}
    </Multiline>
  );
}
