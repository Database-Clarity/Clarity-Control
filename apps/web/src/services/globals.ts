import type { Lang } from '@clarity/core';

// S3's HTTP boundary. No transport is activated until S2/S5 and the owner gates pass.
// Reconcile these local entry types with S1's frozen model before integration.
export type EntryKind = 'variable' | 'title';
export type GlobalActor = {
  role: 'trial' | 'translator' | 'editor' | 'maintainer';
  languages: Lang[];
} | null;
export interface GlobalEntry {
  id: string;
  kind: EntryKind;
  name: string;
  revision: string;
  definitions: Partial<
    Record<Lang, { body: string; revision: string; sourceRevision?: string; sourceBody?: string }>
  >;
}
export interface GlobalConsumer {
  id: string;
  hash: number;
  variant: number;
  name: string;
  category: string;
  lang: Lang;
  destination: string;
  line: number;
  path: string[];
  direct: boolean;
  archived: boolean;
  contentRevision: string;
  dependencyDigest: string;
  causes: { globalId: string; beforeRevision: string; afterRevision: string }[];
  review: 'required' | 'acknowledged' | 'stale';
  // Server-resolved markup for this exact impact revision, not today's globals.
  before: { source: string; resolved: string };
  after: { source: string; resolved: string };
}
export interface GlobalSnapshot {
  head: string;
  entries: GlobalEntry[];
  impacts: Record<string, GlobalConsumer[]>;
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
      contentRevision: string;
      dependencyDigest: string;
      decision: 'no-text-change-needed';
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
