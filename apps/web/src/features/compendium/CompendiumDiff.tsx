import { memo, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  diffCompendium,
  styleKey,
  type CompendiumCell,
  type CompendiumDiffPart,
} from '@clarity/core';
import { Multiline, RichCell, runStyle } from './RichCell';
import { SheetCell, useLegibleOn } from './sheetSurface';
import { useSettingsStore } from '../../stores/settings';
import { Segmented } from '../../ui/RightPane';
import styles from './Compendium.module.scss';

export type CompendiumDiffMode = 'changes' | 'before-after';
const diffModeOptions = [
  { value: 'changes', label: 'Changes' },
  { value: 'before-after', label: 'Before / After' },
] as const;

/** The diff view remembered on this device (Changes until the user picks Before / After). */
export function useCompendiumDiffMode(): [CompendiumDiffMode, (mode: CompendiumDiffMode) => void] {
  const mode = useSettingsStore((state) => state.device.remembered.compendiumDiff ?? 'changes');
  const remember = useSettingsStore((state) => state.remember);
  return [mode, (value) => remember({ compendiumDiff: value })];
}

/** Changes | Before / After. The Compendium pane puts it in its header; other callers get it inline. */
export function CompendiumDiffModeToggle({
  mode,
  onChange,
}: {
  mode: CompendiumDiffMode;
  onChange(mode: CompendiumDiffMode): void;
}) {
  return (
    <Segmented
      label="Compendium diff view"
      value={mode}
      options={diffModeOptions}
      onChange={onChange}
    />
  );
}

function changes(before: CompendiumCell, after: CompendiumCell): string[] {
  const values = (
    cell: CompendiumCell,
    key: 'color' | 'bold' | 'italic' | 'underline' | 'strike' | 'sizePt' | 'href' | 'textAlign',
  ) =>
    [
      ...new Set(
        cell.runs.map((run) =>
          String(
            run[key] ??
              (key === 'sizePt'
                ? 'default'
                : key === 'color'
                  ? 'default'
                  : key === 'textAlign'
                    ? 'inherited'
                    : false),
          ),
        ),
      ),
    ].join(', ');
  return (
    ['color', 'bold', 'italic', 'underline', 'strike', 'sizePt', 'href', 'textAlign'] as const
  ).flatMap((key) => {
    const old = values(before, key);
    const current = values(after, key);
    return old === current
      ? []
      : [
          `${key === 'color' ? 'colour' : key === 'textAlign' ? 'alignment' : key}: ${old} \u2192 ${current}`,
        ];
  });
}
const StyleChange = memo(function StyleChange({
  before,
  after,
}: {
  before: CompendiumCell;
  after: CompendiumCell;
}) {
  const legibleOn = useLegibleOn();
  const singleRun = after.runs.length === 1 ? after.runs[0] : undefined;
  const [open, setOpen] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [offset, setOffset] = useState(0);
  const anchor = useRef<HTMLSpanElement>(null);
  const popover = useRef<HTMLSpanElement>(null);
  const visible = open || hovered || focused;
  const id = useId();
  const description = changes(before, after).join('; ') || 'Styling changed within this word';
  useLayoutEffect(() => {
    if (!visible) return;
    const position = () => {
      if (!anchor.current || !popover.current) return;
      const left = anchor.current.getBoundingClientRect().left;
      const width = popover.current.getBoundingClientRect().width;
      const limit = document.documentElement.clientWidth - width - 8;
      setOffset(Math.max(8, Math.min(left, limit)) - left);
    };
    position();
    window.addEventListener('resize', position);
    window.addEventListener('scroll', position, true);
    return () => {
      window.removeEventListener('resize', position);
      window.removeEventListener('scroll', position, true);
    };
  }, [visible]);
  return (
    <span
      ref={anchor}
      className={styles.styleChange}
      data-open={visible}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) {
          setFocused(false);
          setOpen(false);
        }
      }}
    >
      <button
        type="button"
        className={styles.styleToggle}
        style={singleRun ? runStyle(singleRun, legibleOn) : undefined}
        title={description}
        aria-label={`${after.plain}: ${description}`}
        aria-describedby={id}
        aria-expanded={visible}
        onClick={() => {
          setOpen(!open);
          setHovered(false);
          setFocused(false);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            setOpen(false);
            setHovered(false);
            setFocused(false);
          }
        }}
      >
        {singleRun ? singleRun.text : <RichCell cell={after} links={false} inline />}
      </button>
      <span
        ref={popover}
        id={id}
        className={styles.stylePopover}
        role="tooltip"
        style={{ insetInlineStart: offset }}
      >
        {visible ? (
          <>
            <span>{description}</span>
            <span className={styles.swatches}>
              {[before, after].map((cell, index) => (
                <span key={index}>
                  {index ? 'Current' : 'Snapshot'}{' '}
                  {[...new Set(cell.runs.map((run) => run.color).filter(Boolean))].map((color) => (
                    <span
                      key={color}
                      className={styles.swatch}
                      style={{ backgroundColor: color }}
                      title={color}
                    />
                  ))}
                </span>
              ))}
            </span>
            <span>
              Snapshot: <RichCell cell={before} />
            </span>
          </>
        ) : (
          // Retain the full accessible description while CSS hides the popup.
          // Its formatting and swatches are built synchronously on any open path.
          `${description}Snapshot Current Snapshot: ${before.plain}`
        )}
      </span>
    </span>
  );
});
export function CompendiumDiff({
  before,
  after,
  mode: given,
}: {
  before: CompendiumCell;
  after: CompendiumCell;
  /** The view, when the caller shows the toggle itself; without it the diff brings its own. */
  mode?: CompendiumDiffMode;
}) {
  const [remembered, setRemembered] = useCompendiumDiffMode();
  const mode = given ?? remembered;
  const sideBySide = mode === 'before-after';
  // Links store no background; both sides sit on the row's current one.
  const background = after.background ?? before.background;
  const lines = useMemo(
    () => (sideBySide ? [] : preparedLines(before, after)),
    [before, after, sideBySide],
  );
  return (
    <section aria-label="Styled Compendium diff">
      {given === undefined && (
        <div className={styles.diffModes}>
          <CompendiumDiffModeToggle mode={mode} onChange={setRemembered} />
        </div>
      )}
      {sideBySide ? (
        <div className={styles.comparison}>
          <section>
            <h4>Snapshot</h4>
            <SheetCell background={background}>
              <RichCell cell={before} />
            </SheetCell>
          </section>
          <section>
            <h4>Current</h4>
            <SheetCell background={background}>
              <RichCell cell={after} />
            </SheetCell>
          </section>
        </div>
      ) : (
        <>
          <p className={styles.legend}>
            Removed: red strike-through. Added: green underline. Dotted: tap or hover for style
            changes.
          </p>
          <SheetCell background={background}>
            <Multiline>
              {lines.map((line, lineIndex) => (
                <span
                  key={lineIndex}
                  className={styles.diffLine}
                  style={{
                    textAlign: (
                      line.find((part) => part.after?.plain.trim())?.after ??
                      line.find((part) => part.before?.plain.trim())?.before
                    )?.runs[0]?.textAlign,
                  }}
                >
                  {line.map((part, index) =>
                    part.kind === 'style' ? (
                      <StyleChange key={index} before={part.before!} after={part.after!} />
                    ) : part.kind === 'removed' ? (
                      <del key={index} className={styles.removed}>
                        <RichCell cell={part.before!} inline />
                      </del>
                    ) : part.kind === 'added' ? (
                      <ins key={index} className={styles.added}>
                        <RichCell cell={part.after!} inline />
                      </ins>
                    ) : (
                      <RichCell key={index} cell={part.after!} inline />
                    ),
                  )}
                </span>
              ))}
            </Multiline>
          </SheetCell>
        </>
      )}
    </section>
  );
}

