import type { GlobalImpactRow, GlobalKind, GlobalRecord, GlobalReview, Lang } from '@clarity/core';

// S3's HTTP boundary. No transport is activated until S2/S5 and the owner gates pass.
export type EntryKind = GlobalKind;
export type GlobalActor = {
  role: 'trial' | 'translator' | 'editor' | 'maintainer';
  languages: Lang[];
} | null;
export type GlobalEntry = GlobalRecord;
/** S1 impact and review records, plus non-authoritative navigation/display metadata. */
export interface GlobalConsumer extends GlobalImpactRow {
  id: string;
  variant: number;
  name: string;
  category: string;
  line: number | null;
  path: string[] | null;
  direct: boolean | null;
  archived: boolean;
  review: GlobalReview;
  impactDigest: string;
  beforeSource: string;
  afterSource: string;
}
export interface GlobalSnapshot {
  head: string;
  entries: GlobalEntry[];
  impacts: Record<string, GlobalConsumer[]>;
  sourceBodies?: Record<string, Partial<Record<Lang, string>>>;
}
export type GlobalMutation =
  | { operation: 'create'; kind: EntryKind; name: string; lang: Lang; body: string }
  | { operation: 'edit'; id: string; revision: string; lang: Lang; body: string }
  | { operation: 'rename'; id: string; revision: string; name: string }
  | { operation: 'remove'; id: string; revision: string; lang?: Lang }
  | {
      operation: 'acknowledge';
      id: string;
      consumerId: string;
      contentDigest: string;
      dependencyDigest: string;
      impactDigest: string;
      decision: 'no-text-change';
    };
export type GlobalResult<T> =
  | { kind: 'ok'; value: T }
  | { kind: 'conflict'; message: string }
  | { kind: 'retry'; message: string }
  | { kind: 'invalid' | 'forbidden'; message: string };
export interface GlobalsService {
  read(): Promise<GlobalResult<GlobalSnapshot>>;
  mutate(request: {
    expectedHead: string;
    mutation: GlobalMutation;
  }): Promise<GlobalResult<GlobalSnapshot>>;
  impact(request: {
    expectedHead: string;
    id: string;
    revision: string;
    lang: Lang;
    body: string;
  }): Promise<GlobalResult<{ head: string; consumers: GlobalConsumer[] }>>;
}
export function globalReviewState(row: GlobalConsumer): 'required' | 'acknowledged' | 'stale' {
  const ack = row.review.acknowledgement;
  if (!ack) return 'required';
  return ack.contentDigest === row.review.contentDigest &&
    ack.dependencyDigest === row.review.dependencyDigest &&
    ack.impactDigest === row.impactDigest
    ? 'acknowledged'
    : 'stale';
}
export function canEditGlobal(actor: GlobalActor, lang: Lang) {
  return !!actor && (actor.role !== 'translator' || actor.languages.includes(lang));
}
export function canReviewGlobal(actor: GlobalActor, lang: Lang) {
  return (
    !!actor &&
    (actor.role === 'editor' ||
      actor.role === 'maintainer' ||
      (actor.role === 'translator' && lang !== 'en' && actor.languages.includes(lang)))
  );
}
