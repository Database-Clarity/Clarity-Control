import { useSettingsStore, syncedKeys } from '../../stores/settings';
import { When } from '../../ui/When';
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
            <th scope="col">{remote ? 'Synced copy' : 'Synced copy (none yet)'}</th>
          </tr>
        </thead>
        <tbody>
          {differences.map((key) => (
            <tr key={key}>
              <th scope="row">{settingLabels[key]}</th>
              <td>{valueLabel(key, choice.local[key])}</td>
              <td>{remote ? valueLabel(key, remote[key]) : '-'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className={styles.actions}>
        <button type="button" disabled={status === 'syncing'} onClick={() => void keepLocal()}>
          Sync now (keep this device)
        </button>
        <button type="button" disabled={status === 'syncing'} onClick={useRemote}>
          {remote ? 'Discard and use synced' : 'Discard changes'}
        </button>
      </div>
    </section>
  );
}

/** Shown outside the Settings page when a sync needs the user: a choice or a failed sync. */
export function SettingsNotice() {
  const { status, error, pending, retry } = useSettingsStore();
  if (status === 'choice') return <SettingsChoice />;
  if (status !== 'error' || !pending.length) return null;
  return (
    <p role="alert" className={styles.notice}>
      Settings not synced: {error}. Your changes are kept on this device.{' '}
      <button type="button" onClick={() => void retry()}>
        Retry sync
      </button>
    </p>
  );
}
