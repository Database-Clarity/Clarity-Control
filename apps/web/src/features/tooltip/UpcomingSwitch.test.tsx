import { describe, expect, it } from 'vitest';
import type { Tooltip } from '@clarity/core';
import type { BatchMember } from '@clarity/core/schedule';
import { upcomingOf } from './UpcomingSwitch.load';
import { zonedNotBefore } from './UpcomingSwitch';

const stamp = { updatedAt: '2026-11-01T00:00:00.000Z', updatedBy: 'a' };
const tooltip = (en: string, extra: Partial<Record<'de' | 'fr', string>> = {}): Tooltip => ({
  hash: 10,
  associated: [],
  text: {
    en: { text: en, ...stamp },
    ...Object.fromEntries(
      Object.entries(extra).map(([lang, text]) => [
        lang,
        { text, ...stamp, sourceUpdatedAt: stamp.updatedAt },
      ]),
    ),
  },
});
const member = (base: Tooltip | null, proposed: Tooltip): BatchMember => ({
  hash: 10,
  base,
  baseCommit: 'a'.repeat(40),
  proposed,
  updatedAt: '2026-11-13T12:00:00.000Z',
  updatedBy: 'm',
});

describe('upcomingOf (activation preview)', () => {
  it('applies the batch fields over current saved and keeps what the batch did not change', () => {
    const result = upcomingOf(
      member(tooltip('Old'), tooltip('New')),
      tooltip('Old', { de: 'Alt' }),
    );
    expect(result.stale).toEqual([]);
    expect(result.tooltip.text.en?.text).toBe('New');
    expect(result.tooltip.text.de?.text).toBe('Alt');
  });

  it('marks a field current changed under the batch as stale and shows the batch value', () => {
    const result = upcomingOf(member(tooltip('Old'), tooltip('New')), tooltip('Changed'));
    expect(result.stale).toEqual(['text.en']);
    expect(result.tooltip.text.en?.text).toBe('New');
  });

  it('takes an upcoming translation even when current changed it meanwhile (Q4)', () => {
    const result = upcomingOf(
      member(tooltip('Old', { de: 'Alt' }), tooltip('Old', { de: 'Neu' })),
      tooltip('Old', { de: 'Anders' }),
    );
    expect(result.stale).toEqual([]);
    expect(result.tooltip.text.de?.text).toBe('Neu');
  });

  it('follows the existence rule', () => {
    expect(upcomingOf(member(null, tooltip('Created')), null)).toEqual({
      tooltip: tooltip('Created'),
      stale: [],
    });
    const raced = upcomingOf(member(null, tooltip('Mine')), tooltip('Theirs', { fr: 'Le leur' }));
    expect(raced.stale).toEqual(['$exists']);
    expect(raced.tooltip.text.en?.text).toBe('Mine');
    const deleted = upcomingOf(member(tooltip('Old'), tooltip('New')), null);
    expect(deleted).toEqual({ tooltip: tooltip('New'), stale: ['$exists'] });
  });
});

describe('zonedNotBefore', () => {
  const now = new Date('2026-11-14T00:00:00.000Z');
  it('shows the device zone, then UTC', () => {
    expect(zonedNotBefore('2026-12-03T16:00:00.000Z', now, 'Europe/Berlin')).toBe(
      'Thu 3 Dec 17:00 · 16:00 UTC',
    );
    expect(zonedNotBefore('2026-12-03T16:00:00.000Z', now, 'UTC')).toBe('Thu 3 Dec 16:00 UTC');
  });
  it('names the UTC day when it differs, and the year outside this one', () => {
    expect(zonedNotBefore('2026-12-03T23:30:00.000Z', now, 'Asia/Tokyo')).toBe(
      'Fri 4 Dec 08:30 · Thu 3 Dec 23:30 UTC',
    );
    expect(zonedNotBefore('2027-01-05T09:00:00.000Z', now, 'Europe/Berlin')).toBe(
      'Tue 5 Jan 2027 10:00 · 09:00 UTC',
    );
  });
});
