import { useSettingsStore, syncedKeys } from '../../stores/settings';
import { When } from '../../ui/When';
import type { ShellNotice } from '../navigation/notices';
import { useSettingsPanel } from './panel';
import { settingLabels, valueLabel } from './labels';
import styles from './Settings.module.scss';

/** Side-by-side choice between this browser's unsynced settings and the account copy. */
export function SettingsChoice() {
  const choice = useSettingsStore((state) => state.choice);
  const status = useSettingsStore((state) => state.status);
  const keepLocal = useSettingsStore((state) => state.keepLocal);
  const useRemote = useSettingsStore((state) => state.useRemote);
  if (!choice) return null;
  const remote = choice.remote.settings;
  const remoteLabel = remote ? 'Synced copy' : 'Synced copy (none yet)';
  const differences = syncedKeys.filter((key) => !remote || remote[key] !== choice.local[key]);
  return (
    <section className={styles.choice} aria-label="Choose settings to keep">
      <h2>
        {choice.recovered ? 'Unsynced settings changes' : 'Settings changed on another device'}
      </h2>
      <p>
        {choice.recovered ? (
          <>
            Changes made on this device
            {choice.since && (
              <>
                {' '}
                on <When value={choice.since} />
              </>
            )}{' '}
            were not synced before the page closed.
          </>
        ) : (
          'Your account was updated from another device after this device last synced.'
        )}{' '}
        Nothing is overwritten until you choose.
      </p>
      <table>
        <thead>
          <tr>
            <th scope="col">Setting</th>
            <th scope="col">This device</th>
            <th scope="col">{remoteLabel}</th>
          </tr>
        </thead>
        <tbody>
          {differences.map((key) => (
            <tr key={key}>
              <th scope="row">{settingLabels[key]}</th>
              {/* data-label heads each value when the rows stack on phones. */}
              <td data-label="This device">{valueLabel(key, choice.local[key])}</td>
              <td data-label={remoteLabel}>{remote ? valueLabel(key, remote[key]) : '-'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className={styles.actions}>
        <button type="button" disabled={status === 'syncing'} onClick={() => void keepLocal()}>
          Keep this device's settings
        </button>
        <button type="button" disabled={status === 'syncing'} onClick={useRemote}>
          {remote ? 'Use synced settings' : 'Discard changes'}
        </button>
      </div>
    </section>
  );
}

/**
 * What a sync needs from the user, as shell notices: a choice (decided in Settings, never
 * duplicated outside it) or a failed sync with its retry. The Layout hides these while Settings is open.
 */
export function useSettingsNotices(): ShellNotice[] {
  const status = useSettingsStore((state) => state.status);
  const error = useSettingsStore((state) => state.error);
  const errorDetail = useSettingsStore((state) => state.errorDetail);
  const pending = useSettingsStore((state) => state.pending);
  const choice = useSettingsStore((state) => state.choice);
  const retry = useSettingsStore((state) => state.retry);
  if (status === 'choice') {
    return [
      {
        id: 'settings-choice',
        level: 'warning',
        text: choice?.recovered
          ? 'Settings changed on this device were not synced. Choose which to keep.'
          : 'Settings changed on another device. Choose which to keep.',
        actions: [
          {
            label: 'Review in Settings',
            onClick: () =>
              useSettingsPanel
                .getState()
                .show(document.querySelector<HTMLElement>('[data-identity-button]')),
          },
        ],
      },
    ];
  }
  if (status !== 'error' || !pending.length) return [];
  return [
    {
      id: 'settings-sync',
      level: 'alert',
      text: `Settings not synced: ${error}. Your changes are kept on this device.`,
      detail: errorDetail || undefined,
      actions: [{ label: 'Retry sync', onClick: () => void retry() }],
    },
  ];
}
