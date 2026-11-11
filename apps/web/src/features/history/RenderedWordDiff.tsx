import { useMemo } from 'react';
import { markupLanguage, type Lang, type MarkupLine, type MarkupSpan } from '@clarity/core';
import { useDataStore } from '../../stores/data';
import { tooltipImports } from '../../services/tooltipImports';
import { classNames, PreviewSpan } from '../preview/TooltipPreview';
import preview from '../preview/TooltipPreview.module.scss';
import styles from './RenderedWordDiff.module.scss';
import { changedSourceLines, type DiffSpan } from './renderedDiff';
import { useRenderedDiff } from './useRenderedDiff';

function Parts({ parts }: { parts: MarkupSpan[] }) {
  const groups: { kind: DiffSpan['diffKind']; parts: MarkupSpan[] }[] = [];
  for (const part of parts) {
    const kind = (part as DiffSpan).diffKind;
    const last = groups.at(-1);
    if (last && last.kind === kind) last.parts.push(part);
    else groups.push({ kind, parts: [part] });
  }
  return groups.map((group, i) => {
    const content = group.parts.map((part, p) => <PreviewSpan key={p} part={part} />);
    return group.kind === 'delete' ? (
      <del key={i}>{content}</del>
    ) : group.kind === 'insert' ? (
      <ins key={i}>{content}</ins>
    ) : (
      <span key={i}>{content}</span>
    );
  });
}
function Body({ lines, lang }: { lines: MarkupLine[]; lang: Lang }) {
  return (
    <div className={`${preview.snippet} ${styles.body}`} lang={markupLanguage(lang)}>
      {lines.map((line, i) =>
        line.table ? (
          <table key={i} className={classNames(line.classNames)}>
            <tbody>
              {line.table.map((row, r) => (
                <tr key={r} className={classNames(row.classNames)}>
                  {row.rowContent?.map((cell, c) => (
                    <td
                      key={c}
                      colSpan={cell.colSpan}
                      rowSpan={cell.rowSpan}
                      className={classNames(cell.classNames)}
                    >
                      <Parts parts={cell.cellContent} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div key={i} className={classNames(line.classNames)}>
            <Parts parts={line.linesContent ?? []} />
          </div>
        ),
      )}
    </div>
  );
}

export function RenderedWordDiff({
  before,
  after,
  lang,
  hash,
}: {
  before: string;
  after: string;
  lang: Lang;
  hash: number;
}) {
  const data = useDataStore((state) => state.data);
  const globals = useMemo(() => {
    const imports = data ? tooltipImports(data.bundle.tooltips, {}, lang, data.aliases) : {};
    const type = data?.categories.find(
      (category) => category.id === data.items[hash]?.categoryId,
    )?.legacyType;
    return {
      variables: imports[2] ?? '',
      titles: imports[3] ?? '',
      imports,
      type,
    };
  }, [lang, hash, data]);
  const { result, busy } = useRenderedDiff(before, after, globals);
  return (
    <div className={styles.diff} aria-busy={busy || undefined}>
      {before !== after && (
        <p className={styles.sourceChange} data-source-change>
          {changedSourceLines(before, after)}
        </p>
      )}
      <div className={styles.sides}>
        <div>
          <strong>Previous / live</strong>
          <Body lines={result.before} lang={lang} />
        </div>
        <div>
          <strong>Current</strong>
          <Body lines={result.after} lang={lang} />
        </div>
      </div>
    </div>
  );
}
