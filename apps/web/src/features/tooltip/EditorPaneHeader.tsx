import { useLayoutEffect, useRef, useState } from 'react';
import { languages, langSchema, type Lang } from '@clarity/core';
import { languageLabel } from '../../languageLabels';
import { Popover } from '../../ui/Popover';
import { scaledPx } from '../../ui/scale';
import { GroupedPerks, groupedLabel, groupedTitle } from './GroupedPerks';
import { EnhancedArrow } from '../../ui/EnhancedArrow';
import { phoneQuery, useMedia } from '../../ui/useMedia';
import { DiscardConfirm, EditorMore, PhoneTools, type QueueBack, type ToolId } from './EditorMore';
import type { GroupedPerk } from './grouping';
import { editLabel, type OverrideTarget } from './variants';
import styles from './TooltipPage.module.scss';
import { MarksControl, useMarksShown } from '../marks/MarksControl';
import { useMarksStore } from '../marks/store';

/** "Read-only: sign in to edit." -> "Read-only". */
export const shortReason = (reason: string) => reason.split(':')[0].trim();

/**
 * The 28px header above the editor: language, draft state, read-only reason, and the actions for
 * the enhanced version ("Edit enhanced" where it keeps text of its own), and for maintainers the
 * items and perk effects that share this entry. Everything is one line; flexible text ellipsises.
 */
export function EditorPaneHeader({
  lang,
  onLanguage,
  draft,
  saving,
  onDiscard,
  reason,
  switchTo,
  onSwitch,
  overrides,
  activeOverride,
  onEditOverride,
  onBack,
  grouped,
  markup,
  queue,
  queueBack,
  draftLoader,
  destination,
  worklistControl,
  inactiveControl,
  inactiveMenuControl,
  inactiveHash,
  markHash,
  reserveDraft = false,
}: {
  lang: Lang;
  onLanguage(lang: Lang): void;
  /** Whether the text being edited has an unsaved draft. */
  draft: boolean;
  saving: boolean;
  onDiscard(): void;
  /** Why the editor is read-only; null when it is editable. */
  reason: string | null;
  switchTo?: Lang;
  onSwitch(lang: Lang): void;
  overrides: OverrideTarget[];
  activeOverride: OverrideTarget | undefined;
  onEditOverride(hash: number): void;
  onBack(): void;
  /** Maintainers only: what shares this entry; undefined hides the control. */
  grouped?: GroupedPerk[];
  /** Shows and hides the markup row; undefined where the text is read-only. */
  markup?: { open: boolean; toggle(): void };
  /** Queue mode only: position, Previous, Next, and the way back to the Translations queue. */
  queue?: React.ReactNode;
  /** Queue mode only: the way back to the queue, for the phone's More sheet. */
  queueBack?: QueueBack;
  /** "Load draft…" for an empty tooltip with an agent-written draft (editors and maintainers). */
  draftLoader?: React.ReactNode;
  /** Scheduled changes: the badge naming the open batch this tooltip is in. */
  destination?: React.ReactNode;
  /** Maintainer-only inactive move, with its own deliberate confirmation. */
  inactiveControl?: React.ReactNode;
  /** The same action with its words, for More when the desktop line has no room for it. */
  inactiveMenuControl?: React.ReactNode;
  worklistControl?: React.ReactNode;
  /** Undefined on batch visits, where global move actions are unavailable. */
  inactiveHash?: number;
  markHash?: number;
  reserveDraft?: boolean;
}) {
  const phone = useMedia(phoneQuery);
  if (phone)
    return (
      <PhoneToolRow
        {...{ lang, onLanguage, draft, saving, onDiscard, reason, switchTo, onSwitch }}
        {...{
          overrides,
          activeOverride,
          onEditOverride,
          onBack,
          grouped,
          markup,
          queue,
          queueBack,
          draftLoader,
          destination,
          worklistControl,
          inactiveControl,
          inactiveHash,
          markHash,
          reserveDraft,
        }}
      />
    );
  return (
    <DesktopToolRow
      {...{ lang, onLanguage, draft, saving, onDiscard, reason, switchTo, onSwitch }}
      {...{
        overrides,
        activeOverride,
        onEditOverride,
        onBack,
        grouped,
        markup,
        queue,
        queueBack,
        draftLoader,
        destination,
        worklistControl,
        inactiveControl,
        inactiveMenuControl,
        inactiveHash,
        markHash,
        reserveDraft,
      }}
    />
  );
}

