import { resolveAlias, type Aliases } from '../aliases.js';
import type { Tooltip } from '../schemas.js';
import type { CompendiumItem } from './link.js';
import { selectCompendiumCells } from './cells.js';
import { resolveCompendiumLink, snapshotCompendium } from './resolve.js';
import { sameCell, type CompendiumData, type CompendiumLink } from './types.js';
import nodeRecords from './reviewed-nodes.json';
import ruleRecords from './reviewed-rules.json';

interface Node {
  name: string;
  category: string;
  template: string;
  imports: string[];
}
interface Rule {
  rule: string;
  dependencies: string[];
  gid: string;
  section: string;
  rowKey: string;
  cells: { dRow: number; dCol: number }[];
}
export const reviewedCompendiumNodes: Readonly<Record<string, Node>> = nodeRecords;
export const reviewedCompendiumRules: Readonly<Record<string, Rule>> = ruleRecords;

// An allowlisted rule is all-or-nothing. A changed wrapper, terminal or dependency
// must return to human review, never fall through to a less restrictive name guess.
export function reviewedCompendiumLink(
  tooltip: Tooltip,
  items: Record<string, CompendiumItem>,
  aliases: Aliases,
  data: CompendiumData,
  now: string,
  tooltips: Record<string, Tooltip>,
): CompendiumLink | undefined {
  const rule = reviewedCompendiumRules[tooltip.hash];
  if (!rule || tooltip.compendium) return undefined;
  const visited = new Set<string>();
  const active = new Set<string>();
  function visit(hash: string): boolean {
    if (active.has(hash)) return false;
    if (visited.has(hash)) return true;
    const expected = reviewedCompendiumNodes[hash];
    const item = items[hash];
    const current = hash === String(tooltip.hash) ? tooltip : tooltips[hash];
    if (
      !expected ||
      !item ||
      !current ||
      current.hash !== Number(hash) ||
      item.name !== expected.name ||
      item.categoryId !== expected.category ||
      current.text.en?.text !== expected.template ||
      resolveAlias(Number(hash), aliases) !== Number(hash)
    )
      return false;
    active.add(hash);
    // Exact templates bound wrapper semantics. Parse all imports as an additional
    // closure guard; no import flavor or partial wrapper implies equivalence.
    const imports = [...expected.template.matchAll(/^import\s+\S+\s+from\s+(\d+)\s*$/gm)].map(
      (m) => m[1],
    );
    if (JSON.stringify(imports) !== JSON.stringify(expected.imports)) return false;
    for (const dependency of imports) if (!visit(dependency)) return false;
    active.delete(hash);
    visited.add(hash);
    return true;
  }
  try {
    if (
      !visit(String(tooltip.hash)) ||
      visited.size !== rule.dependencies.length ||
      rule.dependencies.some((hash) => !visited.has(hash))
    )
      return undefined;
  } catch {
    return undefined;
  } // Alias cycles are unsupported evidence, never a link.
  const tab = data.tabs.find((tab) => tab.gid === rule.gid);
  if (!tab) return undefined;
  const rows = tab.rows.filter((row) => row.name === rule.rowKey && row.section === rule.section);
  if (rows.length !== 1 || !rows[0].anchor) return undefined;
  const row = rows[0];
  const cell = selectCompendiumCells(tab, row.anchor!, rule.cells);
  if (!cell || !sameCell(cell, row.cell)) return undefined;
  const link = snapshotCompendium({ tab, row: { ...row, cell }, cells: rule.cells }, now);
  const resolved = resolveCompendiumLink(link, data);
  if (
    !('row' in resolved) ||
    resolved.tab.gid !== tab.gid ||
    resolved.row.anchor?.row !== row.anchor?.row ||
    resolved.row.anchor?.col !== row.anchor?.col ||
    !sameCell(resolved.row.cell, cell)
  )
    return undefined;
  return link;
}
