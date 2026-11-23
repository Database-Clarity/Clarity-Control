import {
  compendiumCellSchema,
  normaliseCompendiumName,
  resolveCompendiumLink,
  type CompendiumCell,
  type CompendiumData,
  type CompendiumLink,
  type CompendiumMatch,
} from '@clarity/core';
import reviewed from './owner-reviewed.json';
import shipped from './approved-guidance.v1.json';
import { sourceFingerprint } from './reviewProgress';
import { sourceNeedsUpdate } from './tracking';

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
  const reference = shippedReference(hash, categoryId);
  if (
    reference?.name !== name ||
    reference.link?.gid !== match.tab.gid ||
    reference.link.rowKey !== match.row.name ||
    reference.link.setBonusPieces !== match.setBonusPieces
  )
    return;
  return approvalCell(reference.link.snapshot);
}

interface Proof {
  gid: string;
  name: string;
  categoryId: string;
  mode?: string;
  rows: { name: string; cellEvidence: string }[];
}
const proofs: Record<string, Proof> = {
  ...reviewed.verified,
  ...Object.fromEntries(
    Object.entries(reviewed.reapproved).map(([hash, record]) => [
      hash,
      { ...record, rows: [record] },
    ]),
  ),
};

/** Whether the approved rows are still the source, as reviewedOwnerDecision reads them. */
function proofHolds({ gid, mode, rows: approved }: Proof, source: CompendiumData) {
  const key = (name: string, evidence: string) => JSON.stringify([name, evidence]);
  const name = normaliseCompendiumName(approved[0].name);
  const now = (source.tabs.find((tab) => tab.gid === gid)?.rows ?? [])
    .filter((row) => row.nameNorm === name)
    .map((row) => key(row.name, sourceFingerprint(row.cell)));
  const then = approved.map((row) => key(row.name, row.cellEvidence));
  // A verified source is all of its rows; a re-approved row or armour card is the one named.
  return mode === 'multi' || mode === 'single'
    ? now.length === then.length && now.sort().join() === then.sort().join()
    : now.includes(then[0]);
}

/** The link the owner approved for this entry, as it was then. */
export function approvedLink({
  hash,
  name,
  category,
}: {
  hash: number;
  name: string;
  category: string;
}): CompendiumLink | undefined {
  const reference = shippedReference(hash, category);
  return reference?.name === name ? reference.link : undefined;
}

/** Whether the owner approved a link for this entry whose source cells are no longer the same. */
export function approvedSourceChanged(
  entry: { hash: number; name: string; category: string },
  source: CompendiumData,
): boolean {
  const proof = proofs[entry.hash];
  if (proof?.name === entry.name && proof.categoryId === `catalog:${entry.category}`)
    return !proofHolds(proof, source);
  const link = approvedLink(entry);
  return !!link && sourceNeedsUpdate(resolveCompendiumLink(link, source));
}

function shippedReference(hash: number, categoryId: string) {
  const category = shipped.categories[`catalog:${categoryId}` as keyof typeof shipped.categories];
  return (
    category?.references as
      | Record<
          string,
          {
            name: string;
            link?: CompendiumLink;
          }
        >
      | undefined
  )?.[hash];
}

/**
 * Whether an entry has approval evidence its matched row may be compared with, before that row
 * is known. Loading geometry only: the row still decides whether the evidence applies.
 */
export function mayHaveApprovalEvidence(hash: number, name: string, categoryId: string) {
  const approval = approvals[hash];
  if (
    approval?.name === name &&
    approval.categoryId === `catalog:${categoryId}` &&
    approval.approvedSnapshot
  )
    return true;
  const reference = shippedReference(hash, categoryId);
  return reference?.name === name && !!reference.link?.snapshot;
}