/**
 * The desktop tools More can take, in the order they go there (the rarest first). "marksLabels" is
 * a step, not a tool: the marks' names become a count ("Marks (2)") on the line.
 */
export const spillOrder = [
  'grouped',
  'inactive',
  'worklist',
  'marksLabels',
  'overrides',
  'marks',
] as const;
export type SpillTool = (typeof spillOrder)[number];
/** How many of the line's spare tools sit in More, and whether the line still wraps. */
export interface RowFit {
  moved: number;
  wrap: boolean;
}

/**
 * How the desktop tool line holds its tools, from widths that do not depend on the answer:
 * `need` is the line as laid out now (shrinkable text at its minimum) with `moved` tools in More,
 * `widths` each spare tool's inline width with its gap (in spill order), `more` More's own width
 * with its gap. As few tools go to More as the line needs, one at a time in spill order; a line
 * that still does not fit wraps as a last resort, so every action stays reachable. A tool comes
 * back only with a pixel to spare: scrollWidth rounds, so at an exact fit the two layouts could
 * each ask for the other forever. The first `inPlace` entries only shorten the line: no More.
 */
export function nextFit(
  need: number,
  room: number,
  widths: readonly number[],
  moved: number,
  more: number,
  inPlace = 0,
): RowFit {
  const sum = (count: number) => widths.slice(0, count).reduce((total, width) => total + width, 0);
  const moreAt = (count: number) => (count > inPlace ? more : 0);
  // The line with every tool inline: what is in More now comes back, More itself goes.
  const all = need + sum(moved) - moreAt(moved);
  for (let count = 0; count <= widths.length; count++)
    if (all - sum(count) + moreAt(count) <= room + (count < moved ? -0.5 : 0.5))
      return { moved: count, wrap: false };
  return { moved: widths.length, wrap: true };
}

/**
 * What a shrinkable item asks of the line: its min-width, except an item holding a button (the
 * read-only badge with "Switch to …"), which asks its whole width. Its short label ("Read-only")
 * outranks the spare tools, which go to More before it would ellipsise; it ellipsises only
 * once they are all there.
 */
function shrunkWidth(item: HTMLElement, style: CSSStyleDeclaration) {
  const min = parseFloat(style.minWidth) || 0;
  if (!item.querySelector('button')) return min;
  let width =
    (parseFloat(style.paddingLeft) || 0) +
    (parseFloat(style.paddingRight) || 0) +
    (parseFloat(style.borderLeftWidth) || 0) +
    (parseFloat(style.borderRightWidth) || 0) -
    (parseFloat(style.columnGap) || 0);
  for (const part of item.children)
    width +=
      Math.max(part.getBoundingClientRect().width, part.scrollWidth) +
      (parseFloat(style.columnGap) || 0);
  return Math.max(min, width);
}

/**
 * The line's width as laid out now: each item at its width, shrinkable text (the batch badge, the
 * override tag, the read-only badge) at its minimum, the right-hand group at its content width.
 */
