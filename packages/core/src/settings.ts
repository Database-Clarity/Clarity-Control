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
export const editorFonts = ['default', 'fira-code', 'jetbrains-mono', 'system'] as const;
export const suggestAcceptKeys = ['enter', 'tab'] as const;
export const symbolRevealModes = ['popover', 'caret'] as const;
export const finderWheelModes = ['entries', 'groups'] as const;
export const defaultWorklistStepping = true;

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
    editorFont: z.enum(editorFonts).default('default'),
    suggestAccept: z.enum(suggestAcceptKeys).default('enter'),
    symbolReveal: z.enum(symbolRevealModes).default('popover'),
    finderWheel: z.enum(finderWheelModes).default('entries'),
    worklistStepping: z.boolean().default(defaultWorklistStepping),
    dateFormat: z.enum(dateFormats),
    timeDisplay: z.enum(timeDisplays),
    timeZone: timeZoneSchema,
    markupToolbar: z.enum(['open', 'closed']),
    englishSource: z.enum(['changes', 'current']),
  })
  .strict();
export type SyncedSettings = z.infer<typeof syncedSettingsSchema>;

export const defaultSyncedSettings: SyncedSettings = {
  editorFont: 'default',
  suggestAccept: 'enter',
  symbolReveal: 'popover',
  finderWheel: 'entries',
  worklistStepping: defaultWorklistStepping,
  dateFormat: 'auto',
  timeDisplay: 'datetime',
  timeZone: 'auto',
  markupToolbar: 'open',
  englishSource: 'changes',
};

/** Largest accepted PUT /settings body; real payloads are under 1 KB. */
export const settingsBodyLimit = 4096;
