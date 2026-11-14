// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import type { Tooltip } from '@clarity/core';
import type { Drafts } from '../../services/draftStorage';
import type { EditorData } from '../../stores/data';
import type { LostText } from '../lost-text/model';
import { fingerprint, recordKey } from '../lost-text/model';
import { editorPath, withEditorPaths } from './editorPath';
import { archiveState, queueSources, reviewStamp } from './sources';

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

  it('Review: a markup-only save of the same length and time still counts as saved again', () => {
    const before = tip(5, {
      text: { en: { text: '<solar Scorch /> and <solar/>Scorch', ...stamp } },
    });
    const after = tip(5, {
      text: { en: { text: '<solar/>Scorch and <solar Scorch />', ...stamp } },
    });
    expect(after.text.en!.text.length).toBe(before.text.en!.text.length);
    const queued = { key: '5', hash: 5, name: 'Five', detail: reviewStamp(before, {}) };
    expect(
      queueSources.review.done({ data: data([before]), user: null, decisions: {} })(queued, {}),
    ).toBe(false);
    expect(
      queueSources.review.done({ data: data([after]), user: null, decisions: {} })(queued, {}),
    ).toBe(true);
    // An alias newly pointing here changes what a push publishes too.
    const aliased = {
      ...data([before]),
      aliases: { 6: { to: 5, kind: 'sandbox' } },
    } as unknown as EditorData;
    expect(queueSources.review.done({ data: aliased, user: null, decisions: {} })(queued, {})).toBe(
      true,
    );
  });
});

describe('editor paths', () => {
  const enhanced = {
    ...data([tip(10), tip(11)]),
    items: { 10: { hash: 10, name: 'Base' }, 11: { hash: 11, name: 'Enhanced', baseHash: 10 } },
  } as unknown as EditorData;

  it('opens an enhanced override on its base with the variant named (base 10, override 11)', () => {
    expect(editorPath(11, enhanced)).toBe('/t/10?variant=11');
    expect(editorPath(10, enhanced)).toBe('/t/10');
    expect(editorPath(11, enhanced, 'de')).toBe('/t/10?lang=de&variant=11');
  });

  it('every list source opens the override, not the base', () => {
    const lost = { key: 'k', hash: 11, lang: 'fr' as const, name: 'Enhanced' };
    const plain = { key: '11', hash: 11, name: 'Enhanced' };
    const [lostPath] = withEditorPaths('lost-text', [lost], enhanced);
    expect(queueSources['lost-text'].path(lostPath!)).toBe('/t/10?lang=fr&variant=11');
    expect(queueSources.drift.path(withEditorPaths('drift', [plain], enhanced)[0]!)).toBe(
      '/t/10?variant=11',
    );
    expect(queueSources.review.path(withEditorPaths('review', [plain], enhanced)[0]!)).toBe(
      '/t/10?variant=11',
    );
    // Archive opens its own page; Translations items carry their path already.
    expect(withEditorPaths('archive', [plain], enhanced)[0]).toBe(plain);
  });
});
