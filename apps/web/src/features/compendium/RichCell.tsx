import type { CSSProperties, ReactNode } from 'react';
import type { CompendiumCell, CompendiumRun } from '@clarity/core';
import { readableOn, useLegibleOn } from './sheetSurface';
import styles from './RichCell.module.scss';

function runStyle(run: CompendiumRun, legibleOn?: string): CSSProperties {
  return {
    color: run.color && legibleOn ? readableOn(run.color, legibleOn) : run.color,
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
export function RichCell({
  cell,
  links = true,
  inline = false,
}: {
  cell: CompendiumCell;
  links?: boolean;
  inline?: boolean;
}) {
  const legibleOn = useLegibleOn();
  // A block per physical line lets joined cells retain different alignments without
  // changing their text, rich runs, or blank lines. Diff fragments opt into inline.
  if (!inline && cell.runs.some((run) => run.textAlign)) {
    const lines: CompendiumRun[][] = [[]];
    for (const run of cell.runs) {
      run.text.split('\n').forEach((text, index) => {
        if (index) lines.push([]);
        lines.at(-1)!.push({ ...run, text });
      });
    }
    return (
      <Multiline>
        {lines.map((runs, index) => (
          <span
            key={index}
            className={styles.line}
            style={{
              textAlign: runs.find((run) => run.text.trim())?.textAlign ?? runs[0]?.textAlign,
            }}
          >
            <RichCell
              cell={{ plain: runs.map((run) => run.text).join(''), runs }}
              links={links}
              inline
            />
            {index < lines.length - 1 ? '\n' : null}
          </span>
        ))}
      </Multiline>
    );
  }
  return (
    <Multiline>
      {cell.runs.map((run, index) => {
        const content = <span style={runStyle(run, legibleOn)}>{run.text}</span>;
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
