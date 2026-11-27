import { LoadingSkeleton, useSkeletonVisible } from '../../ui/Skeleton';
import {
  memo,
  startTransition,
  useDeferredValue,
  useEffect,
  useMemo,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react';
import { parseMarkup, type Lang, type MarkupGlobals, type MarkupSpan } from '@clarity/core';
import { compareRenders, type CompareLine, type Comparison } from './compare';
import { classNames, Lines, PreviewSpan, TooltipPreview } from './TooltipPreview';
import { renderWrappedParts, TitleAnchor } from './MarkupRenderer';
import styles from './PreviewColumn.module.scss';
import previewStyles from './TooltipPreview.module.scss';
import { Segmented } from '../../ui/RightPane';

import type { PreviewMode } from './previewMode';

/** One enhanced version the column can show next to the base. */
export interface EnhancedView {
  hash: number;
  name: string;
  text: string;
  globals: MarkupGlobals;
  /** Derived versions are the base text read as the enhanced type: seeing one is seeing the base. */
  derived: boolean;
}

/**
 * The version picker's labels: names, except that versions sharing one (a member taken out of its
 * group keeps its name) say whether they read the base's text or their own, with the hash if that
 * is shared too.
 */
export function versionLabels(
  enhanced: readonly Pick<EnhancedView, 'hash' | 'name' | 'derived'>[],
): string[] {
  const shared = (list: readonly string[], label: string) =>
    list.indexOf(label) !== list.lastIndexOf(label);
  const names = enhanced.map(({ name }) => name);
  const labels = enhanced.map(({ name, derived }) => {
    if (!shared(names, name)) return name;
    return derived ? 'Base text' : 'Own text';
  });
  return labels.map((label, index) =>
    shared(labels, label) ? `${label} ${enhanced[index].hash}` : label,
  );
}

export interface PreviewColumnProps {
  hash: number;
  lang: Lang;
  name: string;
  /** Exotic armour: the piece carrying this perk, shown above the perk's name. */
  piece?: string;
  /** The piece's icon beside the piece row. */
  pieceIcon?: string;
  icon?: string;
  categoryLabel?: string;
  archiveIcon?: boolean;
  baseText: string;
  baseGlobals: MarkupGlobals;
  enhanced: EnhancedView[];
  /** The view in effect (`effectiveMode`); items without an enhanced version are always Base. */
  mode: PreviewMode;
  onMode(mode: PreviewMode): void;
  /** Which enhanced version is shown, when there are several. */
  variant: number | undefined;
  onVariant(hash: number): void;
  /** Effects that acknowledge the current text, after its deferred render commits. */
  acknowledgement?: ReactNode;
  /** Keep document parsing behind the urgent editor/header render during stepping. */
  stepping?: boolean;
  /** The current document committed and had an opportunity to paint. */
  onDocumentPaint?(hash: number): void;
  pendingDocument?: boolean;
  loadingContent?: boolean;
  /**
   * Scheduled changes: the Current / Upcoming switch, drawn above the preview at once (never
   * deferred with the document). The page switches what the text props render; this only shows it.
   */
  source?: ReactNode;
}

const labels: Record<PreviewMode, string> = {
  base: 'Base',
  enhanced: 'Enhanced',
  compare: 'Compare',
};

/**
 * The preview column: ONE perk header, then Base | Enhanced | Compare (the last two dimmed when the
 * item has no enhanced version), then one body. Base and Enhanced are the renders a consumer sees; Compare is
 * a working view of the two, so only Base and Enhanced ever count as "previewed".
 */
export function PreviewColumn(props: PreviewColumnProps) {
  const [settled, setSettled] = useState(props);
  const changedDocument = settled.hash !== props.hash || settled.lang !== props.lang;
  // A route change starts with the correct document immediately. Live edits wait
  // for a short input pause, so skipped text snapshots never parse or relayout.
  if (changedDocument && !props.stepping) setSettled(props);
  useEffect(() => {
    if (settled === props) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settle = () => {
      timer = setTimeout(() => startTransition(() => setSettled(props)), props.stepping ? 0 : 40);
    };
    // Paint the urgent editor and header before parsing the preview. New input
    // cancels this snapshot instead of queuing intermediate documents.
    const frame = props.stepping ? requestAnimationFrame(settle) : undefined;
    if (!props.stepping) settle();
    return () => {
      if (frame !== undefined) cancelAnimationFrame(frame);
      clearTimeout(timer);
    };
  }, [props, settled]);
  const deferred = useDeferredValue(settled);
  // A different document/language must never display the previous one's contents.
  // Same-document typing can let the editor paint before parsing its live preview.
  const content =
    props.stepping || (deferred.hash === props.hash && deferred.lang === props.lang)
      ? deferred
      : props;
  const pendingDocument = content.hash !== props.hash || content.lang !== props.lang;
  const onDocumentPaint = props.onDocumentPaint;
  useEffect(() => {
    if (pendingDocument || !onDocumentPaint) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const frame = requestAnimationFrame(() => {
      timer = setTimeout(() => onDocumentPaint(content.hash), 0);
    });
    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(timer);
    };
  }, [pendingDocument, content.hash, content.lang, onDocumentPaint]);
  return (
    <>
      {props.source}
      <PreviewColumnBody
        {...content}
        source={undefined}
        mode={content.hash === props.hash ? props.mode : content.mode}
        variant={content.hash === props.hash ? props.variant : content.variant}
        onMode={props.onMode}
        onVariant={props.onVariant}
        pendingDocument={pendingDocument}
      />
      {content === props && props.acknowledgement}
    </>
  );
}

