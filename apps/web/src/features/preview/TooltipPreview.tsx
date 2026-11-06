import { ArchiveIcon } from '../archive/ArchiveIcon';
import { languageLabel } from '../../languageLabels';
import { memo, useContext, useEffect, useId, useMemo, useRef, type ReactNode } from 'react';
import {
  LivePreviewIdentity,
  previewIdentityFor,
  type PreviewIdentity,
} from './LivePreviewIdentity';
import { useSteppingActivity } from '../navigation/steppingActivity';
import { closeTitlePopover, openTitlePopover } from './titlePopover';
import { Link } from 'react-router-dom';
import {
  markupLanguage,
  parseMarkup,
  type Lang,
  type MarkupGlobals,
  type MarkupLine,
  type MarkupSpan,
  resolveAlias,
} from '@clarity/core';
import { useDataStore, type EditorData } from '../../stores/data';
import { useDraftStore } from '../../stores/drafts';
import { canonicalHash, itemFor, tooltipFor } from '../navigation/catalog';
import styles from './TooltipPreview.module.scss';

export interface TooltipPreviewProps {
  text: string;
  lang: Lang;
  name: string;
  /** Exotic armour: the piece carrying this perk, shown above the perk's name. */
  piece?: string;
  icon?: string;
  categoryLabel?: string;
  globals: MarkupGlobals;
  tooltipHash?: number;
  archiveIcon?: boolean;
  /** Content between the perk header and the description (the column's version switch). */
  bar?: ReactNode;
  /** The column variant: header and bar span the whole column and stay put while the body scrolls. */
  fill?: boolean;
  /** Replaces the rendered description (the column's Compare view); markup issues are hidden. */
  children?: ReactNode;
}

export function classNames(names?: (string | undefined)[]) {
  return names?.flatMap((name) => (name && styles[name] ? [styles[name]] : [])).join(' ');
}

function linkUrl(url: string): string | undefined {
  return /^(https?:\/\/|mailto:)/i.test(url.trim()) ? url.trim() : undefined;
}

/**
 * A term with a tooltip: hover or focus opens its body as a top-layer popover (titlePopover.ts), Esc
 * closes it. The body stays rendered, so opening costs one placement and no React work.
 */
function TitleAnchor({ part, id }: { part: MarkupSpan; id: string }) {
  const box = useRef<HTMLSpanElement>(null);
  const anchor = useRef<HTMLSpanElement>(null);
  // One stable function: it is also the scroll listener, since scrolling anything while the popover
  // is open would leave a fixed box behind its anchor.
  const hide = useMemo(() => {
    const close = () => {
      window.removeEventListener('scroll', close, true);
      if (box.current) closeTitlePopover(box.current);
    };
    return close;
  }, []);
  const open = (pointer?: { x: number; y: number }) => {
    if (!anchor.current || !box.current) return;
    openTitlePopover(anchor.current, box.current, pointer);
    window.addEventListener('scroll', hide, { capture: true, passive: true });
  };
  useEffect(() => hide, [hide]);
  return (
    <span
      ref={anchor}
      className={styles.titleAnchor}
      tabIndex={0}
      aria-describedby={id}
      onPointerEnter={(event) => {
        if (event.pointerType !== 'touch') open({ x: event.clientX, y: event.clientY });
      }}
      onPointerLeave={hide}
      onFocus={() => open()}
      onBlur={hide}
      onKeyDown={(event) => {
        if (event.key !== 'Escape' || !box.current?.matches(':popover-open, [data-open]')) return;
        event.stopPropagation();
        hide();
      }}
    >
      {part.text}
      <span
        ref={box}
        {...{ popover: 'manual' }}
        className={styles.titleContainer}
        role="tooltip"
        id={id}
      >
        <Lines lines={part.title ?? []} />
      </span>
    </span>
  );
}

/** One span of rendered markup: text, icon, link or title anchor. */
export function PreviewSpan({ part }: { part: MarkupSpan }) {
  const id = useId();
  const link = part.link ? linkUrl(part.link) : undefined;
  return (
    <span className={classNames(part.classNames)}>
      {part.title ? (
        <TitleAnchor part={part} id={id} />
      ) : link ? (
        <a href={link} target="_blank" rel="noreferrer">
          {part.text}
        </a>
      ) : (
        <span title={part.link ? 'Unsafe link omitted' : undefined}>{part.text}</span>
      )}
    </span>
  );
}

