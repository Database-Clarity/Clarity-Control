import { notBeforeSchema, scheduleLimits } from './schemas.js';

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(zone: string): Intl.DateTimeFormat {
  let format = formatters.get(zone);
  if (!format) {
    format = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(zone, format);
  }
  return format;
}

/** Whether the runtime knows `zone` as an IANA time zone. */
export function isValidZone(zone: string): boolean {
  try {
    formatter(zone);
    return true;
  } catch {
    return false;
  }
}

/** Wall clock of `instant` in `zone`, encoded as if it were UTC (ms). */
function wallTime(instant: number, zone: string): number {
  const parts: Record<string, number> = {};
  for (const part of formatter(zone).formatToParts(new Date(instant)))
    if (part.type !== 'literal') parts[part.type] = Number(part.value);
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
}

/** UTC offset of `zone` at `instant`, in minutes east of UTC (e.g. 60 for Europe/Berlin in winter). */
export function zoneOffsetMinutes(instant: number, zone: string): number {
  const second = Math.floor(instant / 1000) * 1000;
  return Math.round((wallTime(second, zone) - second) / 60_000);
}

export type ZonedTime =
  /** The local time exists once. */
  | { status: 'exact'; notBefore: string; offsetMinutes: number }
  /** It exists twice (a repeated hour): ask which offset; options are in time order. */
  | { status: 'overlap'; options: { notBefore: string; offsetMinutes: number }[] }
  /** It does not exist (skipped by a DST change): refuse. */
  | { status: 'gap' };

const dateRe = /^(\d{4})-(\d{2})-(\d{2})$/;
const timeRe = /^(\d{2}):(\d{2})$/;

/**
 * A minute in an IANA zone (date `YYYY-MM-DD`, time `HH:MM`, 24 h) to its UTC notBefore,
 * handling DST gaps (no such local time) and overlaps (two instants). Throws on a malformed
 * date or time, or an unknown zone.
 */
export function zonedToUtc(date: string, time: string, zone: string): ZonedTime {
  const d = dateRe.exec(date);
  const t = timeRe.exec(time);
  if (!d || !t) throw new Error('Expected YYYY-MM-DD and HH:MM');
  const [year, month, day, hour, minute] = [d[1], d[2], d[3], t[1], t[2]].map(Number);
  const local = Date.UTC(year, month - 1, day, hour, minute);
  const check = new Date(local);
  if (
    hour > 23 ||
    minute > 59 ||
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== month - 1 ||
    check.getUTCDate() !== day
  )
    throw new Error(`Not a real date and time: ${date} ${time}`);
  if (!isValidZone(zone)) throw new Error(`Unknown time zone: ${zone}`);
  // Offsets in force around the wall time; a zone changes offset at most once in a day.
  const candidates = new Set(
    [-86_400_000, 0, 86_400_000].map((shift) => zoneOffsetMinutes(local + shift, zone)),
  );
  const options = [...candidates]
    .map((offsetMinutes) => ({ instant: local - offsetMinutes * 60_000, offsetMinutes }))
    .filter(({ instant, offsetMinutes }) => zoneOffsetMinutes(instant, zone) === offsetMinutes)
    .filter(({ instant }) => wallTime(instant, zone) === local)
    .sort((a, b) => a.instant - b.instant)
    .map(({ instant, offsetMinutes }) => ({
      notBefore: new Date(instant).toISOString(),
      offsetMinutes,
    }));
  if (options.length === 0) return { status: 'gap' };
  if (options.length === 1) return { status: 'exact', ...options[0] };
  return { status: 'overlap', options };
}

/**
 * Admission bounds for a requested notBefore (spec "Publication path" 1): at least 3 minutes and
 * at most 366 days after `now`. 'now' (publish now) is the caller's: it schedules at the
 * current minute.
 */
export function checkNotBefore(
  notBefore: string,
  now: number,
): { ok: true } | { ok: false; reason: string } {
  if (!notBeforeSchema.safeParse(notBefore).success)
    return { ok: false, reason: 'Not a whole UTC minute' };
  const time = Date.parse(notBefore);
  if (time < now + scheduleLimits.minLeadMs)
    return { ok: false, reason: 'Pick a time at least 3 minutes ahead' };
  if (time > now + scheduleLimits.maxLeadMs)
    return { ok: false, reason: 'Pick a time within 366 days' };
  return { ok: true };
}

/** The UTC minute at or before `now`, as a notBefore ('Publish now'). */
export function nowMinute(now: number): string {
  return new Date(Math.floor(now / 60_000) * 60_000).toISOString();
}
