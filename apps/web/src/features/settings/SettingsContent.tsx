import { useEffect, useMemo, useRef, useState } from 'react';
import { dateFormats, timeDisplays, type SyncedSettings } from '@clarity/core';
import {
  useSettingsStore,
  editorFontSizes,
  editorFonts,
  uiScaleMax,
  uiScaleMin,
  uiScaleStep,
  type SuggestAccept,
  type FinderWheel,
  type SymbolReveal,
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

/**
 * Interface scale slider. Scaling resizes the popover (and this very control), so applying every
 * step while the thumb is held would move it away from the pointer and feed back into the drag.
 * A pointer drag therefore only previews the number and applies once on release; keyboard steps
 * (and anything else that is not a drag) apply immediately.
 */
export function ScaleControl({
  value,
  onCommit,
}: {
  value: number;
  onCommit: (value: number) => void;
}) {
  const [draft, setDraft] = useState<number | null>(null);
  const dragging = useRef(false);
  const latest = useRef(value);
  useEffect(() => {
    const release = () => {
      if (!dragging.current) return;
      dragging.current = false;
      const next = latest.current;
      setDraft(null);
      onCommit(next);
    };
    window.addEventListener('pointerup', release);
    window.addEventListener('pointercancel', release);
    return () => {
      window.removeEventListener('pointerup', release);
      window.removeEventListener('pointercancel', release);
    };
  });
  const shown = draft ?? value;
  return (
    <span className={styles.scale}>
      <input
        type="range"
        min={uiScaleMin}
        max={uiScaleMax}
        step={uiScaleStep}
        value={shown}
        aria-valuetext={`${shown} percent`}
        onPointerDown={() => {
          dragging.current = true;
          latest.current = value;
        }}
        onChange={(event) => {
          const next = Number(event.target.value);
          if (dragging.current) {
            latest.current = next;
            setDraft(next);
          } else onCommit(next);
        }}
      />
      <output>{shown}%</output>
      <button type="button" disabled={shown === 100} onClick={() => onCommit(100)}>
        100%
      </button>
    </span>
  );
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
        if (key === 'englishSource') remember(patch);
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
          The markup row is open until you hide it. Both choices here are remembered on this device;
          English source is also the starting value for new devices (synced to your account).
        </p>
        <label>
          Markup row
          <select
            value={device.remembered.markupToolbar ?? 'open'}
            onChange={(event) =>
              remember({ markupToolbar: event.target.value as 'open' | 'closed' })
            }
          >
            <option value="open">{valueLabel('markupToolbar', 'open')}</option>
            <option value="closed">{valueLabel('markupToolbar', 'closed')}</option>
          </select>
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
          Editor text size
          <select
            value={device.editorFontSize ?? ''}
            onChange={(event) =>
              updateDevice({
                editorFontSize: event.target.value === '' ? null : Number(event.target.value),
              })
            }
          >
            <option value="">Automatic (follows interface scale)</option>
            {editorFontSizes.map((size) => (
              <option key={size} value={size}>
                {size} px
              </option>
            ))}
          </select>
        </label>
        <p className={styles.hint}>
          Sets the size of the text you edit, on this device only, independent of the interface
          scale. Touch screens keep at least 16 px so the page does not zoom on focus.
        </p>
        <label>
          Accept suggestion chips with
          <select
            value={device.suggestAccept}
            onChange={(event) =>
              updateDevice({ suggestAccept: event.target.value as SuggestAccept })
            }
          >
            <option value="enter">Enter (Shift+Enter makes a new line)</option>
            <option value="tab">Tab (Enter always makes a new line)</option>
          </select>
        </label>
        <label>
          Show symbol markup
          <select
            value={device.symbolReveal}
            onChange={(event) => updateDevice({ symbolReveal: event.target.value as SymbolReveal })}
          >
            <option value="popover">In a popover on hover (text never moves)</option>
            <option value="caret">As raw text while the caret is on the symbol</option>
          </select>
        </label>
        <label>
          Finder wheel
          <select
            value={device.finderWheel}
            onChange={(event) => updateDevice({ finderWheel: event.target.value as FinderWheel })}
          >
            <option value="entries">Shift: entries, Alt+Shift: weapons</option>
            <option value="groups">Shift: weapons, Alt+Shift: entries</option>
          </select>
        </label>
        <label>
          Interface scale
          <ScaleControl value={device.uiScale} onCommit={(uiScale) => updateDevice({ uiScale })} />
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