const PreviewColumnBody = memo(function PreviewColumnBody({
  hash,
  lang,
  name,
  piece,
  pieceIcon,
  icon,
  categoryLabel,
  archiveIcon,
  baseText,
  baseGlobals,
  enhanced,
  mode,
  onMode,
  variant,
  onVariant,
  pendingDocument,
  loadingContent,
}: PreviewColumnProps) {
  // Held past `loadingContent` until a painted skeleton has had its minimum (ui/Skeleton rule).
  const skeletonShown = useSkeletonVisible(Boolean(loadingContent), hash, true);
  const selected = enhanced.find((entry) => entry.hash === variant) ?? enhanced[0];
  const effective: PreviewMode = selected ? mode : 'base';
  const selectedText = selected?.text;
  const selectedGlobals = selected?.globals;
  const comparison = useMemo<Comparison | undefined>(() => {
    if (selectedText === undefined || !selectedGlobals || effective !== 'compare') return undefined;
    return compareRenders(
      parseMarkup(baseText, baseGlobals).lines,
      parseMarkup(selectedText, selectedGlobals).lines,
    );
  }, [baseText, baseGlobals, selectedText, selectedGlobals, effective]);

  const shown = effective === 'enhanced' && selected ? selected : undefined;
  // "n changes" always; " vs Base" while the strip has room (a narrow column drops it).
  const summary =
    effective === 'compare' && comparison
      ? comparison.changes === 0
        ? { count: 'No changes', rest: ' vs Base' }
        : {
            count: `${comparison.changes} ${comparison.changes === 1 ? 'change' : 'changes'}`,
            rest: ' vs Base',
          }
      : undefined;

  // The row is always there, so stepping onto an item with no enhanced version moves nothing: the
  // views it lacks are dimmed, the chosen view is kept by the page and returns on the next item
  // that has one.
  const versions = versionLabels(enhanced);
  const bar = (
    <div className={styles.bar}>
      <VersionSwitch
        label="Preview version"
        value={effective}
        hasEnhanced={Boolean(selected)}
        onChange={onMode}
      />
      {selected && enhanced.length > 1 && (
        <select
          className={styles.versions}
          aria-label="Enhanced version"
          title={`${selected.name} · ${selected.hash}`}
          value={selected.hash}
          onChange={(event) => onVariant(Number(event.target.value))}
        >
          {versions.map((label, index) => (
            <option key={enhanced[index].hash} value={enhanced[index].hash}>
              {label}
            </option>
          ))}
        </select>
      )}
      <span className={styles.summary} aria-live="polite">
        {summary && (
          <>
            {summary.count}
            <span className={styles.vsBase}>{summary.rest}</span>
          </>
        )}
      </span>
    </div>
  );

  return (
    <section
      className={styles.column}
      aria-label={`${name} preview`}
      aria-busy={pendingDocument || undefined}
      data-tooltip-hash={hash}
    >
      <TooltipPreview
        text={shown ? shown.text : baseText}
        lang={lang}
        name={name}
        piece={piece}
        pieceIcon={pieceIcon}
        icon={icon}
        categoryLabel={[categoryLabel, hash].filter(Boolean).join(' · ')}
        globals={shown ? shown.globals : baseGlobals}
        archiveIcon={archiveIcon}
        tooltipHash={shown ? shown.hash : hash}
        bar={bar}
        fill
      >
        {loadingContent || skeletonShown ? (
          <LoadingSkeleton
            label="Loading preview text…"
            count={12}
            text={baseText || undefined}
            visible={skeletonShown}
          />
        ) : (
          comparison && (
            <div className={styles.compare} data-compare="">
              {comparison.lines.map((entry, index) => (
                <CompareRow key={index} entry={entry} />
              ))}
            </div>
          )
        )}
      </TooltipPreview>
    </section>
  );
});

