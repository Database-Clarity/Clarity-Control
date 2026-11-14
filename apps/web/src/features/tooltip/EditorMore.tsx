import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { Link } from 'react-router-dom';
import { Popover } from '../../ui/Popover';
import type { GroupedPerk } from './grouping';
import type { OverrideTarget } from './EditorPaneHeader';
import styles from './EditorMore.module.scss';

/** The way back from queue mode to its list (the phone's More sheet). */
export interface QueueBack {
  to: string;
  /** What the list shows ("German, all categories"; "Bungie drift"). */
  label: string;
  /** The row's words; "Back to queue" by default. */
  text?: string;
  /** History state for the list (its filters, selection, and scroll). */
  state?: unknown;
  onClick?(): void;
}

/**
 * Phones: the editor's rarely used tools in one bottom sheet, in place of the inline buttons the
 * desktop tool row keeps. Every row calls the same handler as the button it replaces. Rendered
 * only when it has at least one row.
 */
export function EditorMore({
  markup,
  draft,
  saving,
  onDiscard,
  grouped,
  overrides,
  onEditOverride,
  queueBack,
  renderGrouped,
  rows,
}: {
  /** The markup row toggle; undefined where the text is read-only. */
  markup?: { open: boolean; toggle(): void };
  draft: boolean;
  saving: boolean;
  onDiscard(): void;
  grouped?: GroupedPerk[];
  /** The enhanced overrides to open (empty while one is open: its way back stays in the row). */
  overrides: OverrideTarget[];
  onEditOverride(hash: number): void;
  /** Queue mode: the way back to the queue's list and what it shows. */
  queueBack?: QueueBack;
  renderGrouped(perks: GroupedPerk[]): React.ReactNode;
  /** The tools that overflowed the row (the rest are inline); undefined: every tool. */
  rows?: ReadonlySet<ToolId>;
}) {
  const [groupedOpen, setGroupedOpen] = useState(false);
  if (rows) {
    markup = rows.has('markup') ? markup : undefined;
    draft = draft && rows.has('discard');
    grouped = rows.has('grouped') ? grouped : undefined;
    overrides = overrides.filter((target) => rows.has(`override:${target.hash}`));
  }
  if (!markup && !draft && !grouped && !overrides.length && !queueBack) return null;
  return (
    <Popover
      label="Editor tools"
      className={styles.trigger}
      flush
      contain
      triggerLabel="More editor tools"
      triggerTitle="More editor tools"
      trigger={<span className={styles.dots} aria-hidden="true" />}
    >
      {(close) => (
        <div className={styles.sheet}>
          <header className={styles.head}>
            <strong>Editor tools</strong>
            <button
              type="button"
              className={styles.close}
              aria-label="Close Editor tools"
              onClick={() => close()}
            >
              ×
            </button>
          </header>
          <ul className={styles.rows}>
            {markup && (
              <li>
                <button
                  type="button"
                  aria-pressed={markup.open}
                  aria-keyshortcuts="Control+."
                  onClick={markup.toggle}
                >
                  <span>Markup bar</span>
                  <small>{markup.open ? 'On' : 'Off'}</small>
                </button>
              </li>
            )}
            {draft && (
              <DiscardRow
                saving={saving}
                onDiscard={() => {
                  onDiscard();
                  close();
                }}
              />
            )}
            {grouped && (
              <li>
                <button
                  type="button"
                  aria-expanded={groupedOpen}
                  title="Which manifest perks open this editor entry, and how each joined (maintainers)"
                  onClick={() => setGroupedOpen((value) => !value)}
                >
                  <span>Grouped manifest perks</span>
                  <small>
                    {grouped.length} <span aria-hidden="true">{groupedOpen ? '▾' : '›'}</span>
                  </small>
                </button>
                {groupedOpen && <div className={styles.nested}>{renderGrouped(grouped)}</div>}
              </li>
            )}
            {overrides.map((target) => (
              <li key={target.hash}>
                <button
                  type="button"
                  onClick={() => {
                    onEditOverride(target.hash);
                    close();
                  }}
                >
                  Edit override{overrides.length > 1 ? `: ${target.name}` : ''}
                </button>
              </li>
            ))}
            {queueBack && (
              <li>
                <Link
                  to={queueBack.to}
                  state={queueBack.state}
                  onClick={() => {
                    queueBack.onClick?.();
                    close(false);
                  }}
                >
                  <span>{queueBack.text ?? 'Back to queue'}</span>
                  <small title={queueBack.label}>{queueBack.label}</small>
                </Link>
              </li>
            )}
          </ul>
        </div>
      )}
    </Popover>
  );
}

/**
 * Discard asks first, in place (the Drafts list confirms in a dialog): the row becomes the question
 * with Discard and Cancel, focus on Cancel. It lives inside the sheet, so it resets when the sheet
 * closes.
 */
