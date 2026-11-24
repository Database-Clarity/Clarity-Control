import { SkeletonBoundary } from '../../ui/Skeleton';
import { memo, useMemo, useState } from 'react';
import {
  markupLanguage,
  type Lang,
  type MarkupGlobals,
  type MarkupLine,
  type MarkupSpan,
} from '@clarity/core';
import type { Drafts } from '../../services/draftStorage';
import { useDataStore, type EditorData } from '../../stores/data';
import { useDraftStore } from '../../stores/drafts';
import { tooltipImports } from '../../services/tooltipImports';
import { previewDrafts } from '../conflicts/previewDrafts';
import { MarkupLines, PreviewSpan } from '../preview/MarkupRenderer';
import preview from '../preview/TooltipPreview.module.scss';
import styles from './RenderedWordDiff.module.scss';
import { variantGlobals, type DiffLine, type DiffSpan } from './renderedDiff';
import { HistoryWordDiff } from './HistoryWordDiff';
import { WordDiff } from '../../ui/diff/WordDiff';
import type { SourceMarker } from './sourceOnlyChanges';
import { useRenderedDiff } from './useRenderedDiff';

/** The markup globals a rendered comparison of `hash` uses (imports, variables, item type). */
export function diffGlobals(
  data: EditorData | null,
  drafts: Drafts,
  lang: Lang,
  hash: number,
  mode: 'authored' | 'live' = 'authored',
): MarkupGlobals {
  const imports = data
    ? tooltipImports(data.bundle.tooltips, drafts, lang, data.aliases, {
        lookupOnly: true,
        live: mode === 'live',
      })
    : {};
  const type = data?.categories.find(
    (category) => category.id === data.items[hash]?.categoryId,
  )?.legacyType;
  return variantGlobals(
    { variables: imports[2] ?? '', titles: imports[3] ?? '', imports, type },
    false,
  );
}

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
const diffParts = (parts: MarkupSpan[]) => <Parts parts={parts} />;
// A changed line break, spacer, line class, or table is marked on the line itself.
const diffLine = (line: MarkupLine) =>
  (line as DiffLine).diffKind === 'insert'
    ? styles.lineInsert
    : (line as DiffLine).diffKind === 'delete'
      ? styles.lineDelete
      : undefined;
export const Body = memo(function Body({ lines, lang }: { lines: MarkupLine[]; lang: Lang }) {
  return (
    <div
      data-rendered-body
      className={`${preview.snippet} ${styles.body}`}
      lang={markupLanguage(lang)}
    >
      <MarkupLines lines={lines} renderParts={diffParts} lineClass={diffLine} />
    </div>
  );
});

/** A shared fold opens both sides together, so neither column gains a private spacer. */
function Comparison({
  before,
  after,
  lang,
  beforeLabel,
  afterLabel,
}: {
  before: MarkupLine[];
  after: MarkupLine[];
  lang: Lang;
  beforeLabel: string;
  afterLabel: string;
}) {
  const sides = (a: MarkupLine[], b: MarkupLine[]) =>
    !a.length && !b.length ? null : (
      <div className={styles.sides}>
        <div>
          <strong>{beforeLabel}</strong>
          <Body lines={a} lang={lang} />
        </div>
        <div>
          <strong>{afterLabel}</strong>
          <Body lines={b} lang={lang} />
        </div>
      </div>
    );
  const same = (a: MarkupLine, b: MarkupLine) => JSON.stringify(a) === JSON.stringify(b);
  let head = 0,
    tail = 0;
  const long =
    Math.max(before.length, after.length) > 10 || JSON.stringify([before, after]).length > 2400;
  if (long) {
    while (head < Math.min(before.length, after.length) && same(before[head], after[head])) head++;
    while (
      tail < Math.min(before.length, after.length) - head &&
      same(before[before.length - tail - 1], after[after.length - tail - 1])
    )
      tail++;
  }
  if (head < 3 && JSON.stringify(before.slice(0, head)).length < 800) head = 0;
  if (tail < 3 && JSON.stringify(tail ? before.slice(-tail) : []).length < 800) tail = 0;
  const fold = (a: MarkupLine[], b: MarkupLine[]) => (
    <details className={styles.fold}>
      <summary>
        {a.length} unchanged {a.length === 1 ? 'line' : 'lines'}
      </summary>
      {sides(a, b)}
    </details>
  );
  return (
    <>
      {!!head && fold(before.slice(0, head), after.slice(0, head))}
      {sides(before.slice(head, before.length - tail), after.slice(head, after.length - tail))}
      {!!tail && fold(before.slice(-tail), after.slice(-tail))}
    </>
  );
}

