/**
 * Pure helpers for the Batches subview: per-member state against current saved, list counts,
 * status wording, and event labels. Nothing here fetches; the store hands in what it read.
 */
import { languages, type Lang, type Tooltip } from '@clarity/core';
import {
  activate,
  changedFields,
  existsField,
  isOpenStatus,
  scheduleLimits,
  type ActivationConflict,
  type Batch,
  type BatchMember,
  type BatchStatus,
  type ScheduleIndex,
} from '@clarity/core/schedule';
import { languageLabel } from '../../../languageLabels';
import { upcomingOf } from '../../tooltip/UpcomingSwitch.load';

export type IndexEntry = ScheduleIndex['batches'][number];

export interface MemberView {
  member: BatchMember;
  /** Current saved now (null: absent). */
  current: Tooltip | null;
  /** Every batch-changed field (the publish delta). */
  changed: string[];
  /** Non-translation fields current moved under the batch (Q4: translations never block). */
  stale: string[];
  /** C4: never published, so the whole tooltip publishes. */
  first: boolean;
  /** What current becomes when the batch activates (stale fields: the batch value). */
  upcoming: Tooltip;
}

export function memberView(
  member: BatchMember,
  current: Tooltip | null,
  pushed: boolean,
): MemberView {
  const result = activate({ base: member.base, current, proposed: member.proposed });
  const { tooltip } = upcomingOf(member, current);
  return {
    member,
    current,
    changed: changedFields(member.base, member.proposed),
    stale: result.ok ? [] : result.fields,
    first: !pushed,
    upcoming: tooltip,
  };
}

/** English changed in the batch: the members whose translations the batch should carry. */
export function englishChanged(member: BatchMember): boolean {
  return member.base?.text.en?.text !== member.proposed.text.en?.text;
}

/**
 * Upcoming translation coverage: per member whose English the batch changes, each other language
 * is ready when its upcoming text was written against the batch English (sourceUpdatedAt).
 */
export function translationCoverage(members: readonly BatchMember[]): {
  ready: number;
  needed: number;
} {
  let ready = 0;
  let needed = 0;
  for (const member of members) {
    const english = member.proposed.text.en;
    if (!english || !englishChanged(member)) continue;
    for (const lang of languages) {
      if (lang === 'en') continue;
      needed++;
      if (member.proposed.text[lang]?.sourceUpdatedAt === english.updatedAt) ready++;
    }
  }
  return { ready, needed };
}

export const statusLabel: Record<BatchStatus, string> = {
  draft: 'Draft',
  scheduled: 'Scheduled',
  publishing: 'Publishing',
  published: 'Published',
  cancelled: 'Cancelled',
};

export type Tone = 'idle' | 'busy' | 'ok' | 'warn' | 'bad';

export const statusTone: Record<BatchStatus, Tone> = {
  draft: 'idle',
  scheduled: 'busy',
  publishing: 'busy',
  published: 'ok',
  cancelled: 'idle',
};

/** Overdue: past notBefore + 5 min and not terminal (spec "Editor UX" Status; Kick). */
export function isOverdue(
  entry: Pick<IndexEntry, 'status' | 'notBefore'>,
  now: number = Date.now(),
): boolean {
  return (
    (entry.status === 'scheduled' || entry.status === 'publishing') &&
    entry.notBefore !== null &&
    now > Date.parse(entry.notBefore) + scheduleLimits.overdueMs
  );
}

/** Open batches first (soonest time first, untimed drafts last), then terminal, newest first. */
export function orderBatches(entries: readonly IndexEntry[]): IndexEntry[] {
  const open = entries.filter((entry) => isOpenStatus(entry.status));
  const closed = entries.filter((entry) => !isOpenStatus(entry.status));
  open.sort((a, b) =>
    a.notBefore === b.notBefore
      ? a.name.localeCompare(b.name)
      : a.notBefore === null
        ? 1
        : b.notBefore === null
          ? -1
          : a.notBefore < b.notBefore
            ? -1
            : 1,
  );
  closed.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
  return [...open, ...closed];
}

/** "English", "German", "associations", "existence"... */
export function fieldLabel(field: string): string {
  if (field === existsField) return 'existence';
  if (field.startsWith('text.')) {
    const lang = field.slice(5);
    return (languages as readonly string[]).includes(lang) ? languageLabel(lang as Lang) : field;
  }
  if (field === 'associated') return 'associations';
  if (field === 'custom') return 'custom name';
  if (field === 'bungieSnapshot') return 'Bungie text';
  return field;
}

export const fieldList = (fields: readonly string[]) => fields.map(fieldLabel).join(', ');

const eventWords: Record<Batch['events'][number]['action'], string> = {
  create: 'created the batch',
  rename: 'renamed it',
  save: 'saved changes',
  rebase: 'rebased',
  remove: 'removed tooltips',
  schedule: 'scheduled it',
  reschedule: 'rescheduled it',
  unschedule: 'unscheduled it',
  cancel: 'cancelled it',
  claim: 'publishing started',
  published: 'published',
  unchanged: 'published (nothing changed live)',
  stale: 'run stopped: current changed',
  rejected: 'run rejected',
  superseded: 'run superseded',
  resolve: 'resolved an activation conflict',
};
export const eventLabel = (action: Batch['events'][number]['action']) => eventWords[action];

/** Batch events carry the publisher's actions under its App login; people get an @. */
export const actor = (login: string) => (login.endsWith('[bot]') ? login : `@${login}`);

const resultWords: Record<NonNullable<Batch['result']>['status'], string> = {
  published: 'Published',
  unchanged: 'Published; nothing changed live',
  stale: 'Current changed under the batch',
  rejected: 'Rejected by the publisher',
  superseded: 'Superseded by a newer schedule',
};
export const resultLabel = (status: NonNullable<Batch['result']>['status']) => resultWords[status];

/** A failed run's per-hash outcomes, as one line each ("123 stale: English, associations"). */
export function outcomeLines(result: NonNullable<Batch['result']>): string[] {
  return (result.outcomes ?? [])
    .filter((outcome) => outcome.status !== 'published' && outcome.status !== 'unchanged')
    .map((outcome) => {
      const fields = Array.isArray(outcome.fields)
        ? (outcome.fields as unknown[]).filter(
            (field): field is string => typeof field === 'string',
          )
        : [];
      const reason = typeof outcome.reason === 'string' ? outcome.reason : '';
      return `${outcome.hash} ${outcome.status}${fields.length ? `: ${fieldList(fields)}` : ''}${reason ? ` (${reason})` : ''}`;
    });
}

/** Activation conflicts the batch still has (only published batches carry them). */
export const openConflicts = (conflicts: readonly (ActivationConflict | null)[]) =>
  conflicts.filter((conflict): conflict is ActivationConflict => conflict !== null);
