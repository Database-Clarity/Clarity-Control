import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { dateFormats, timeDisplays, type SyncedSettings } from '@clarity/core';
import { useSettingsStore } from '../../stores/settings';
import { exactDate, formatDate } from '../../services/format/date';
import { browserTimeZone, syncStatusText, valueLabel } from './labels';
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

export function SettingsPage() {
  const state = useSettingsStore();
  const { settings, device, update, updateDevice, remember, retry, resetLayout } = state;
  const zones = useMemo(timeZones, []);
  const [layoutReset, setLayoutReset] = useState(false);
  // Synced settings go to the account only when the user leaves this page.
  useEffect(() => {
    useSettingsStore.getState().enterSettings();
    return () => void useSettingsStore.getState().leaveSettings();
  }, []);
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
    <article className={styles.page}>
      <Link to="/">Back to the editor</Link>
      <h1>Settings</h1>
      <p role="status" className={styles.status}>
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
          Default for new devices; your last choice on this device is remembered. Choosing a default
          here also applies it on this device. Defaults sync to your account when signed in; the
          remembered choices never do.
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
          Text size
          <select
            value={device.textSize}
            onChange={(event) =>
              updateDevice({ textSize: event.target.value === 'large' ? 'large' : 'default' })
            }
          >
            <option value="default">Default</option>
            <option value="large">Large</option>
          </select>
        </label>
        <div className={styles.actions}>
          <button
            type="button"
            onClick={() => {
              resetLayout();
              setLayoutReset(true);
            }}
          >
            Reset editor layout
          </button>
          {layoutReset && (
            <span role="status">Editor and preview split reset to half and half.</span>
          )}
        </div>
      </fieldset>
    </article>
  );
}