function SourceChanges({
  markers,
  before,
  after,
}: {
  markers: SourceMarker[];
  before: string;
  after: string;
}) {
  const extract = (source: string, range: SourceMarker['previous']) =>
    range
      ? source
          .split('\n')
          .slice(range[0] - 1, range[1])
          .join('\n')
      : '';
  return markers.map((marker, index) => (
    <div key={index} className={styles.sourceChange} data-source-change>
      <p>{marker.label.replace(/ · see Raw$/, '')}</p>
      <HistoryWordDiff
        before={marker.insertion?.[0] ? '' : extract(before, marker.previous)}
        after={marker.insertion?.[1] ? '' : extract(after, marker.current)}
      />
    </div>
  ));
}

const SourceFallback = memo(function SourceFallback({
  before,
  after,
}: {
  before: string;
  after: string;
}) {
  return (
    <div className={styles.sourceChange} data-source-unchecked>
      <p>Rendered comparison check unavailable · Source changes</p>
      <WordDiff before={before} after={after} />
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
  beforeLabel,
  afterLabel,
}: {
  before: string;
  after: string;
  lang: Lang;
  hash: number;
  working?: boolean;
  responsive?: boolean;
  beforeLabel?: string;
  afterLabel?: string;
}) {
  const data = useDataStore((state) => state.data);
  // Read when the comparison receives a source snapshot; do not subscribe this
  // renderer to every authoring keystroke (Working diff already waits for idle).
  const drafts = useDraftStore.getState().drafts;
  const globals = useMemo(
    () => diffGlobals(data, previewDrafts(drafts), lang, hash),
    [lang, hash, data, drafts],
  );
  const { result, busy, sourceAnalysis, sourceUnavailable } = useRenderedDiff(
    before,
    after,
    globals,
  );
  return (
    <RenderedWordDiffView
      before={before}
      after={after}
      lang={lang}
      hash={hash}
      working={working}
      responsive={responsive}
      beforeLabel={beforeLabel}
      afterLabel={afterLabel}
      result={result}
      busy={busy}
      sourceAnalysis={sourceAnalysis}
      sourceUnavailable={sourceUnavailable}
    />
  );
}

export function RenderedWordDiffView({
  before,
  after,
  lang,
  hash,
  working = false,
  responsive = false,
  beforeLabel,
  afterLabel,
  result,
  busy,
  sourceAnalysis,
  sourceUnavailable,
}: {
  before: string;
  after: string;
  lang: Lang;
  hash: number;
  working?: boolean;
  responsive?: boolean;
  beforeLabel?: string;
  afterLabel?: string;
} & ReturnType<typeof useRenderedDiff>) {
  const [variant, setVariant] = useState<'base' | 'enhanced'>();
  const markers = sourceAnalysis?.markers ?? [];
  const output = result.output;
  const enhanced =
    (variant ?? (output?.enhanced && !output.base ? 'enhanced' : 'base')) === 'enhanced';
  const shown = enhanced && result.enhanced ? result.enhanced : result;
  const summary = output
    ? output.base || output.enhanced
      ? `Text changed · ${output.base && output.enhanced ? 'Base and Enhanced' : output.base ? 'Base' : 'Enhanced'}`
      : 'Markup only: rendered text unchanged (Base and Enhanced)'
    : sourceUnavailable
      ? 'Rendered comparison check unavailable'
      : 'Checking Base and Enhanced rendering…';
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
        <p className={styles.summary} role="status">
          {summary}
        </p>
        <SourceChanges markers={markers} before={before} after={after} />
        {result.enhanced && (
          <div className={styles.variants} role="group" aria-label="Rendered variant">
            <button type="button" aria-pressed={!enhanced} onClick={() => setVariant('base')}>
              Base
            </button>
            <button type="button" aria-pressed={enhanced} onClick={() => setVariant('enhanced')}>
              Enhanced
            </button>
          </div>
        )}
        <Comparison
          key={`${before}:${after}:${enhanced}`}
          before={shown.before}
          after={shown.after}
          lang={lang}
          beforeLabel={beforeLabel ?? (working ? 'Saved' : 'Previous / live')}
          afterLabel={afterLabel ?? (working ? 'Unsaved' : 'Current')}
        />
        {sourceUnavailable && before !== after && <SourceFallback before={before} after={after} />}
        {(!before || !after) && (
          <p className={styles.missing}>
            {!before ? 'Previous: (not present)' : 'Current: (not present)'}
          </p>
        )}
      </div>
    </SkeletonBoundary>
  );
}
