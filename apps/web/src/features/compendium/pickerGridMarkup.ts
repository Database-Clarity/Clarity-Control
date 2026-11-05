import type { CompendiumCell, CompendiumRun, CompendiumSheet } from '@clarity/core';
import richStyles from './RichCell.module.scss';
import gridStyles from './PickerGrid.module.scss';
import { isPickerSeparator, pickerSeparatorLabelRow } from './pickerSeparators';

// All source text and attribute values cross this one escaping boundary. Links are
// deliberately omitted, just as in RichCell's links={false} selection surface.
const escape = (text: string) =>
  text.replace(
    /[&<>"']/g,
    (char) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#x27;',
      })[char]!,
  );
const cells = new WeakMap<CompendiumCell, string>();
const alignments = new Set(['left', 'center', 'right', 'justify', 'start', 'end']);
function runStyle(run: CompendiumRun) {
  return [
    /^#[\da-f]{6}([\da-f]{2})?$/i.test(run.color ?? '') ? `color:${run.color}` : '',
    Number.isFinite(run.sizePt) && run.sizePt! > 0 && run.sizePt! <= 200
      ? `font-size:${run.sizePt}pt`
      : '',
    `font-weight:${run.bold ? 700 : 400}`,
    `font-style:${run.italic ? 'italic' : 'normal'}`,
    `text-decoration:${[run.underline && 'underline', run.strike && 'line-through'].filter(Boolean).join(' ') || 'none'}`,
  ]
    .filter(Boolean)
    .join(';');
}
function runsHtml(runs: (CompendiumRun | string)[]) {
  const parts: (string | { text: string; style: string })[] = [];
  for (const run of runs) {
    if (typeof run === 'string') {
      parts.push(run);
      continue;
    }
    if (!run.text) continue;
    const style = runStyle(run),
      previous = parts.at(-1);
    if (previous && typeof previous !== 'string' && previous.style === style)
      previous.text += run.text;
    else parts.push({ text: run.text, style });
  }
  return parts
    .map((part) =>
      typeof part === 'string'
        ? escape(part)
        : `<span style="${part.style}">${escape(part.text)}</span>`,
    )
    .join('');
}
export function pickerCellHtml(cell: CompendiumCell): string {
  const cached = cells.get(cell);
  if (cached !== undefined) return cached;
  let contents: string;
  if (cell.runs.some((run) => run.textAlign)) {
    const blocks: {
      align: CompendiumRun['textAlign'];
      parts: (CompendiumRun | string)[];
      empty?: boolean;
    }[] = [];
    let line: CompendiumRun[] = [];
    const finish = (newline: boolean) => {
      const align = line.find((run) => run.text.trim())?.textAlign ?? line[0]?.textAlign;
      let block = blocks.at(-1);
      if (!block || block.align !== align) blocks.push((block = { align, parts: [] }));
      block.parts.push(...line);
      if (newline) block.parts.push('\n');
      else block.empty = line.every((run) => !run.text);
      line = [];
    };
    for (const run of cell.runs)
      run.text.split('\n').forEach((text, index) => {
        if (index) finish(true);
        line.push({ ...run, text });
      });
    finish(false);
    contents = blocks
      .map(
        (block) =>
          `<span class="${richStyles.line}"${block.align && alignments.has(block.align) ? ` style="text-align:${block.align}"` : ''}>${runsHtml(block.parts)}${block.empty ? '<br>' : ''}</span>`,
      )
      .join('');
  } else contents = runsHtml(cell.runs);
  const html = `<span class="${richStyles.multiline}" data-multiline="true">${contents}</span>`;
  cells.set(cell, html);
  return html;
}

// Immutable sheet identity invalidates both markup and occupancy on a dataset refresh.
// Keep only a few recently visited windows per live sheet, rather than every anchor.
const windows = new WeakMap<CompendiumSheet, Map<string, string>>();
export function pickerGridHtml(
  tab: CompendiumSheet,
  firstRow: number,
  lastRow: number,
  columns: number,
  windowFirst = firstRow,
  windowLast = lastRow,
) {
  let cache = windows.get(tab);
  if (!cache) windows.set(tab, (cache = new Map()));
  const key = `${firstRow}:${lastRow}:${columns}:${windowFirst}:${windowLast}`;
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  const occupied = new Map<string, NonNullable<CompendiumSheet['grid']>[number]>();
  for (const entry of tab.grid ?? []) {
    for (
      let row = Math.max(firstRow, entry.row);
      row <= Math.min(lastRow, entry.row + (entry.rowSpan ?? 1) - 1);
      row++
    ) {
      for (let col = entry.col; col < entry.col + (entry.colSpan ?? 1); col++) {
        const key = `${row}:${col}`;
        if (!occupied.has(key)) occupied.set(key, entry);
      }
    }
  }
  let html = '';
  for (let row = firstRow; row <= lastRow; row++) {
    html += `<tr><th scope="row">${row}</th>`;
    for (let col = 0; col < columns; col++) {
      const entry = occupied.get(`${row}:${col}`);
      if (!entry) {
        html += '<td></td>';
        continue;
      }
      const separator = (entry.rowSpan ?? 1) > 1 && isPickerSeparator(entry.cell);
      if (col !== entry.col || (!separator && row !== Math.max(firstRow, entry.row))) continue;
      if (separator) {
        const start = Math.max(windowFirst, entry.row),
          end = Math.min(windowLast, entry.row + (entry.rowSpan ?? 1) - 1);
        const text =
          row === pickerSeparatorLabelRow(entry, windowFirst, windowLast)
            ? pickerCellHtml(entry.cell)
            : '';
        html += `<td class="${gridStyles.separator}" colspan="${entry.colSpan ?? 1}" data-cell="${entry.row}:${entry.col}" data-separator="true" data-start="${row === start}" data-end="${row === end}"><button type="button" class="${gridStyles.contents}" data-row="${entry.row}" data-col="${entry.col}" aria-pressed="false" data-separator-label="${row === pickerSeparatorLabelRow(entry, windowFirst, windowLast)}" aria-label="${escape(`Row ${entry.row}, column ${col + 1}: ${entry.cell.plain}`)}">${text}</button></td>`;
        continue;
      }
      const span = Math.min(entry.row + (entry.rowSpan ?? 1) - row, lastRow - row + 1);
      html += `<td colspan="${entry.colSpan ?? 1}" rowspan="${span}" data-cell="${entry.row}:${entry.col}"><button type="button" class="${gridStyles.contents}" data-row="${entry.row}" data-col="${entry.col}" aria-pressed="false" aria-label="${escape(`Row ${entry.row}, column ${col + 1}: ${entry.cell.plain}`)}">${pickerCellHtml(entry.cell)}</button></td>`;
    }
    html += '</tr>';
  }
  if (cache.size >= 6) cache.delete(cache.keys().next().value!);
  cache.set(key, html);
  return html;
}