function DiscardRow({
  saving,
  onDiscard,
  asked = false,
  onCancel,
}: {
  saving: boolean;
  onDiscard(): void;
  /** Opened from the inline Discard: the question shows at once, and Cancel closes it. */
  asked?: boolean;
  onCancel?(): void;
}) {
  const [asking, setAsking] = useState(asked);
  const cancel = useRef<HTMLButtonElement>(null);
  const ask = useRef<HTMLButtonElement>(null);
  const was = useRef(false);
  useEffect(() => {
    if (asking) cancel.current?.focus();
    else if (was.current) ask.current?.focus();
    was.current = asking;
  }, [asking]);
  if (!asking)
    return (
      <li>
        <button
          ref={ask}
          type="button"
          data-danger
          disabled={saving}
          aria-label="Discard this tooltip's draft"
          onClick={() => setAsking(true)}
        >
          Discard draft
        </button>
      </li>
    );
  return (
    <li className={styles.confirm} role="group" aria-label="Discard this tooltip's draft?">
      <span>Discard this draft? Its unsaved changes are lost.</span>
      <span className={styles.confirmActions}>
        <button type="button" data-danger disabled={saving} onClick={onDiscard}>
          Discard
        </button>
        <button
          ref={cancel}
          type="button"
          data-autofocus
          onClick={() => (onCancel ? onCancel() : setAsking(false))}
        >
          Cancel
        </button>
      </span>
    </li>
  );
}

/** One tool of the phone tool row, inline or in More. */
export type ToolId = 'markup' | 'discard' | 'grouped' | `override:${number}`;

/**
 * How many of `widths` (in order) fit inline in `room` px; the rest go to More, which costs `more`
 * px (its square and the gap before it). More never holds a single tool: a lone overflow takes one
 * more tool with it.
 */
export function fitTools(widths: readonly number[], gap: number, room: number, more: number) {
  // A lone tool never goes to More: it stays inline (the row wraps instead).
  if (widths.length <= 1) return widths.length;
  const total = (count: number) =>
    widths.slice(0, count).reduce((sum, width) => sum + width, 0) + gap * Math.max(0, count - 1);
  if (total(widths.length) <= room) return widths.length;
  let count = 0;
  while (count < widths.length && total(count + 1) <= room - more) count++;
  return Math.max(0, Math.min(count, widths.length - 2));
}

type MoreProps = Parameters<typeof EditorMore>[0];
type Tool = { id: ToolId; label: string };
type Layout = {
  widths: Record<string, number>;
  /** The gap between tools, and between the header's items. */
  gap: number;
  headerGap: number;
  /** The header line's width after the items before the tools (language, draft dot). */
  room: number;
  /** More's square, and the queue stepper's width (0 without a queue). */
  more: number;
  queue: number;
};

/**
 * How many tools show inline, from sizes that do not depend on the answer (the header line, the
 * items before the tools, the queue, each tool's own width), so a fit never feeds back into the
 * next measurement. Without a queue, More sits on the tools' line. With one, either everything
 * fits on one line, or the queue (and More) wrap below and the tools get the whole line.
 */
export function phoneFit(widths: readonly number[], layout: Omit<Layout, 'widths'>) {
  const { gap, headerGap, room, more, queue } = layout;
  if (!queue) return fitTools(widths, gap, room, more + headerGap);
  const all = widths.reduce((sum, width) => sum + width, 0) + gap * Math.max(0, widths.length - 1);
  if (all + headerGap + queue <= room) return widths.length;
  return fitTools(widths, gap, room, 0);
}

/**
 * The phone tool row's actions: inline while they fit, the overflow (two or more tools) in More.
 * The widths come from a hidden copy of every tool (Discard included, with or without a draft),
 * read in a ResizeObserver callback, where layout is already clean: typing never measures, and a
 * draft appearing only changes which known widths count. Same handlers as More's rows; Discard
 * still asks first.
 */