function lineNeed(header: HTMLElement, right: HTMLElement) {
  const gap = parseFloat(getComputedStyle(header).columnGap) || 0;
  let need = -gap;
  for (const child of header.children as HTMLCollectionOf<HTMLElement>) {
    const style = getComputedStyle(child);
    // Queue mode's control has a row of its own on a narrow line (its order says so).
    if (style.position === 'absolute' || Number(style.order) > 0) continue;
    let width: number;
    if (child === right) width = Math.max(child.getBoundingClientRect().width, child.scrollWidth);
    // Counted even while hidden (the batch badge hides itself when it cannot fit), so the answer
    // never feeds back into the next measurement.
    else if (parseFloat(style.flexShrink) > 0) width = shrunkWidth(child, style);
    else {
      width = style.display === 'none' ? 0 : child.getBoundingClientRect().width;
      if (!width) continue;
    }
    need += width + gap;
  }
  return need;
}

/**
 * The desktop line's fit. Measured when the line or any item in it resizes, when items come or go
 * (a draft's Discard, the batch badge), and after a change of what the line holds; never per
 * keystroke. The width of the tools in More is remembered from the last time they were inline.
 */
function useRowFit(
  right: React.RefObject<HTMLSpanElement>,
  tools: readonly SpillTool[],
  key: string,
  /** The marks' names: other marks are measured again. */
  marksKey: string,
) {
  const [fit, setFit] = useState<RowFit>({ moved: 0, wrap: false });
  const fitRef = useRef(fit);
  fitRef.current = fit;
  const toolsRef = useRef(tools);
  toolsRef.current = tools;
  // Kept in rem, so a new interface scale does not leave a stale width.
  const widths = useRef<Partial<Record<SpillTool, number>>>({});
  const more = useRef(0);
  const measure = useRef(() => {});
  measure.current = () => {
    const element = right.current;
    const header = element?.parentElement;
    if (!element || !header) return;
    const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
    const gap = parseFloat(getComputedStyle(element).columnGap) || 0;
    for (const tool of element.querySelectorAll<HTMLElement>(':scope > [data-spill]'))
      widths.current[tool.dataset.spill as SpillTool] =
        (tool.getBoundingClientRect().width + gap) / rem;
    const { moved } = fitRef.current;
    const inPlace = toolsRef.current[0] === 'marksLabels' ? 1 : 0;
    const trigger = moved > inPlace ? (element.lastElementChild as HTMLElement | null) : null;
    if (trigger) more.current = (trigger.getBoundingClientRect().width + gap) / rem;
    const box = getComputedStyle(header);
    const room =
      header.clientWidth - (parseFloat(box.paddingLeft) || 0) - (parseFloat(box.paddingRight) || 0);
    const next = nextFit(
      lineNeed(header, element),
      room,
      // A tool never seen inline yet (none: every tool starts inline) counts as nothing.
      toolsRef.current.map((tool) => {
        const width = widths.current[tool] ?? 0;
        if (tool !== 'marksLabels') return width * rem;
        // The names only become the count: about as wide as "Marks (2)" until that was seen.
        return Math.max(0, width - (widths.current.marks ?? 4.5)) * rem;
      }),
      Math.min(moved, toolsRef.current.length),
      (more.current || 1.5 + gap / rem) * rem,
      inPlace,
    );
    if (next.moved !== fitRef.current.moved || next.wrap !== fitRef.current.wrap) {
      fitRef.current = next;
      setFit(next);
    }
  };
  // What the line holds changed: measure before paint, so it never shows a clipped frame.
  useLayoutEffect(() => {
    delete widths.current.marksLabels;
  }, [marksKey]);
  useLayoutEffect(() => measure.current(), [key, marksKey]);
  useLayoutEffect(() => {
    const header = right.current?.parentElement;
    if (!header || typeof ResizeObserver !== 'function') return;
    const sizes = new ResizeObserver(() => measure.current());
    const observe = () => {
      sizes.disconnect();
      sizes.observe(header);
      for (const child of header.children) sizes.observe(child);
      for (const tool of right.current?.children ?? []) sizes.observe(tool);
    };
    observe();
    const items = new MutationObserver(() => {
      observe();
      measure.current();
    });
    items.observe(header, { childList: true });
    if (right.current) items.observe(right.current, { childList: true });
    return () => {
      sizes.disconnect();
      items.disconnect();
    };
  }, [right]);
  return fit;
}