// Base/enhanced tooltips and return navigation can compare the same immutable
// source content in different cell objects. Keep a small, content-keyed cache.
const lineCache = new Map<string, CompendiumDiffPart[][]>();
function preparedLines(before: CompendiumCell, after: CompendiumCell) {
  const key = JSON.stringify([before, after]);
  const cached = lineCache.get(key);
  if (cached) return cached;
  const lines = diffLines(diffCompendium(before, after));
  if (lineCache.size >= 32) lineCache.delete(lineCache.keys().next().value!);
  lineCache.set(key, lines);
  return lines;
}

// Split fragments at line breaks before laying them out; each highlighted word
// remains inline within its source line, including for mixed-alignment selections.
function diffLines(parts: CompendiumDiffPart[]): CompendiumDiffPart[][] {
  const lines: CompendiumDiffPart[][] = [[]];
  let previousKey: string | undefined;
  for (const part of parts) {
    const source = part.after ?? part.before!;
    let offset = 0;
    source.plain.split(/(?<=\n)/).forEach((text) => {
      const slice = (cell: CompendiumCell): CompendiumCell => {
        let position = 0;
        return {
          plain: text,
          runs: cell.runs.flatMap((run) => {
            const start = Math.max(0, offset - position);
            const end = Math.min(run.text.length, offset + text.length - position);
            position += run.text.length;
            return end > start ? [{ ...run, text: run.text.slice(start, end) }] : [];
          }),
        };
      };
      const fragment: CompendiumDiffPart = {
        kind: part.kind,
        ...(part.before ? { before: slice(part.before) } : {}),
        ...(part.after ? { after: slice(part.after) } : {}),
      };
      // Coalesce plain, identically styled neighbours instead of rendering one
      // RichCell and highlight wrapper per word. Links and style-change controls
      // keep their individual targets, and alignment never crosses a line break.
      const cells = [fragment.before, fragment.after].filter((cell) => cell !== undefined);
      const key =
        part.kind !== 'style' && cells.every((cell) => cell.runs.length === 1 && !cell.runs[0].href)
          ? JSON.stringify([part.kind, ...cells.map((cell) => styleKey(cell.runs[0]))])
          : undefined;
      const line = lines.at(-1)!;
      const previous = line.at(-1);
      if (key !== undefined && key === previousKey && previous) {
        for (const side of ['before', 'after'] as const) {
          if (previous[side] && fragment[side]) {
            previous[side].plain += fragment[side].plain;
            previous[side].runs[0].text += fragment[side].plain;
          }
        }
      } else line.push(fragment);
      previousKey = key;
      offset += text.length;
      if (text.endsWith('\n')) {
        lines.push([]);
        previousKey = undefined;
      }
    });
  }
  return lines;
}
