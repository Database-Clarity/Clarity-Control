import { globalSourcesSchema, type GlobalSources } from './model.js';

export interface GlobalPublicationConsumer {
  hash: number;
  lang: string;
  destination: string;
}
export const publicationSyncPendingCode = 'publication-sync-pending';
export const publicationSourcesPath = (destination: string) =>
  `globals/proofs/publication-sources/${destination}.json`;

/** S5's bounded authenticated adapter supplies current identities and certificates.
 * Never accept this object from an HTTP request or a stored sources manifest.
 */
export type GlobalPublicationRead = (
  head: string,
  consumers: readonly GlobalPublicationConsumer[],
) => Promise<{
  sources: GlobalSources;
  sync: unknown;
  /** Last materialized sources. Used only to explain a refusal. */
  materializedSources?: unknown;
  certificates: unknown[];
}>;

export function sameGlobalSources(a: GlobalSources, b: GlobalSources): boolean {
  return Object.keys(globalSourcesSchema.shape).every(
    (key) => a[key as keyof GlobalSources] === b[key as keyof GlobalSources],
  );
}