function DesktopToolRow({
  lang,
  onLanguage,
  draft,
  saving,
  onDiscard,
  reason,
  switchTo,
  onSwitch,
  overrides,
  activeOverride,
  onEditOverride,
  onBack,
  grouped,
  markup,
  queue,
  draftLoader,
  destination,
  worklistControl,
  inactiveControl,
  inactiveMenuControl,
  inactiveHash,
  markHash,
  reserveDraft: reserve = false,
}: Parameters<typeof EditorPaneHeader>[0]) {
  // With a version open the line is at its fullest: the first edit must not move the text.
  const reserveDraft = reserve || (!!activeOverride && !reason);
  const marksShown = useMarksShown(markHash);
  const marked = useMarksStore((state) => (markHash ? state.index.get(markHash) : undefined));
  const marksKey = marked?.map((mark) => mark.label).join('|') ?? '';
  const right = useRef<HTMLSpanElement>(null);
  const present: Record<SpillTool, boolean> = {
    grouped: !!grouped,
    inactive: !!inactiveControl,
    worklist: !!worklistControl,
    // Beside an open version the marks are always a count.
    marksLabels: marksShown && !!marksKey && !activeOverride,
    // Edit enhanced goes last; an open override's Back to base always stays on the line.
    overrides: !activeOverride && overrides.length > 0,
    marks: marksShown,
  };
  const tools = spillOrder.filter((tool) => present[tool]);
  const fit = useRowFit(
    right,
    tools,
    [
      draft,
      reserveDraft,
      lang,
      reason,
      switchTo,
      activeOverride?.hash,
      overrides.length,
      grouped?.length,
      Boolean(queue),
      Boolean(draftLoader),
      Boolean(markup),
      Boolean(worklistControl),
      Boolean(inactiveControl),
      marksShown,
    ].join('|'),
    marksKey,
  );
  const inMore = new Set(tools.slice(0, fit.moved));
  const marksCount = inMore.delete('marksLabels') || !!activeOverride;
  const groupedControl = grouped && (
    <Popover
      label={groupedLabel}
      width={scaledPx(640)}
      triggerLabel={`Grouped ${grouped.length}: ${groupedLabel.toLowerCase()}`}
      className={styles.ghost}
      trigger={
        <>
          <span className={styles.groupedIcon} aria-hidden="true" />
          <span className={styles.groupedWord}>Grouped </span>
          {grouped.length}
        </>
      }
      triggerTitle={groupedTitle}
    >
      <GroupedPerks perks={grouped} currentHash={inactiveHash} />
    </Popover>
  );
  const marksControl = marksShown && markHash !== undefined && (
    <MarksControl hash={markHash} className={styles.ghost} compact={marksCount} />
  );
  const markupTools = markup && (
    <button
      type="button"
      className={styles.ghost}
      aria-pressed={markup.open}
      aria-keyshortcuts="Control+."
      title="Show or hide the markup row at the top of the editor"
      onClick={markup.toggle}
    >
      {/* One flex item: the button's gap must not land between the two words. */}
      <span>
        Markup<span className={styles.markupWord}> tools</span>
      </span>{' '}
      <kbd className={styles.key}>Ctrl+.</kbd>
    </button>
  );
  return (
    <>
      <LanguageSelect lang={lang} onLanguage={onLanguage} />
      {destination}
      {activeOverride && <OverrideTag target={activeOverride} several={overrides.length > 1} />}
      {!draft && !reserveDraft && (
        // Holds the place of the draft dot and Discard on a phone, where this row wraps, so the
        // first edit does not push the text down. It takes no space elsewhere.
        <span className={styles.draftSpacer} aria-hidden="true">
          <span className={styles.dot} />
          <span className={styles.ghost}>Discard</span>
        </span>
      )}
      {!draft && reserveDraft && (
        <>
          <span className={styles.dot} style={{ visibility: 'hidden' }} aria-hidden="true" />
          <span className={styles.ghost} style={{ visibility: 'hidden' }} aria-hidden="true">
            Discard
          </span>
        </>
      )}
      {draft && (
        <>
          <span
            className={styles.dot}
            role="img"
            aria-label="Unsaved draft"
            title="Unsaved draft"
          />
          <DiscardConfirm className={styles.ghost} saving={saving} onDiscard={onDiscard} />
        </>
      )}
      {draftLoader}
      {reason && (
        // The status bar under the editor says the whole sentence; the badge only names the state
        // (its tooltip has the sentence too), so the same words are not on screen twice.
        <span className={styles.badge} role="status" title={reason}>
          <span className={styles.ell}>{shortReason(reason)}</span>
          {switchTo && (
            <button type="button" className={styles.ghost} onClick={() => onSwitch(switchTo)}>
              Switch to {languageLabel(switchTo)}
            </button>
          )}
        </span>
      )}
      {markupTools}
      {queue}
      <span
        ref={right}
        className={styles.paneRight}
        data-tool-fit={inMore.size ? 'spill' : 'full'}
        data-wrap={fit.wrap || undefined}
      >
        {worklistControl && !inMore.has('worklist') && (
          <span data-spill="worklist">{worklistControl}</span>
        )}
        {marksControl && !inMore.has('marks') && (
          <span data-spill={marksCount || !marksKey ? 'marks' : 'marksLabels'}>{marksControl}</span>
        )}
        {inactiveControl && !inMore.has('inactive') && (
          <span data-spill="inactive">{inactiveControl}</span>
        )}
        {groupedControl && !inMore.has('grouped') && (
          <span data-spill="grouped">{groupedControl}</span>
        )}
        {activeOverride ? (
          <BackToBase onBack={onBack} />
        ) : (
          overrides.length > 0 &&
          !inMore.has('overrides') && (
            <span data-spill="overrides">
              {overrides.map((target) => (
                <button
                  key={target.hash}
                  type="button"
                  className={styles.ghost}
                  onClick={() => onEditOverride(target.hash)}
                >
                  {editLabel(target, overrides.length > 1)}
                </button>
              ))}
            </span>
          )
        )}
        {inMore.size > 0 && (
          // The tools that did not fit, in the phone's More (same rows, same handlers).
          <EditorMore
            draft={false}
            saving={saving}
            onDiscard={onDiscard}
            grouped={grouped}
            overrides={inMore.has('overrides') ? overrides : []}
            onEditOverride={onEditOverride}
            renderGrouped={(perks) => <GroupedPerks perks={perks} currentHash={inactiveHash} />}
            rows={
              new Set<ToolId>([
                ...(inMore.has('grouped') ? (['grouped'] as const) : []),
                ...(inMore.has('overrides')
                  ? overrides.map((target) => `override:${target.hash}` as const)
                  : []),
              ])
            }
            extra={
              inMore.has('worklist') || inMore.has('inactive') || inMore.has('marks') ? (
                <>
                  {inMore.has('marks') && marksControl}
                  {inMore.has('worklist') && worklistControl}
                  {inMore.has('inactive') && (inactiveMenuControl || inactiveControl)}
                </>
              ) : undefined
            }
          />
        )}
      </span>
    </>
  );
}

