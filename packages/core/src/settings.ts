import { z } from 'zod';

/** True when `Intl` accepts the IANA zone name (or `UTC`). */
export function isTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

export const dateFormats = ['auto', 'dmy', 'iso', 'mdy'] as const;
export const timeDisplays = ['date', 'datetime', 'relative'] as const;

export const timeZoneSchema = z
  .string()
  .min(1)
  .max(64)
  .refine((value) => value === 'auto' || isTimeZone(value), 'Unknown time zone');

/**
 * Settings that follow a signed-in user across devices. The Worker stores them encrypted;
 * device-only settings (text size, layout) never use this schema.
 */
export const syncedSettingsSchema = z
  .object({
    dateFormat: z.enum(dateFormats),
    timeDisplay: z.enum(timeDisplays),
    timeZone: timeZoneSchema,
    markupToolbar: z.enum(['open', 'closed']),
    englishSource: z.enum(['changes', 'current']),
  })
  .strict();
export type SyncedSettings = z.infer<typeof syncedSettingsSchema>;

export const defaultSyncedSettings: SyncedSettings = {
  dateFormat: 'auto',
  timeDisplay: 'datetime',
  timeZone: 'auto',
  markupToolbar: 'open',
  englishSource: 'changes',
};

/** Largest accepted PUT /settings body; real payloads are ~150 bytes. */
export const settingsBodyLimit = 4096;