export function PhoneTools(props: MoreProps & { queue?: React.ReactNode; reserveDraft?: boolean }) {
  const { markup, draft, saving, onDiscard, grouped, overrides, onEditOverride, renderGrouped } =
    props;
  const all: Tool[] = [
    ...(markup ? [{ id: 'markup' as const, label: 'Markup' }] : []),
    { id: 'discard', label: 'Discard' },
    ...(grouped ? [{ id: 'grouped' as const, label: `Grouped ${grouped.length}` }] : []),
    ...overrides.map((target) => ({
      id: `override:${target.hash}` as const,
      label: `Edit override${overrides.length > 1 ? `: ${target.name}` : ''}`,
    })),
  ];
  const tools = all.filter((tool) => tool.id !== 'discard' || draft || props.reserveDraft);
  const key = all.map((tool) => tool.label).join('|');
  const slot = useRef<HTMLSpanElement>(null);
  const measure = useRef<HTMLSpanElement>(null);
  const queueBox = useRef<HTMLSpanElement>(null);
  const hasQueue = Boolean(props.queue);
  const [layout, setLayout] = useState<Layout | null>(null);
  useLayoutEffect(() => {
    const row = slot.current;
    const copy = measure.current;
    const header = row?.parentElement;
    if (!row || !copy || !header || typeof ResizeObserver !== 'function') return;
    let first = true;
    let last = '';
    // Every size read here is independent of the fit (never the tools slot or the line it wraps
    // to), so an answer cannot change the next measurement: no back-and-forth, no idle work.
    const observer = new ResizeObserver(() => {
      const widths: Record<string, number> = {};
      for (const child of copy.children as HTMLCollectionOf<HTMLElement>)
        if (child.dataset.label) widths[child.dataset.label] = child.getBoundingClientRect().width;
      const square = copy.querySelector('[data-more]')?.getBoundingClientRect().width ?? 0;
      const gap = parseFloat(getComputedStyle(row).columnGap) || 0;
      const box = getComputedStyle(header);
      const headerGap = parseFloat(box.columnGap) || 0;
      let room =
        header.clientWidth -
        (parseFloat(box.paddingLeft) || 0) -
        (parseFloat(box.paddingRight) || 0);
      for (const item of header.children) {
        if (item === row) break;
        const width = item.getBoundingClientRect().width;
        if (width) room -= width + headerGap;
      }
      const queue = queueBox.current?.getBoundingClientRect().width ?? 0;
      const next = { widths, gap, headerGap, room, more: square, queue };
      const id = JSON.stringify(next);
      if (id === last) return;
      last = id;
      // The first answer lands before the first paint (no frame of everything in More).
      if (first) flushSync(() => setLayout(next));
      else setLayout(next);
      first = false;
    });
    // The copy is a 0x0 clip: its tools (whole width, no wrap) are what change size.
    observer.observe(header);
    for (const item of header.children) if (item !== row) observer.observe(item);
    for (const child of copy.children) observer.observe(child);
    if (queueBox.current) observer.observe(queueBox.current);
    return () => observer.disconnect();
  }, [key, hasQueue]);
  // Unmeasured (no layout yet, or no ResizeObserver): every tool in More (a lone one inline).
  const count = layout
    ? phoneFit(
        tools.map((tool) => layout.widths[tool.label] ?? 0),
        layout,
      )
    : tools.length <= 1
      ? tools.length
      : 0;
  const overflow = new Set(tools.slice(count).map((tool) => tool.id));
  return (
    <>
      <span ref={slot} className={styles.tools}>
        {tools.slice(0, count).map((tool) => (
          <InlineTool key={tool.id} tool={tool} {...props} />
        ))}
        <span ref={measure} className={styles.measure} aria-hidden="true">
          {all.map((tool) => (
            <span key={tool.id} data-label={tool.label} className={styles.tool}>
              {tool.label}
            </span>
          ))}
          <span data-more className={styles.trigger} />
        </span>
      </span>
      <span className={styles.right}>
        {props.queue && (
          <span ref={queueBox} className={styles.queue}>
            {props.queue}
          </span>
        )}
        {overflow.size > 0 && (
          <EditorMore
            {...{ markup, draft, saving, onDiscard, grouped, overrides, onEditOverride }}
            renderGrouped={renderGrouped}
            queueBack={props.queueBack}
            rows={overflow}
          />
        )}
      </span>
    </>
  );
}

function InlineTool({ tool, ...props }: { tool: Tool } & MoreProps) {
  const { markup, saving, onDiscard, grouped, onEditOverride, renderGrouped } = props;
  if (tool.id === 'markup' && markup)
    return (
      <button
        type="button"
        className={styles.tool}
        aria-pressed={markup.open}
        aria-keyshortcuts="Control+."
        aria-label="Markup bar"
        title="Show or hide the markup bar at the top of the editor"
        onClick={markup.toggle}
      >
        {tool.label}
      </button>
    );
  if (tool.id === 'discard' && !props.draft)
    return (
      <span className={styles.tool} style={{ visibility: 'hidden' }} aria-hidden="true">
        Discard
      </span>
    );
  if (tool.id === 'discard')
    return (
      <Popover
        label="Discard draft"
        className={`${styles.tool} ${styles.danger}`}
        flush
        contain
        triggerLabel="Discard this tooltip's draft"
        trigger={tool.label}
      >
        {(close) => (
          <ul className={styles.rows}>
            <DiscardRow
              saving={saving}
              asked
              onCancel={() => close()}
              onDiscard={() => {
                onDiscard();
                close(false);
              }}
            />
          </ul>
        )}
      </Popover>
    );
  if (tool.id === 'grouped' && grouped)
    return (
      <Popover
        label="Grouped manifest perks"
        className={styles.tool}
        contain
        trigger={tool.label}
        triggerTitle="Which manifest perks open this editor entry, and how each joined (maintainers)"
      >
        {renderGrouped(grouped)}
      </Popover>
    );
  const hash = Number(tool.id.slice('override:'.length));
  return (
    <button type="button" className={styles.tool} onClick={() => onEditOverride(hash)}>
      {tool.label}
    </button>
  );
}
