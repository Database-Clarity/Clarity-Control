import { useMemo, useState } from 'react';
import { dateFormats, timeDisplays, type SyncedSettings } from '@clarity/core';
import {
  useSettingsStore,
  editorFonts,
  uiScaleMax,
  uiScaleMin,
  uiScaleStep,
} from '../../stores/settings';
import { themePreferences, type ThemePreference } from '../../ui/theme';
import { exactDate, formatDate } from '../../services/format/date';
import { browserTimeZone, syncStatusText, themeLabels, valueLabel } from './labels';
import { SettingsChoice } from './SettingsChoice';
import styles from './Settings.module.scss';

const example = '2023-02-12T20:12:00Z';

function timeZones(): string[] {
  try {
    return Intl.supportedValuesOf('timeZone').filter((zone) => zone !== 'UTC');
  } catch {
    return ['Europe/London', 'Europe/Berlin', 'America/New_York', 'America/Los_Angeles'];
  }
}

export function SettingsContent() {
  const state = useSettingsStore();
  const { settings, device, update, updateDevice, remember, retry, resetPaneWidths } = state;
  const zones = useMemo(timeZones, []);
  const [panesReset, setPanesReset] = useState(false);
  const zoneOptions =
    settings.timeZone === 'auto' || settings.timeZone === 'UTC' || zones.includes(settings.timeZone)
      ? zones
      : [settings.timeZone, ...zones];
  const select = <K extends keyof SyncedSettings>(key: K, values: readonly SyncedSettings[K][]) => (
    <select
      value={settings[key]}
      onChange={(event) => {
        const patch = { [key]: event.target.value } as Partial<SyncedSettings>;
        update(patch);
        // A default chosen on this device also replaces this device's remembered toggle.
        if (key === 'markupToolbar' || key === 'englishSource') remember(patch);
      }}
    >
      {values.map((value) => (
        <option key={value} value={value}>
          {valueLabel(key, value)}
        </option>
      ))}
    </select>
  );
  return (
    <div className={styles.page}>
      <p role="status" className={styles.status} title={state.errorDetail || undefined}>
        {syncStatusText(state)}{' '}
        {state.status === 'error' && (
          <button type="button" onClick={() => void retry()}>
            Retry sync
          </button>
        )}
      </p>
      {state.notice && <p role="alert">{state.notice}</p>}
      <SettingsChoice />
      <fieldset>
        <legend>Dates and times</legend>
        <p className={styles.hint}>Synced to your account when signed in.</p>
        <label>
          Date format
          {select('dateFormat', dateFormats)}
        </label>
        <label>
          Time display
          {select('timeDisplay', timeDisplays)}
        </label>
        <label>
          Time zone
          <select
            value={settings.timeZone}
            onChange={(event) => update({ timeZone: event.target.value })}
          >
            <option value="auto">Browser time zone ({browserTimeZone()})</option>
            <option value="UTC">UTC</option>
            {zoneOptions.map((zone) => (
              <option key={zone} value={zone}>
                {zone.replaceAll('_', ' ')}
              </option>
            ))}
          </select>
        </label>
        <p className={styles.example}>
          Example: {formatDate(example, settings)}
          {settings.timeDisplay === 'relative' &&
            ` (exact: ${exactDate(example, { ...settings, timeDisplay: 'datetime' })})`}
        </p>
      </fieldset>
      <fieldset>
        <legend>Editor</legend>
        <p className={styles.hint}>
          Starting values for new devices (synced to your account). Toggling the toolbar or source
          view inside the editor is remembered on this device only. Choosing here also applies on
          this device.
        </p>
        <label>
          Markup toolbar
          {select('markupToolbar', ['closed', 'open'] as const)}
        </label>
        <label>
          English source shows
          {select('englishSource', ['changes', 'current'] as const)}
        </label>
      </fieldset>
      <fieldset>
        <legend>This device</legend>
        <p className={styles.hint}>Kept in this browser only; never synced.</p>
        <label>
          Theme
          <select
            value={device.theme}
            onChange={(event) => updateDevice({ theme: event.target.value as ThemePreference })}
          >
            {themePreferences.map((theme) => (
              <option key={theme} value={theme}>
                {themeLabels[theme]}
              </option>
            ))}
          </select>
        </label>
        <label>
          Editor font
          <select
            value={device.editorFont}
            onChange={(event) =>
              updateDevice({ editorFont: event.target.value as typeof device.editorFont })
            }
          >
            {editorFonts.map((font) => (
              <option key={font} value={font}>
                {
                  {
                    default: 'Default',
                    'fira-code': 'Fira Code',
                    'jetbrains-mono': 'JetBrains Mono',
                    system: 'System monospace',
                  }[font]
                }
              </option>
            ))}
          </select>
        </label>
        <p className={styles.hint}>Ligatures are off so typed symbols stay distinct.</p>
        <label>
          Interface scale
          <span className={styles.scale}>
            <input
              type="range"
              min={uiScaleMin}
              max={uiScaleMax}
              step={uiScaleStep}
              value={device.uiScale}
              aria-valuetext={`${device.uiScale} percent`}
              onChange={(event) => updateDevice({ uiScale: Number(event.target.value) })}
            />
            <output>{device.uiScale}%</output>
            <button
              type="button"
              disabled={device.uiScale === 100}
              onClick={() => updateDevice({ uiScale: 100 })}
            >
              100%
            </button>
          </span>
        </label>
        <p className={styles.hint}>
          Scales the whole interface on this device ({uiScaleMin}–{uiScaleMax}%), on top of the
          browser&apos;s own zoom. In a narrow window a large scale is limited so the layout keeps
          fitting.
        </p>
        <div className={styles.actions}>
          <button
            type="button"
            onClick={() => {
              setPanesReset(resetPaneWidths());
            }}
          >
            Reset pane widths and Compendium zoom
          </button>
          {panesReset && (
            <span role="status">Pane widths and Compendium zoom reset to their defaults.</span>
          )}
        </div>
      </fieldset>
    </div>
  );
}