/**
 * Base | Enhanced | Compare: the preview's version strip, also the translate-mode English pane's
 * (one control, one look). Without an enhanced version the last two stay, dimmed.
 */
export function VersionSwitch({
  label,
  value,
  hasEnhanced,
  onChange,
}: {
  label: string;
  value: PreviewMode;
  hasEnhanced: boolean;
  onChange(mode: PreviewMode): void;
}) {
  return (
    <Segmented
      className={styles.segmented}
      label={label}
      value={value}
      onChange={onChange}
      options={modes.map((mode) =>
        !hasEnhanced && mode !== 'base'
          ? { value: mode, label: labels[mode], disabled: true, wrap: noEnhancedHint }
          : { value: mode, label: labels[mode] },
      )}
    />
  );
}

const modes = ['base', 'enhanced', 'compare'] as const;
const noEnhancedHint = (button: ReactElement) => (
  <TitleAnchor
    part={{ title: [{ linesContent: [{ text: 'This item has no enhanced version' }] }] }}
  >
    {button}
  </TitleAnchor>
);

/** The Compare rows of a comparison (compare.ts), as the preview column draws them. */
export function CompareLines({ comparison }: { comparison: Comparison }) {
  return (
    <div className={styles.compare} data-compare="">
      {comparison.lines.map((entry, index) => (
        <CompareRow key={index} entry={entry} />
      ))}
    </div>
  );
}

interface ComparisonSpan extends MarkupSpan {
  compareClass?: string;
  compareArrow?: string;
}

function compareParts(parts: MarkupSpan[]) {
  return (parts as ComparisonSpan[]).map((part, index) =>
    part.compareArrow ? (
      <span
        key={index}
        className={previewStyles.enhancedArrow}
        role="img"
        aria-label={part.compareArrow}
      />
    ) : part.compareClass ? (
      <span key={index} className={part.compareClass}>
        <PreviewSpan part={part} />
      </span>
    ) : (
      <PreviewSpan key={index} part={part} />
    ),
  );
}

const CompareRow = memo(
  function CompareRow({ entry }: { entry: CompareLine }) {
    // Tables are retired from the markup row but still render in older text.
    if (entry.line.table) return <Lines lines={[entry.line]} />;
    if (entry.kind === 'changed' && entry.segments) {
      const parts = entry.segments.flatMap<ComparisonSpan>((segment) =>
        segment.kind === 'same'
          ? segment.spans
          : [
              ...segment.was.map((part) => ({ ...part, compareClass: previewStyles.was })),
              {
                classNames: ['enhancedArrow'],
                compareArrow: segment.was.length ? 'becomes' : 'enhanced',
              },
              ...segment.now.map((part) => ({ ...part, compareClass: previewStyles.now })),
            ],
      );
      return (
        <div className={classNames(entry.line.classNames)} data-kind="changed">
          {renderWrappedParts(parts, compareParts)}
        </div>
      );
    }
    const className = [
      classNames(entry.line.classNames),
      entry.kind === 'added' ? previewStyles.added : '',
      entry.kind === 'removed' ? previewStyles.removed : '',
    ]
      .filter(Boolean)
      .join(' ');
    return (
      <div className={className || undefined} data-kind={entry.kind}>
        {renderWrappedParts(entry.line.linesContent ?? [])}
      </div>
    );
  },
  (previous, next) =>
    previous.entry === next.entry || JSON.stringify(previous.entry) === JSON.stringify(next.entry),
);
