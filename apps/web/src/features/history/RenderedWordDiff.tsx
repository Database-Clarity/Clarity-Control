import { memo, useMemo } from 'react';
import { markupLanguage, type Lang, type MarkupLine, type MarkupSpan } from '@clarity/core';
import { useDataStore } from '../../stores/data';
import { useDraftStore } from '../../stores/drafts';
import { tooltipImports } from '../../services/tooltipImports';
import { previewDrafts } from '../conflicts/previewDrafts';
import { classNames, PreviewSpan } from '../preview/MarkupRenderer';
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
    // Plain text already inherits the preview font and colour. Only semantic
    // spans need PreviewSpan's classes, link policy, and interactive title tree.
    const content = group.parts.map((part, p) =>
      !part.classNames?.length && !part.link && !part.title ? (
        part.text
      ) : (
        <PreviewSpan key={p} part={part} />
      ),
    );
    return group.kind === 'delete' ? (
      <del key={i}>{content}</del>
    ) : group.kind === 'insert' ? (
      <ins key={i}>{content}</ins>
    ) : (
      <span key={i}>{content}</span>
    );
  });
}
const Body = memo(function Body({ lines, lang }: { lines: MarkupLine[]; lang: Lang }) {
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
});

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
  // Read when the comparison receives a source snapshot; do not subscribe this
  // renderer to every authoring keystroke (Working diff already waits for idle).
  const drafts = useDraftStore.getState().drafts;
  const globals = useMemo(() => {
    const imports = data
      ? tooltipImports(data.bundle.tooltips, previewDrafts(drafts), lang, data.aliases, {
          lookupOnly: true,
        })
      : {};
    const type = data?.categories.find(
      (category) => category.id === data.items[hash]?.categoryId,
    )?.legacyType;
    return {
      variables: imports[2] ?? '',
      titles: imports[3] ?? '',
      imports,
      type,
    };
  }, [lang, hash, data, drafts]);
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
