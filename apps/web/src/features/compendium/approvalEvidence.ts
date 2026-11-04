import { compendiumCellSchema, type CompendiumCell, type CompendiumMatch } from '@clarity/core';
import reviewed from './owner-reviewed.json';
import shipped from './approved-guidance.v1.json';

type Approval = { name: string; categoryId: string; gid: string; approvedSnapshot?: unknown };
const approvals: Record<string, Approval> = { ...reviewed.verified, ...reviewed.reapproved };
const cells = new WeakMap<object, CompendiumCell>();
function approvalCell(input: unknown) {
  if (!input || typeof input !== 'object') return;
  const cached = cells.get(input);
  if (cached) return cached;
  const parsed = compendiumCellSchema.safeParse(input);
  if (!parsed.success) return;
  cells.set(input, parsed.data);
  return parsed.data;
}

/** Read-only comparison evidence; never creates a tooltip snapshot or approval. */
export function approvalEvidence(
  hash: number,
  name: string,
  categoryId: string,
  match: CompendiumMatch,
) {
  const approval = approvals[hash];
  if (
    approval?.name === name &&
    approval.categoryId === `catalog:${categoryId}` &&
    approval.gid === match.tab.gid &&
    approval.name === match.row.name &&
    approval.approvedSnapshot
  ) {
    const cell = approvalCell(approval.approvedSnapshot);
    if (cell) return cell;
  }
  const category = shipped.categories[`catalog:${categoryId}` as keyof typeof shipped.categories];
  const reference = (
    category?.references as
      | Record<
          string,
          {
            name: string;
            link?: { gid: string; rowKey: string; snapshot: unknown; setBonusPieces?: number };
          }
        >
      | undefined
  )?.[hash];
  if (
    reference?.name !== name ||
    reference.link?.gid !== match.tab.gid ||
    reference.link.rowKey !== match.row.name ||
    reference.link.setBonusPieces !== match.setBonusPieces
  )
    return;
  return approvalCell(reference.link.snapshot);
}