/** Which version the editor holds while one with text of its own is open. */
function OverrideTag({ target, several }: { target: OverrideTarget; several: boolean }) {
  if (!target.enhanced)
    return (
      <span className={styles.overrideTag} data-plain title={`Separate text: ${target.name}`}>
        <span className={styles.ell}>{target.name}</span>
      </span>
    );
  const name = several ? `: ${target.name}` : '';
  return (
    <span className={styles.overrideTag} title={`Enhanced version${name}`}>
      <EnhancedArrow />
      <span className={styles.ell}>Enhanced{name}</span>
    </span>
  );
}

/** "Back to base"; "Back" where the line has no room for the rest. */
function BackToBase({ onBack }: { onBack(): void }) {
  return (
    <button type="button" className={styles.ghost} aria-label="Back to base" onClick={onBack}>
      {/* One flex item: the button's gap must not land between the words. */}
      <span>
        Back<span className={styles.backWords}> to base</span>
      </span>
    </button>
  );
}

function LanguageSelect({ lang, onLanguage }: { lang: Lang; onLanguage(lang: Lang): void }) {
  return (
    <select
      className={styles.langSelect}
      aria-label="Language"
      value={lang}
      onChange={(event) => onLanguage(langSchema.parse(event.target.value))}
    >
      {languages.map((language) => (
        <option key={language} value={language}>
          {languageLabel(language)}
        </option>
      ))}
    </select>
  );
}

