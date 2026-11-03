import { EditorSelection, type EditorState, type TransactionSpec } from '@codemirror/state';

export function tableFormattingTransaction(state: EditorState): TransactionSpec | undefined {
  const text = state.doc.toString();
  const formatted = formatMarkupTables(text);
  if (text === formatted) return;
  const next = state.toText(formatted);
  const position = (offset: number) => {
    const line = state.doc.lineAt(offset);
    const nextLine = next.line(line.number);
    return nextLine.from + Math.min(offset - line.from, nextLine.length);
  };
  return {
    changes: { from: 0, to: text.length, insert: formatted },
    selection: EditorSelection.create(
      state.selection.ranges.map((range) =>
        EditorSelection.range(position(range.anchor), position(range.head)),
      ),
      state.selection.mainIndex,
    ),
    userEvent: 'input',
  };
}

export function formatMarkupTables(text: string): string {
  return text.replace(/< table [^]+?\n<\$>/g, (table) => {
    const lines = table.split('\n');
    const rows = lines.slice(1, -1).map((line) => [...line.matchAll(/(\|[bchr\d-]*)([^|]*)/g)]);
    // Row-level markup (e.g. a line class) can sit before the first "|"; it is kept verbatim.
    const leads = lines.slice(1, -1).map((line) => line.slice(0, line.indexOf('|')));
    const prefixes: number[] = [];
    const widths: number[] = [];
    for (const row of rows) {
      row.forEach((cell, index) => {
        prefixes[index] = Math.max(prefixes[index] ?? 0, cell[1].length);
        widths[index] = Math.max(widths[index] ?? 0, cell[2].trim().length);
      });
    }
    return [
      lines[0],
      ...rows.map((row, index) =>
        row.length
          ? leads[index] +
            row
              .map(
                (cell, column) =>
                  `${cell[1].padEnd(prefixes[column])} ${cell[2].trim().padEnd(widths[column])} `,
              )
              .join('')
              .trimEnd()
          : lines[index + 1],
      ),
      lines[lines.length - 1],
    ].join('\n');
  });
}
