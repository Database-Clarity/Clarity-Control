import type { SyncedSettings } from '@clarity/core';
import type { SettingsState, SyncedKey } from '../../stores/settings';
import { browserTimeZone } from '../../services/format/date';
import type { ThemePreference } from '../../ui/theme';

export { browserTimeZone };

export const themeLabels: Record<ThemePreference, string> = {
  system: 'Match system',
  light: 'Light',
  dark: 'Dark',
};

export const settingLabels: Record<SyncedKey, string> = {
  dateFormat: 'Date format',
  timeDisplay: 'Time display',
  timeZone: 'Time zone',
  markupToolbar: 'Markup row',
  englishSource: 'English source shows',
};

const valueLabels: { [K in SyncedKey]: Record<string, string> } = {
  dateFormat: {
    auto: 'Browser default',
    dmy: 'DD Mon YYYY (12 Feb 2023)',
    iso: 'YYYY-MM-DD (2023-02-12)',
    mdy: 'MM/DD/YYYY (02/12/2023)',
  },
  timeDisplay: {
    date: 'Date only',
    datetime: 'Date and time',
    relative: 'Relative ("3 days ago"), exact on hover',
  },
  timeZone: { UTC: 'UTC' },
  markupToolbar: { open: 'Open by default', closed: 'Closed by default' },
  englishSource: { changes: 'Changes since the translation', current: 'Current English' },
};

export function valueLabel<K extends SyncedKey>(key: K, value: SyncedSettings[K]): string {
  if (key === 'timeZone' && value === 'auto') return `Browser time zone (${browserTimeZone()})`;
  return valueLabels[key][value] ?? value;
}

export function syncStatusText(state: Pick<SettingsState, 'status' | 'reason' | 'error'>): string {
  switch (state.status) {
    case 'device':
      return state.reason === 'signed-out'
        ? 'Saved on this device. Sign in to sync dates and editor settings to your account.'
        : state.reason === 'no-role'
          ? 'Saved on this device only. Syncing needs an editing role.'
          : 'Saved on this device only (sync is not configured).';
    case 'loading':
      return 'Saved on this device. Checking your synced settings...';
    case 'synced':
      return 'Saved on this device and synced to your account.';
    case 'unsynced':
      return 'Saved on this device. Syncs to your account when you leave Settings.';
    case 'syncing':
      return 'Saved on this device. Syncing to your account...';
    case 'error':
      return `Not synced: ${state.error}. Your changes are kept on this device.`;
    case 'choice':
      return 'This device and your account have different settings. Choose which to keep.';
  }
}
