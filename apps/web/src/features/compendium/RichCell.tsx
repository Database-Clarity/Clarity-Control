import { memo, type CSSProperties, type ReactNode } from 'react';
import type { CompendiumCell, CompendiumRun } from '@clarity/core';
import { readableOn, useLegibleOn } from './sheetSurface';
import styles from './RichCell.module.scss';

const styleCache = new Map<string, CSSProperties>();
let segmenter: Intl.Segmenter | undefined;
function emojiText(text: string, direct: boolean): ReactNode {
  if (!direct || !text.includes('\uFE0F') || typeof Intl.Segmenter !== 'function') return text;
  segmenter ??= new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  const parts: ReactNode[] = [];
  let plain = '';
  for (const { segment } of segmenter.segment(text)) {
    if (
      segment.includes('\uFE0F') &&
      !segment.includes('\uFE0E') &&
      /\p{Extended_Pictographic}/u.test(segment)
    ) {
      if (plain) parts.push(plain);
      plain = '';
      parts.push(
        <span key={parts.length} className={styles.emojiFace}>
          {segment}
        </span>,
      );
    } else plain += segment;
  }
  if (plain) parts.push(plain);
  return parts;
}
export function runStyle(run: CompendiumRun, legibleOn?: string): CSSProperties {
  const key = [
    run.color,
    run.sizePt,
    !!run.bold,
    !!run.italic,
    !!run.underline,
    !!run.strike,
    legibleOn,
  ].join('|');
  const existing = styleCache.get(key);
  if (existing) return existing;
  const style: CSSProperties = {
    color: run.color && legibleOn ? readableOn(run.color, legibleOn) : run.color,
    fontSize: run.sizePt === undefined ? undefined : `${run.sizePt}pt`,
    fontWeight: run.bold ? 700 : 400,
    fontStyle: run.italic ? 'italic' : 'normal',
    textDecoration:
      [run.underline && 'underline', run.strike && 'line-through'].filter(Boolean).join(' ') ||
      'none',
  };
  if (styleCache.size >= 1024) styleCache.clear();
  styleCache.set(key, style);
  return style;
}
export function Multiline({ children }: { children: ReactNode }) {
  return (
    <span className={styles.multiline} data-multiline="true">
      {children}
    </span>
  );
}
type Block = {
  align: CompendiumRun['textAlign'];
  parts: (CompendiumRun | string)[];
  emptyLastLine?: boolean;
};
const blocksByCell = new WeakMap<CompendiumCell, Block[]>();
function alignedBlocks(cell: CompendiumCell) {
  const cached = blocksByCell.get(cell);
  if (cached) return cached;
  const blocks: Block[] = [];
  let line: CompendiumRun[] = [];
  const finish = (newline: boolean) => {
    const align = line.find((run) => run.text.trim())?.textAlign ?? line[0]?.textAlign;
    let block = blocks.at(-1);
    if (!block || block.align !== align) blocks.push((block = { align, parts: [] }));
    block.parts.push(...line);
    if (newline) block.parts.push('\n');
    else block.emptyLastLine = line.every((run) => !run.text);
    line = [];
  };
  for (const run of cell.runs) {
    run.text.split('\n').forEach((text, index) => {
      if (index) finish(true);
      line.push({ ...run, text });
    });
  }
  finish(false);
  blocksByCell.set(cell, blocks);
  return blocks;
}
function richRuns(
  runs: (CompendiumRun | string)[],
  links: boolean,
  legibleOn?: string,
  emojiFace = false,
) {
  const parts: (string | { text: string; style: CSSProperties; href?: string })[] = [];
  for (const run of runs) {
    if (typeof run === 'string') {
      parts.push(run);
      continue;
    }
    if (!run.text) continue;
    const style = runStyle(run, legibleOn);
    const href = links ? run.href : undefined;
    const previous = parts.at(-1);
    // Sheet exports split identical formatting into many runs. A single inline
    // box preserves the exact text, styles and link while avoiding shaping each
    // fragment separately. Newlines between aligned blocks stay untouched.
    if (
      previous &&
      typeof previous !== 'string' &&
      previous.style === style &&
      previous.href === href
    )
      previous.text += run.text;
    else parts.push({ text: run.text, style, href });
  }
  return parts.map((part, index) =>
    typeof part === 'string' ? (
      part
    ) : part.href ? (
      <a key={index} href={part.href} target="_blank" rel="noreferrer">
        <span style={part.style}>{emojiText(part.text, emojiFace)}</span>
      </a>
    ) : (
      <span key={index} style={part.style}>
        {emojiText(part.text, emojiFace)}
      </span>
    ),
  );
}
export const RichCell = memo(function RichCell({
  cell,
  links = true,
  inline = false,
  emojiFace = false,
}: {
  cell: CompendiumCell;
  links?: boolean;
  inline?: boolean;
  emojiFace?: boolean;
}): ReactNode {
  const legibleOn = useLegibleOn();
  // Inline fragments share the enclosing diff cell's whitespace and alignment.
  // A wrapper per word adds layout boxes without adding formatting semantics.
  if (inline) return richRuns(cell.runs, links, legibleOn, emojiFace);
  // Adjacent physical lines with the same alignment share one CSS text block.
  // Literal newlines retain wrapping/blank lines without a layout box per line.
  // Runs remain React-escaped text and retain the original styles and links.
  return (
    <Multiline>
      {!inline && cell.runs.some((run) => run.textAlign)
        ? alignedBlocks(cell).map((block, index) => (
            <span key={index} className={styles.line} style={{ textAlign: block.align }}>
              {richRuns(block.parts, links, legibleOn, emojiFace)}
              {block.emptyLastLine && <br />}
            </span>
          ))
        : richRuns(cell.runs, links, legibleOn, emojiFace)}
    </Multiline>
  );
});
