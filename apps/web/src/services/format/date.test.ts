import { describe, expect, it } from 'vitest';
import type { DateSettings } from './date';
import { exactDate, formatDate, unknownTime, zonedNotBefore } from './date';

const iso = '2023-02-12T20:12:00Z';
const settings = (
  dateFormat: DateSettings['dateFormat'],
  timeDisplay: DateSettings['timeDisplay'],
  timeZone = 'UTC',
): DateSettings => ({ dateFormat, timeDisplay, timeZone });

describe('formatDate', () => {
  it.each([
    ['dmy', 'date', 'UTC', '12 Feb 2023'],
    ['dmy', 'datetime', 'UTC', '12 Feb 2023, 20:12 UTC'],
    ['iso', 'date', 'UTC', '2023-02-12'],
    ['iso', 'datetime', 'UTC', '2023-02-12 20:12 UTC'],
    ['mdy', 'date', 'UTC', '02/12/2023'],
    ['mdy', 'datetime', 'UTC', '02/12/2023, 8:12 PM UTC'],
    // Time zones move the calendar day, not just the clock.
    ['dmy', 'datetime', 'Europe/Berlin', '12 Feb 2023, 21:12'],
    ['iso', 'datetime', 'Asia/Tokyo', '2023-02-13 05:12'],
    ['mdy', 'datetime', 'America/Los_Angeles', '02/12/2023, 12:12 PM'],
    ['dmy', 'date', 'Pacific/Kiritimati', '13 Feb 2023'],
  ] as const)('%s / %s / %s', (format, display, zone, expected) => {
    expect(formatDate(iso, settings(format, display, zone))).toBe(expected);
  });

  it('formats midnight as 00:00 and 12 AM', () => {
    const midnight = '2023-02-12T00:05:00Z';
    expect(formatDate(midnight, settings('iso', 'datetime'))).toBe('2023-02-12 00:05 UTC');
    expect(formatDate(midnight, settings('mdy', 'datetime'))).toBe('02/12/2023, 12:05 AM UTC');
  });

  it('uses Intl for auto in the given locale and zone', () => {
    const expected = new Intl.DateTimeFormat('en-GB', {
      dateStyle: 'medium',
      timeStyle: 'short',
      timeZone: 'Asia/Tokyo',
    }).format(new Date(iso));
    expect(formatDate(iso, settings('auto', 'datetime', 'Asia/Tokyo'), { locale: 'en-GB' })).toBe(
      expected,
    );
    expect(formatDate(iso, settings('auto', 'date', 'UTC'), { locale: 'en-US' })).toBe(
      'Feb 12, 2023',
    );
    // auto zone = browser zone
    expect(formatDate(iso, settings('auto', 'datetime', 'auto'))).toBe(
      new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(
        new Date(iso),
      ),
    );
  });

  it('formats relative times, with the exact date still available', () => {
    const now = Date.parse(iso);
    const relative = settings('dmy', 'relative');
    expect(formatDate(now - 3 * 86_400_000, relative, { now })).toBe('3 days ago');
    expect(formatDate(now - 2 * 3_600_000, relative, { now })).toBe('2 hours ago');
    expect(formatDate(now - 86_400_000, relative, { now })).toBe('yesterday');
    expect(formatDate(now - 400 * 86_400_000, relative, { now })).toBe('last year');
    expect(formatDate(now + 5 * 60_000, relative, { now })).toBe('in 5 minutes');
    expect(formatDate(now - 10_000, relative, { now })).toBe('this minute');
    expect(exactDate(now, relative)).toBe('12 Feb 2023, 20:12 UTC');
  });

  it('accepts numbers and dates, and reports invalid values', () => {
    expect(formatDate(Date.parse(iso), settings('iso', 'date'))).toBe('2023-02-12');
    expect(formatDate(new Date(iso), settings('iso', 'date'))).toBe('2023-02-12');
    for (const bad of ['not a date', '', undefined, null, NaN]) {
      expect(formatDate(bad, settings('dmy', 'datetime'))).toBe(unknownTime);
    }
  });
});

describe('zonedNotBefore', () => {
  const now = new Date('2026-11-14T00:00:00.000Z');
  it('shows the device zone, then UTC', () => {
    expect(zonedNotBefore('2026-12-03T16:00:00.000Z', now, 'Europe/Berlin')).toBe(
      'Thu 3 Dec 17:00 · 16:00 UTC',
    );
    expect(zonedNotBefore('2026-12-03T16:00:00.000Z', now, 'UTC')).toBe('Thu 3 Dec 16:00 UTC');
    expect(zonedNotBefore('2026-12-03T16:00:00.000Z', now, 'unknown')).toBe('Thu 3 Dec 16:00 UTC');
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
