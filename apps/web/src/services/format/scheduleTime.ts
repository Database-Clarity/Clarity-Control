/**
 * The schedule dialog's time rules (spec "Editor UX" Schedule dialog): a date and minute in a
 * chosen IANA zone become one UTC notBefore. A time the zone skips (DST gap) is refused; a time it
 * repeats (DST overlap) needs the offset chosen. Core `zonedToUtc` decides both; the Worker and
 * the publisher check the result again.
 */
import { checkNotBefore, zonedToUtc, zoneOffsetMinutes } from '@clarity/core/schedule';

/** "UTC+01:00", "UTC−03:30", "UTC" for offset minutes east of UTC. */
export function offsetLabel(minutes: number): string {
  if (minutes === 0) return 'UTC';
  const sign = minutes > 0 ? '+' : '−';
  const abs = Math.abs(minutes);
  return `UTC${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
}

/** "16:00 UTC" or "Wed 4 Dec 01:00 UTC" when the UTC day differs from the chosen local date. */
export function utcLabel(notBefore: string, localDate: string): string {
  const date = new Date(notBefore);
  const time = notBefore.slice(11, 16);
  if (notBefore.slice(0, 10) === localDate) return `${time} UTC`;
  const day = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'UTC',
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  }).format(date);
  return `${day.replace(',', '')} ${time} UTC`;
}

/** The wall date and minute of `instant` in `zone` ({date: YYYY-MM-DD, time: HH:MM}). */
export function wallClock(instant: number, zone: string): { date: string; time: string } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: zone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(new Date(instant))
      .map((part) => [part.type, part.value]),
  );
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${parts.hour}:${parts.minute}`,
  };
}

/** The dialog's starting point: the batch's time, else the next whole hour at least 10 min ahead. */
export function defaultTime(
  zone: string,
  notBefore: string | null,
  now: number = Date.now(),
): { date: string; time: string } {
  if (notBefore) return wallClock(Date.parse(notBefore), zone);
  const hour = 3_600_000;
  return wallClock(Math.ceil((now + 10 * 60_000) / hour) * hour, zone);
}

/** Every zone the runtime knows (UTC first, then the device zone), for the zone picker. */
export function zoneOptions(device: string): string[] {
  let all: string[] = [];
  try {
    all = Intl.supportedValuesOf('timeZone');
  } catch {
    all = [];
  }
  return [...new Set(['UTC', device, ...all].filter((zone) => zone && zone !== 'unknown'))];
}

export type TimeChoice =
  | { kind: 'invalid'; message: string }
  /** The zone skips this minute (clocks go forward). */
  | { kind: 'gap'; message: string }
  /** The zone repeats this minute: pick one (in time order). */
  | {
      kind: 'overlap';
      options: { notBefore: string; offsetMinutes: number }[];
      chosen: { notBefore: string; offsetMinutes: number } | null;
    }
  | { kind: 'exact'; notBefore: string; offsetMinutes: number };

/** Interprets the dialog's fields; `offset` is the chosen offset for a repeated hour. */
export function interpret(
  date: string,
  time: string,
  zone: string,
  offset: number | null,
): TimeChoice {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time))
    return { kind: 'invalid', message: 'Pick a date and a time.' };
  let result: ReturnType<typeof zonedToUtc>;
  try {
    result = zonedToUtc(date, time, zone);
  } catch (error) {
    return { kind: 'invalid', message: error instanceof Error ? error.message : String(error) };
  }
  if (result.status === 'gap')
    return {
      kind: 'gap',
      message: `${time} on ${date} does not exist in ${zone}: the clocks skip it. Pick another time.`,
    };
  if (result.status === 'overlap')
    return {
      kind: 'overlap',
      options: result.options,
      chosen: result.options.find((option) => option.offsetMinutes === offset) ?? null,
    };
  return { kind: 'exact', notBefore: result.notBefore, offsetMinutes: result.offsetMinutes };
}

/** The notBefore the dialog would send, or why it cannot send one yet. */
export function chosenNotBefore(
  choice: TimeChoice,
  now: number = Date.now(),
): { notBefore: string; offsetMinutes: number } | { error: string } {
  if (choice.kind === 'invalid' || choice.kind === 'gap') return { error: choice.message };
  const picked = choice.kind === 'exact' ? choice : choice.chosen;
  if (!picked) return { error: 'This time happens twice in this zone. Choose which one.' };
  const check = checkNotBefore(picked.notBefore, now);
  if (!check.ok) return { error: `${check.reason}.` };
  return picked;
}

/** The zone's offset at an instant (for the reschedule line). */
export const offsetAt = (notBefore: string, zone: string) =>
  zoneOffsetMinutes(Date.parse(notBefore), zone);
