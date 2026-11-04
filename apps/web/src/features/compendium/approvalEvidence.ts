import { compendiumCellSchema, type CompendiumMatch } from '@clarity/core';
import reviewed from './owner-reviewed.json';
import shipped from './approved-guidance.v1.json';

type Approval = { name: string; categoryId: string; gid: string; approvedSnapshot?: unknown };
const approvals: Record<string, Approval> = { ...reviewed.verified, ...reviewed.reapproved };

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
    const parsed = compendiumCellSchema.safeParse(approval.approvedSnapshot);
    if (parsed.success) return parsed.data;
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
  const parsed = compendiumCellSchema.safeParse(reference.link.snapshot);
  return parsed.success ? parsed.data : undefined;
}
