// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import type { Tooltip } from '@clarity/core';
import type { Drafts } from '../../services/draftStorage';
import type { EditorData } from '../../stores/data';
import type { LostText } from '../lost-text/model';
import { fingerprint, recordKey } from '../lost-text/model';
import { archiveState, queueSources } from './sources';

const stamp = { updatedAt: '2026-01-01T00:00:00.000Z', updatedBy: 'x' };
const tip = (hash: number, change: Partial<Tooltip> = {}): Tooltip => ({
  hash,
  associated: [],
  text: { en: { text: '', ...stamp } },
  ...change,
});
const data = (tooltips: Tooltip[]) =>
  ({
    items: {},
    aliases: {},
    bundle: { tooltips: Object.fromEntries(tooltips.map((t) => [t.hash, t])) },
  }) as unknown as EditorData;
const draft = (next: Tooltip) => ({ [next.hash]: { base: next, next } }) as unknown as Drafts;

describe('completion hooks', () => {
  const record = {
    hash: 7,
    lang: 'en',
    name: 'Seven',
    text: 'Old text',
    clearingCommit: 'a'.repeat(40),
    lastNonemptyCommit: 'b'.repeat(40),
  } as LostText;
  const item = {
    key: recordKey(record),
    hash: 7,
    lang: 'en' as const,
    name: 'Seven',
    detail: record,
  };

  it('Lost text: done once the language has text (draft or saved) or the record is dismissed', () => {
    const context = { data: data([tip(7)]), user: null, decisions: {} };
    const done = queueSources['lost-text'].done(context);
    expect(done(item, {})).toBe(false);
    expect(done(item, draft(tip(7, { text: { en: { text: 'Recovered', ...stamp } } })))).toBe(true);
    const dismissed = queueSources['lost-text'].done({
      ...context,
      decisions: { [recordKey(record)]: fingerprint(record) },
    });
    expect(dismissed(item, {})).toBe(true);
  });

  it('Archive: done once an action is staged against how the item stood when the queue began', () => {
    const removed = tip(9);
    const done = queueSources.archive.done({ data: data([removed]), user: null, decisions: {} });
    const queued = { key: '9', hash: 9, name: 'Nine', detail: archiveState(removed) };
    expect(done(queued, {})).toBe(false);
    const confirmed = tip(9, {
      archive: {
        removedAt: '2026-01-02T00:00:00.000Z',
        lastSeen: { name: 'Nine', categoryId: 'perks' },
      },
    } as Partial<Tooltip>);
    expect(done(queued, draft(confirmed))).toBe(true);
    // Discarding the draft reopens it.
    expect(done(queued, {})).toBe(false);
  });
});
