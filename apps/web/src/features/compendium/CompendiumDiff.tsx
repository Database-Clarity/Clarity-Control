import { memo, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CompendiumCell } from '@clarity/core';
import { preparedLines } from './compendiumDiffCache';
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
  disabled,
}: {
  mode: CompendiumDiffMode;
  onChange(mode: CompendiumDiffMode): void;
  disabled?: boolean;
}) {
  return (
    <Segmented
      label="Compendium diff view"
      value={mode}
      options={diffModeOptions}
      onChange={onChange}
      disabled={disabled}
    />
  );
}

/** Mount positioning state and listeners only for the popup the user opens. */
function StylePopover({
  id,
  description,
  before,
  after,
}: {
  id: string;
  description: string;
  before: CompendiumCell;
  after: CompendiumCell;
}) {
  const [offset, setOffset] = useState(0);
  const popover = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const position = () => {
      const element = popover.current;
      const anchor = element?.parentElement;
      if (!element || !anchor) return;
      const left = anchor.getBoundingClientRect().left;
      const width = element.getBoundingClientRect().width;
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
  }, [before, after]);
  return (
    <span
      ref={popover}
      id={id}
      className={styles.stylePopover}
      role="tooltip"
      style={{ insetInlineStart: offset }}
    >
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
    </span>
  );
}

const StyleChange = memo(function StyleChange({
  before,
  after,
  description,
}: {
  before: CompendiumCell;
  after: CompendiumCell;
  description: string;
}) {
  const legibleOn = useLegibleOn();
  const singleRun = after.runs.length === 1 ? after.runs[0] : undefined;
  const [open, setOpen] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const visible = open || hovered || focused;
  const id = useId();
  return (
    <span
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
      {visible ? (
        <StylePopover id={id} description={description} before={before} after={after} />
      ) : (
        <span
          id={id}
          className={styles.stylePopover}
          role="tooltip"
          style={{ insetInlineStart: 0 }}
        >
          {/* Retain the full accessible description while the popup is hidden. */}
          {`${description}Snapshot Current Snapshot: ${before.plain}`}
        </span>
      )}
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
                      <StyleChange
                        key={index}
                        before={part.before!}
                        after={part.after!}
                        description={part.description!}
                      />
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