// A keystroke usually changes one line. Parsed lines are plain render data, so retain
// the unchanged React subtrees even when a fresh parse creates new line objects.
const PreviewLine = memo(
  function PreviewLine({ line }: { line: MarkupLine }) {
    return line.table ? (
      <table className={classNames(line.classNames)}>
        <tbody>
          {line.table.map((row, rowIndex) => (
            <tr key={rowIndex} className={classNames(row.classNames)}>
              {row.rowContent?.map((cell, cellIndex) => (
                <td
                  key={cellIndex}
                  colSpan={cell.colSpan}
                  rowSpan={cell.rowSpan}
                  className={classNames(cell.classNames)}
                >
                  {cell.cellContent.map((part, partIndex) => (
                    <PreviewSpan key={partIndex} part={part} />
                  ))}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    ) : (
      <div className={classNames(line.classNames)}>
        {line.linesContent?.map((part, partIndex) => (
          <PreviewSpan key={partIndex} part={part} />
        ))}
      </div>
    );
  },
  (previous, next) =>
    previous.line === next.line || JSON.stringify(previous.line) === JSON.stringify(next.line),
);

export function Lines({ lines }: { lines: MarkupLine[] }) {
  return (
    <>
      {lines.map((line, index) => (
        <PreviewLine key={index} line={line} />
      ))}
    </>
  );
}

/** A bare rendering of markup (no header), for popovers; same renderer and styles as the preview. */
export function MarkupSnippet({
  text,
  lang,
  globals,
}: {
  text: string;
  lang: Lang;
  globals: MarkupGlobals;
}) {
  const parsed = useMemo(() => parseMarkup(text, globals), [text, globals]);
  return (
    <div className={styles.snippet} lang={markupLanguage(lang)}>
      <Lines lines={parsed.lines} />
    </div>
  );
}

export function TooltipPreview({
  text,
  lang,
  name,
  piece,
  icon,
  categoryLabel,
  globals,
  tooltipHash,
  archiveIcon = false,
  bar,
  fill = false,
  children,
}: TooltipPreviewProps) {
  const replaced = Boolean(children);
  // Compare supplies its already-rendered body and hides these diagnostics. Do not
  // parse the base a third time only to discard that result on every keystroke.
  const parsed = useMemo(
    () => (replaced ? null : parseMarkup(text, globals)),
    [text, globals, replaced],
  );
  return (
    <section
      className={[styles.preview, fill ? styles.fill : ''].filter(Boolean).join(' ')}
      lang={markupLanguage(lang)}
      aria-label={`${name} preview`}
    >
      <div className={styles.top}>
        <PreviewHeader
          name={name}
          piece={piece}
          icon={icon}
          categoryLabel={categoryLabel}
          archiveIcon={archiveIcon}
          live={fill}
        />
        {bar}
      </div>
      <div className={styles.description}>{children ?? <Lines lines={parsed?.lines ?? []} />}</div>
      {!children && parsed && parsed.diagnostics.length > 0 && (
        <details className={styles.diagnostics}>
          <summary>{parsed.diagnostics.length} markup issue(s)</summary>
          <ul>
            {parsed.diagnostics.map((issue, index) => (
              <li key={index}>
                {issue.severity}: {issue.message}
              </li>
            ))}
          </ul>
        </details>
      )}
      {tooltipHash !== undefined && (
        <AssociatedTooltips hash={tooltipHash} lang={lang} globals={globals} />
      )}
    </section>
  );
}

function PreviewHeader(props: PreviewIdentity & { live: boolean }) {
  const identity = useContext(LivePreviewIdentity);
  const target = useSteppingActivity((state) => (props.live ? state.target : undefined));
  const data = useDataStore((state) => (target ? state.data : null));
  const urgent = useMemo(
    () =>
      target && data
        ? previewIdentityFor(
            canonicalHash(Number(target.split('/')[2].split('?')[0]), data),
            data,
            identity?.archiveIcon,
          )
        : undefined,
    [target, data, identity?.archiveIcon],
  );
  const { name, piece, icon, categoryLabel, archiveIcon } =
    urgent || (props.live && identity) || props;
  const iconUrl = icon?.startsWith('/common/') ? `https://www.bungie.net${icon}` : icon;
  return (
    <header className={styles.header}>
      {archiveIcon ? (
        <ArchiveIcon icon={icon} />
      ) : (
        iconUrl && linkUrl(iconUrl) && <img className={styles.icon} src={iconUrl} alt="" />
      )}
      <div>
        {piece && <div className={styles.piece}>{piece}</div>}
        <div className={styles.name}>{name}</div>
        {categoryLabel && <div className={styles.category}>{categoryLabel}</div>}
      </div>
    </header>
  );
}

function AssociatedTooltips({
  hash,
  lang,
  globals,
}: {
  hash: number;
  lang: Lang;
  globals: MarkupGlobals;
}) {
  const data = useDataStore((state) => state.data);
  const membership = useDraftStore(
    (state) => (state.drafts[hash]?.next ?? data?.bundle.tooltips[hash])?.associated,
  );
  const associated = useMemo(
    () =>
      data
        ? [
            ...new Set((membership ?? []).map((target) => resolveAlias(target, data.aliases))),
          ].filter((target) => target !== hash)
        : [],
    [membership, hash, data],
  );
  if (!data) return null;
  if (!associated.length) return null;
  return (
    <section className={styles.associated} aria-label="Associated tooltip previews">
      {associated.map((target) => (
        <AssociatedTooltip key={target} target={target} data={data} lang={lang} globals={globals} />
      ))}
    </section>
  );
}

const AssociatedTooltip = memo(function AssociatedTooltip({
  target,
  data,
  lang,
  globals,
}: {
  target: number;
  data: EditorData;
  lang: Lang;
  globals: MarkupGlobals;
}) {
  const text = useDraftStore(
    (state) => (state.drafts[target]?.next ?? tooltipFor(target, data)).text[lang]?.text,
  );
  const item = itemFor(target, data);
  const name = item?.name ?? `Tooltip ${target}`;
  const category = data.categories.find((entry) => entry.id === item?.categoryId);
  const typed = useMemo(
    () => ({ ...globals, type: category?.legacyType }),
    [globals, category?.legacyType],
  );
  return (
    <details>
      <summary>
        {item?.icon && <img src={`https://www.bungie.net${item.icon}`} alt="" />}
        <Link to={`/t/${canonicalHash(target, data)}`}>{name}</Link>
      </summary>
      {text !== undefined ? (
        <TooltipPreview
          text={text}
          lang={lang}
          name={name}
          icon={item?.icon}
          categoryLabel={category?.label}
          globals={typed}
        />
      ) : (
        <p>No {languageLabel(lang)} text yet.</p>
      )}
    </details>
  );
});
