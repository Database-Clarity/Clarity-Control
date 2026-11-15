/** Verified consumer assets. TODO: the owner must supply the two missing assets before cut-over. */
export const prismaticAssets = {
  dim: '\u{F0156}',
  vaultZero: '[Prismatic]',
  braytech: null as string | null,
  crayon: null as string | null,
};

/** CUTOVER-PRISMATIC: an explicit release gate, separate from ordinary legacy builds. */
export function assertPrismaticReady(): void {
  const missing = (['braytech', 'crayon'] as const).filter((name) => !prismaticAssets[name]);
  if (missing.length)
    throw new Error(`CUTOVER-PRISMATIC: missing verified assets: ${missing.join(', ')}`);
}
