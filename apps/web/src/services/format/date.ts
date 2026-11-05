import type { SyncedSettings } from '@clarity/core';

export type DateSettings = Pick<SyncedSettings, 'dateFormat' | 'timeDisplay' | 'timeZone'>;
export interface FormatOptions {
  /** Reference time for relative output (defaults to `Date.now()`). */
  now?: number;
  /** Locale for `auto` output; undefined uses the browser locale. */
  locale?: string;
}
export const unknownTime = 'unknown time';

const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const zone = (timeZone: string) => (timeZone === 'auto' ? undefined : timeZone);

const dateFormats = new Map<string, Intl.DateTimeFormat>();
function dateFormat(locale: string | undefined, options: Intl.DateTimeFormatOptions) {
  const key = JSON.stringify([locale, options]);
  let format = dateFormats.get(key);
  if (!format) {
    format = new Intl.DateTimeFormat(locale, options);
    if (dateFormats.size >= 32) dateFormats.delete(dateFormats.keys().next().value!);
    dateFormats.set(key, format);
  }
  return format;
}

export function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'unknown';
  } catch {
    return 'unknown';
  }
}

export function parseDate(value: string | number | Date | null | undefined): Date | null {
  if (value === null || value === undefined || value === '') return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function calendar(date: Date, timeZone: string) {
  const parts = dateFormat('en-US', {
    timeZone: zone(timeZone),
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    hourCycle: 'h23',
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((entry) => entry.type === type)?.value);
  return {
    year: part('year'),
    month: part('month'),
    day: part('day'),
    hour: part('hour'),
    minute: part('minute'),
  };
}

const pad = (value: number) => String(value).padStart(2, '0');

/** The date (and time) without relative wording, in the chosen format and zone. */
export function exactDate(
  value: string | number | Date | null | undefined,
  settings: DateSettings,
  options: FormatOptions = {},
): string {
  const date = parseDate(value);
  if (!date) return unknownTime;
  const withTime = settings.timeDisplay !== 'date';
  if (settings.dateFormat === 'auto') {
    return dateFormat(options.locale, {
      dateStyle: 'medium',
      ...(withTime ? { timeStyle: 'short' } : {}),
      timeZone: zone(settings.timeZone),
    }).format(date);
  }
  const { year, month, day, hour, minute } = calendar(date, settings.timeZone);
  const suffix = settings.timeZone === 'UTC' ? ' UTC' : '';
  if (settings.dateFormat === 'iso') {
    const text = `${year}-${pad(month)}-${pad(day)}`;
    return withTime ? `${text} ${pad(hour)}:${pad(minute)}${suffix}` : text;
  }
  if (settings.dateFormat === 'mdy') {
    const text = `${pad(month)}/${pad(day)}/${year}`;
    const twelve = hour % 12 === 0 ? 12 : hour % 12;
    return withTime
      ? `${text}, ${twelve}:${pad(minute)} ${hour < 12 ? 'AM' : 'PM'}${suffix}`
      : text;
  }
  const text = `${day} ${months[month - 1]} ${year}`;
  return withTime ? `${text}, ${pad(hour)}:${pad(minute)}${suffix}` : text;
}

const units: [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 365 * 86_400_000],
  ['month', 30 * 86_400_000],
  ['week', 7 * 86_400_000],
  ['day', 86_400_000],
  ['hour', 3_600_000],
  ['minute', 60_000],
];

/** Shared formatter for every rendered date; settings come from the settings store. */
export function formatDate(
  value: string | number | Date | null | undefined,
  settings: DateSettings,
  options: FormatOptions = {},
): string {
  const date = parseDate(value);
  if (!date) return unknownTime;
  if (settings.timeDisplay !== 'relative') return exactDate(date, settings, options);
  const difference = date.getTime() - (options.now ?? Date.now());
  const format = new Intl.RelativeTimeFormat(
    settings.dateFormat === 'auto' ? options.locale : 'en',
    { numeric: 'auto' },
  );
  for (const [unit, size] of units) {
    if (Math.abs(difference) >= size) return format.format(Math.round(difference / size), unit);
  }
  return format.format(0, 'minute');
}
