import {
  compendiumTabs,
  isTrackedCompendiumTab,
  type CompendiumColumns,
  type CompendiumTabConfig,
} from './config.js';
import {
  attr,
  descendants,
  elements,
  parse,
  textContent,
  type HtmlElement,
  type HtmlNode,
} from './html.js';
import { cssRules, resolveStyle, safeHref } from './styles.js';
import {
  normaliseRuns,
  type CompendiumCell,
  type CompendiumGridCell,
  type CompendiumRun,
  type CompendiumSheet,
  type CompendiumStyle,
  type CompendiumTab,
} from './types.js';
import { normaliseCompendiumName } from './resolve.js';

export function parseCompendiumTabs(html: string): CompendiumTab[] {
  const tabs = new Map<string, CompendiumTab>();
  // The Landing htmlview bootstraps the sheet switcher as data, not DOM links.
  for (const [, name, gid] of html.matchAll(
    /items\.push\(\{name:\s*("(?:\\.|[^"\\])*")[\s\S]*?\bgid:\s*"(-?\d+)"/g,
  )) {
    const decoded: unknown = JSON.parse(name);
    if (typeof decoded === 'string') tabs.set(gid, { gid, name: decoded });
  }
  for (const link of descendants(parse(html), 'a')) {
    const gid = /[?&#]gid=(-?\d+)/.exec(attr(link, 'href'))?.[1];
    const name = textContent(link).trim();
    if (gid && name && !tabs.has(gid)) tabs.set(gid, { gid, name });
  }
  if (!tabs.size) throw new Error('Compendium Landing page did not contain any tabs');
  return [...tabs.values()].filter((tab) => isTrackedCompendiumTab(tab.name));
}

interface GridCell extends CompendiumGridCell {
  element: HtmlElement;
}
interface GridRow {
  row: number;
  cells: (GridCell | undefined)[];
}
export function parseCompendiumGrid(html: string): GridRow[] {
  const document = parse(html);
  const rules = cssRules(descendants(document, 'style').map(textContent).join('\n'));
  function runs(node: HtmlNode, inherited: CompendiumStyle): CompendiumRun[] {
    if ('value' in node)
      return [{ ...inherited, text: node.value.replace(/\r\n?/g, '\n').replace(/\u00a0/g, ' ') }];
    if (!('tagName' in node) || ['script', 'style', 'img'].includes(node.tagName)) return [];
    const style = resolveStyle(node, inherited, rules);
    const href = node.tagName === 'a' ? safeHref(attr(node, 'href')) : undefined;
    if (href) style.href = href;
    if (node.tagName === 'br') return [{ ...style, text: '\n' }];
    return node.childNodes.flatMap((child) => runs(child, style));
  }
  function cell(element: HtmlElement): CompendiumCell {
    const ancestors: HtmlElement[] = [];
    let parent = element.parentNode;
    while (parent) {
      if ('tagName' in parent) ancestors.unshift(parent);
      parent = 'parentNode' in parent ? parent.parentNode : null;
    }
    const inherited = ancestors.reduce(
      (style, ancestor) => resolveStyle(ancestor, style, rules),
      {},
    );
    return normaliseRuns(runs(element, inherited));
  }
  const table =
    descendants(document, 'table').find((node) =>
      attr(node, 'class').split(/\s+/).includes('waffle'),
    ) ?? descendants(document, 'table')[0];
  if (!table) throw new Error('Compendium response did not contain a sheet table');
  const result: GridRow[] = [];
  const occupied: (GridCell | undefined)[][] = [];
  for (const element of descendants(table, 'tr')) {
    const cells = elements(element).filter((node) => ['td', 'th'].includes(node.tagName));
    const data = cells.filter(
      (node) => node.tagName === 'td' && !attr(node, 'class').includes('freezebar'),
    );
    if (!data.length) continue;
    const heading = cells.find((node) => node.tagName === 'th');
    const row = Number(heading ? textContent(heading).trim() : result.length + 1);
    if (!Number.isInteger(row) || row < 1 || row > 20000) continue;
    const grid = occupied[row - 1] ?? [];
    occupied[row - 1] = grid;
    let column = 0;
    for (const element of data) {
      while (grid[column]) column++;
      const width = Number(attr(element, 'colspan') || 1);
      const height = Number(attr(element, 'rowspan') || 1);
      if (
        ![width, height].every((span) => Number.isInteger(span) && span >= 1 && span <= 256) ||
        column + width > 256
      )
        throw new Error('Invalid Compendium cell span');
      const value = {
        element,
        cell: cell(element),
        row,
        col: column,
        ...(width > 1 ? { colSpan: width } : {}),
        ...(height > 1 ? { rowSpan: height } : {}),
      };
      for (let down = 0; down < height; down++) {
        const target = (occupied[row - 1 + down] ??= []);
        for (let across = 0; across < width; across++) {
          if (target[column + across]) throw new Error('Overlapping Compendium cell spans');
          target[column + across] = value;
        }
      }
      column += width;
    }
    result.push({ row, cells: grid });
  }
  if (!result.length) throw new Error('Compendium sheet did not contain data rows');
  return result;
}

function detectColumns(cells: GridRow['cells'], config?: CompendiumTabConfig) {
  const nameHeaders = [
    'name',
    'perk',
    'trait',
    'mod',
    'ability',
    'armor set',
    'exotic',
    'fragment',
    'aspect',
    'weapon',
    'armor',
    ...(config?.nameHeaders ?? []).map((name) => name.toLowerCase()),
  ];
  const descriptionHeaders = [
    'description',
    'descriptions',
    'effect',
    'effects',
    ...(config?.descriptionHeaders ?? []).map((name) => name.toLowerCase()),
  ];
  const distinct = cells
    .map((cell, index) => ({ cell, index }))
    .filter(({ cell, index }) => cell && cells.indexOf(cell) === index);
  const nameColumns = distinct
    .filter(({ cell }) => nameHeaders.includes(cell!.cell.plain.trim().toLowerCase()))
    .map(({ index }) => index);
  const descriptionColumns = distinct
    .filter(({ cell }) => descriptionHeaders.includes(cell!.cell.plain.trim().toLowerCase()))
    .map(({ index }) => index);
  if (!nameColumns.length || !descriptionColumns.length) return undefined;
  const groups: CompendiumColumns[] = [];
  for (const [index, description] of descriptionColumns.entries()) {
    const names = nameColumns.filter(
      (column) => column < description && column > (descriptionColumns[index - 1] ?? -1),
    );
    if (!names.length) {
      groups.at(-1)?.descriptionColumns.push(description);
    } else {
      groups.push({
        nameColumns: names,
        descriptionColumns: [description],
        ...(descriptionColumns.length > 1 ? { section: cells[names[0]]!.cell.plain.trim() } : {}),
      });
    }
  }
  return groups;
}
export function parseCompendiumSheet(html: string, tab: string, tabName?: string): CompendiumSheet {
  const config = compendiumTabs[tab];
  if (!isTrackedCompendiumTab(tabName ?? config?.name ?? tab)) {
    throw new Error(`Ignored Compendium tab: ${tabName ?? config?.name ?? tab}`);
  }
  const grid = parseCompendiumGrid(html);
  const fullGrid = [
    ...new Set(
      grid.flatMap(({ cells }) =>
        cells.filter((cell): cell is GridCell => !!cell && !!cell.cell.plain.trim()),
      ),
    ),
  ].map(({ row, col, rowSpan, colSpan, cell }) => ({
    row,
    col,
    ...(rowSpan ? { rowSpan } : {}),
    ...(colSpan ? { colSpan } : {}),
    cell,
  }));
  if (config?.navigationOnly)
    return { gid: tab, name: tabName ?? config.name, rows: [], grid: fullGrid };
  let groups: CompendiumColumns[] | undefined = config?.cards ? config.groups : undefined;
  let section: string | undefined;
  const rows: CompendiumSheet['rows'] = [];
  const sources = new Map<HtmlElement, CompendiumSheet['rows'][number]>();
  const seenDescriptions = new Map<HtmlElement, Set<HtmlElement>>();
  for (const [gridIndex, { row, cells }] of grid.entries()) {
    const detected = detectColumns(cells, config);
    if (detected?.length) {
      groups = detected;
      continue;
    }
    const distinct = [...new Set(cells)].filter(
      (cell): cell is GridCell => !!cell && !!cell.cell.plain.trim(),
    );
    const marker = distinct.find((cell) =>
      config?.sectionHeaders?.some(
        (header) => header.toLowerCase() === cell.cell.plain.trim().toLowerCase(),
      ),
    );
    const override = Object.entries(config?.sectionOverrides ?? {}).find(([header]) =>
      distinct.some((cell) => cell.cell.plain.startsWith(header)),
    );
    if (
      marker ||
      override ||
      (distinct.length === 1 && cells.filter((cell) => cell === distinct[0]).length >= 3)
    ) {
      section = distinct[0].cell.plain.trim();
      if (override) groups = override[1];
      else if (marker && !groups) {
        groups =
          config?.groups ??
          (config?.nameColumns && config.descriptionColumns
            ? [{ nameColumns: config.nameColumns, descriptionColumns: config.descriptionColumns }]
            : undefined);
      }
      continue;
    }
    if (!groups) continue;
    for (const columns of groups) {
      const names = [...new Set(columns.nameColumns.map((index) => cells[index]))].filter(
        (cell): cell is GridCell => !!cell,
      );
      const name = names[0];
      if (config?.cards && (!name || Number(attr(name.element, 'colspan') || 1) !== 1)) continue;
      const seen = name && (seenDescriptions.get(name.element) ?? new Set<HtmlElement>());
      const descriptionCells = config?.cards ? grid[gridIndex + 1]?.cells : cells;
      const descriptions = [
        ...new Set(columns.descriptionColumns.map((index) => descriptionCells?.[index])),
      ].filter(
        (entry): entry is GridCell =>
          !!entry &&
          !names.includes(entry) &&
          !!entry.cell.plain.trim() &&
          !seen?.has(entry.element),
      );
      const rowKey = names
        .map((entry) => entry.cell.plain.trim())
        .filter(Boolean)
        .join(' ');
      if (!name || !rowKey || !descriptions.length) continue;
      for (const description of descriptions) seen!.add(description.element);
      seenDescriptions.set(name.element, seen!);
      const combined = normaliseRuns(
        descriptions.flatMap((entry, index) => [
          ...(index ? [{ text: '\n' }] : []),
          ...entry.cell.runs,
        ]),
      );
      const existing = sources.get(name.element);
      if (existing) {
        // Row-spanned names own all their description rows, not just the first.
        existing.cell = normaliseRuns([...existing.cell.runs, { text: '\n' }, ...combined.runs]);
      } else {
        const entry = {
          name: rowKey,
          nameNorm: normaliseCompendiumName(rowKey),
          rowIndex: row,
          anchor: { row: name.row, col: name.col },
          ...((columns.section ?? section) ? { section: columns.section ?? section } : {}),
          cell: combined,
        };
        rows.push(entry);
        sources.set(name.element, entry);
      }
    }
  }
  if (!groups)
    throw new Error(
      `Could not detect Compendium name/description headers for ${tabName ?? tab}; configure this tab in core/compendium/config.ts`,
    );
  return { gid: tab, name: tabName ?? config?.name ?? tab, rows, grid: fullGrid };
}