/**
 * The phone's tool row: language, the draft dot, the tools that fit inline, then the queue stepper
 * and More (only for two or more tools that do not fit) as one group on the right (it wraps to a
 * second line as a unit at a large interface scale). The read-only badge takes a second line of its
 * own. An open override shares the first (its tag and Back take the marks' place, and the tools that
 * no longer fit go to More), so opening it does not move the text.
 */
function PhoneToolRow({
  lang,
  onLanguage,
  draft,
  saving,
  onDiscard,
  reason,
  switchTo,
  onSwitch,
  overrides,
  activeOverride,
  onEditOverride,
  onBack,
  grouped,
  markup,
  queue,
  queueBack,
  draftLoader,
  destination,
  worklistControl,
  inactiveControl,
  inactiveHash,
  markHash,
  reserveDraft: reserve = false,
}: Parameters<typeof EditorPaneHeader>[0]) {
  const reserveDraft = reserve || (!!activeOverride && !reason);
  const marksShown = useMarksShown(markHash);
  const marksControl = marksShown && markHash !== undefined && (
    <MarksControl hash={markHash} className={styles.ghost} compact />
  );
  return (
    <>
      <LanguageSelect lang={lang} onLanguage={onLanguage} />
      {destination}
      {activeOverride ? (
        <>
          <OverrideTag target={activeOverride} several={overrides.length > 1} />
          <BackToBase onBack={onBack} />
        </>
      ) : (
        marksControl
      )}
      {draft && (
        <span className={styles.dot} role="img" aria-label="Unsaved draft" title="Unsaved draft" />
      )}
      {!draft && reserveDraft && (
        <span className={styles.dot} style={{ visibility: 'hidden' }} aria-hidden="true" />
      )}
      {draftLoader}
      <PhoneTools
        // The tools fit the room left of them: they measure again when the draft button comes or goes.
        key={draftLoader ? 'after-draft' : 'tools'}
        markup={markup}
        draft={draft}
        reserveDraft={reserveDraft}
        saving={saving}
        onDiscard={onDiscard}
        grouped={grouped}
        overrides={activeOverride ? [] : overrides}
        onEditOverride={onEditOverride}
        queueBack={queueBack}
        queue={queue}
        renderGrouped={(perks) => <GroupedPerks perks={perks} currentHash={inactiveHash} />}
        extra={
          worklistControl || inactiveControl || (activeOverride && marksControl) ? (
            <>
              {activeOverride && marksControl}
              {worklistControl}
              {inactiveControl}
            </>
          ) : undefined
        }
      />
      {reason && (
        <span className={styles.badge} role="status" title={reason}>
          <span className={styles.ell}>{shortReason(reason)}</span>
          {switchTo && (
            <button type="button" className={styles.ghost} onClick={() => onSwitch(switchTo)}>
              Switch to {languageLabel(switchTo)}
            </button>
          )}
        </span>
      )}
    </>
  );
}
