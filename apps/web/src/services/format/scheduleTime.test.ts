import { describe, expect, it } from 'vitest';
import {
  chosenNotBefore,
  defaultTime,
  interpret,
  offsetLabel,
  utcLabel,
  wallClock,
  zoneOptions,
} from './scheduleTime';

const now = Date.parse('2026-11-13T12:00:00.000Z');

describe('schedule dialog time rules', () => {
  it('turns a zoned minute into its UTC notBefore with the offset', () => {
    const choice = interpret('2026-12-03', '17:00', 'Europe/Berlin', null);
    expect(choice).toEqual({
      kind: 'exact',
      notBefore: '2026-12-03T16:00:00.000Z',
      offsetMinutes: 60,
    });
    expect(chosenNotBefore(choice, now)).toMatchObject({
      notBefore: '2026-12-03T16:00:00.000Z',
      offsetMinutes: 60,
    });
    expect(offsetLabel(60)).toBe('UTC+01:00');
    expect(offsetLabel(-210)).toBe('UTC−03:30');
    expect(offsetLabel(0)).toBe('UTC');
    expect(utcLabel('2026-12-03T16:00:00.000Z', '2026-12-03')).toBe('16:00 UTC');
  });

  it('names the UTC day when it differs from the chosen date', () => {
    const choice = interpret('2026-12-03', '20:00', 'America/Los_Angeles', null);
    expect(choice).toMatchObject({ kind: 'exact', notBefore: '2026-12-04T04:00:00.000Z' });
    expect(utcLabel('2026-12-04T04:00:00.000Z', '2026-12-03')).toBe('Fri 4 Dec 04:00 UTC');
  });

  it('refuses a time the zone skips (DST gap)', () => {
    // Berlin skips 02:00-03:00 on 28 March 2027.
    const choice = interpret('2027-03-28', '02:30', 'Europe/Berlin', null);
    expect(choice.kind).toBe('gap');
    const result = chosenNotBefore(choice, now);
    expect('error' in result && result.error).toContain('does not exist in Europe/Berlin');
  });

  it('asks which offset for a repeated hour, then takes the chosen one', () => {
    // Berlin repeats 02:00-03:00 on 31 October 2027 (CEST, then CET).
    const open = interpret('2027-10-31', '02:30', 'Europe/Berlin', null);
    expect(open).toMatchObject({
      kind: 'overlap',
      options: [
        { notBefore: '2027-10-31T00:30:00.000Z', offsetMinutes: 120 },
        { notBefore: '2027-10-31T01:30:00.000Z', offsetMinutes: 60 },
      ],
      chosen: null,
    });
    const unchosen = chosenNotBefore(open, now);
    expect('error' in unchosen && unchosen.error).toContain('happens twice');
    expect(
      chosenNotBefore(interpret('2027-10-31', '02:30', 'Europe/Berlin', 60), now),
    ).toMatchObject({
      notBefore: '2027-10-31T01:30:00.000Z',
      offsetMinutes: 60,
    });
  });

  it('applies the admission bounds: at least 3 minutes ahead, within 366 days', () => {
    const soon = chosenNotBefore(interpret('2026-11-13', '12:02', 'UTC', null), now);
    expect('error' in soon && soon.error).toBe('Pick a time at least 3 minutes ahead.');
    const far = chosenNotBefore(interpret('2027-11-15', '12:00', 'UTC', null), now);
    expect('error' in far && far.error).toBe('Pick a time within 366 days.');
    expect(chosenNotBefore(interpret('2026-11-13', '12:03', 'UTC', null), now)).toMatchObject({
      notBefore: '2026-11-13T12:03:00.000Z',
    });
  });

  it('rejects malformed input instead of guessing', () => {
    expect(interpret('', '17:00', 'UTC', null).kind).toBe('invalid');
    expect(interpret('2026-02-30', '17:00', 'UTC', null).kind).toBe('invalid');
    expect(interpret('2026-12-03', '17:00', 'Not/AZone', null).kind).toBe('invalid');
  });

  it('starts on the batch time in the zone, else the next whole hour 10+ minutes ahead', () => {
    expect(defaultTime('Europe/Berlin', '2026-12-03T16:00:00.000Z', now)).toEqual({
      date: '2026-12-03',
      time: '17:00',
    });
    expect(defaultTime('UTC', null, Date.parse('2026-11-13T12:55:00.000Z'))).toEqual({
      date: '2026-11-13',
      time: '14:00',
    });
    expect(wallClock(Date.parse('2026-11-13T23:30:00.000Z'), 'Asia/Tokyo')).toEqual({
      date: '2026-11-14',
      time: '08:30',
    });
  });

  it('lists UTC and the device zone first', () => {
    const zones = zoneOptions('Europe/Berlin');
    expect(zones.slice(0, 2)).toEqual(['UTC', 'Europe/Berlin']);
    expect(new Set(zones).size).toBe(zones.length);
  });
});
