import { SkeletonBoundary } from '../../ui/Skeleton';
import { memo, useMemo } from 'react';
import { markupLanguage, type Lang, type MarkupLine, type MarkupSpan } from '@clarity/core';
import { useDataStore } from '../../stores/data';
import { useDraftStore } from '../../stores/drafts';
import { tooltipImports } from '../../services/tooltipImports';
import { previewDrafts } from '../conflicts/previewDrafts';
import { MarkupLines, PreviewSpan } from '../preview/MarkupRenderer';
import preview from '../preview/TooltipPreview.module.scss';
import styles from './RenderedWordDiff.module.scss';
import type { DiffLine, DiffSpan } from './renderedDiff';
import type { SourceMarker } from './sourceOnlyChanges';
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
// Line references inside a marker label ("line 18", "lines 14–15").
const RANGE = /(lines? \d+(?:–\d+)?)/;
function Markers({ markers }: { markers: SourceMarker[] }) {
  return markers.map((marker, index) => (
    <p key={index} className={styles.sourceChange} data-source-change>
      {marker.label.split(RANGE).map((piece, i) =>
        i % 2 ? (
          <span key={i} className={styles.range}>
            {piece}
          </span>
        ) : (
          piece
        ),
      )}
    </p>
  ));
}
const diffParts = (parts: MarkupSpan[]) => <Parts parts={parts} />;
// A changed line break, spacer, line class, or table is marked on the line itself.
const diffLine = (line: MarkupLine) =>
  (line as DiffLine).diffKind === 'insert'
    ? styles.lineInsert
    : (line as DiffLine).diffKind === 'delete'
      ? styles.lineDelete
      : undefined;
const Body = memo(function Body({
  lines,
  lang,
  markers = [],
}: {
  lines: MarkupLine[];
  lang: Lang;
  markers?: SourceMarker[];
}) {
  return (
    <div className={`${preview.snippet} ${styles.body}`} lang={markupLanguage(lang)}>
      <MarkupLines
        lines={lines}
        renderParts={diffParts}
        lineClass={diffLine}
        beforeLine={(index) => (
          <Markers markers={markers.filter((marker) => marker.position === index)} />
        )}
        afterLines={
          <Markers markers={markers.filter((marker) => marker.position >= lines.length)} />
        }
      />
    </div>
  );
});

export function RenderedWordDiff({
  before,
  after,
  lang,
  hash,
  working = false,
  responsive = false,
}: {
  before: string;
  after: string;
  lang: Lang;
  hash: number;
  working?: boolean;
  responsive?: boolean;
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
  const { result, busy, sourceAnalysis, sourceUnavailable } = useRenderedDiff(
    before,
    after,
    globals,
  );
  const markers = sourceAnalysis?.markers ?? [];
  const side = (text: string, lines: MarkupLine[], located?: SourceMarker[]) =>
    text && lines.length ? (
      <Body lines={lines} lang={lang} markers={located} />
    ) : (
      <div className={`${preview.snippet} ${styles.body}`}>
        {located && <Markers markers={located} />}
        <span className={styles.missing}>{text ? '(no rendered text)' : '(not present)'}</span>
      </div>
    );
  return (
    <SkeletonBoundary
      pending={busy}
      error={sourceUnavailable}
      identity={`${hash}:${lang}:${before}:${after}`}
      label="Preparing rendered comparison…"
      text={after || before}
    >
      <div
        className={`${styles.diff} ${responsive ? styles.responsive : ''}`}
        aria-busy={busy || undefined}
        data-one-sided={!before || !after || undefined}
      >
        {!!markers.length && (
          <p className={styles.sourceChange}>
            {markers.length} source {markers.length === 1 ? 'change' : 'changes'} flagged below ·
            Raw shows the markup
          </p>
        )}
        {!!sourceAnalysis?.unchecked && (
          <p className={styles.sourceChange} data-source-unchecked>
            {sourceAnalysis.unchecked} changes not checked: see Raw
          </p>
        )}
        {sourceUnavailable && before !== after && (
          <p className={styles.sourceChange} data-source-unchecked>
            Source changes not checked: see Raw
          </p>
        )}
        <div className={styles.sides}>
          <div>
            <strong>{working ? 'Saved' : 'Previous / live'}</strong>
            {side(before, result.before)}
          </div>
          <div>
            <strong>{working ? 'Unsaved' : 'Current'}</strong>
            {side(after, result.after, markers)}
          </div>
        </div>
      </div>
    </SkeletonBoundary>
  );
}
