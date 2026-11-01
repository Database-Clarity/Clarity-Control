import { languageLabel } from '../../languageLabels';
import { useEffect, useState, type FormEvent } from 'react';
import { languages, type Permissions } from '@clarity/core';
import { apiUrl } from '../../services/api';
import { errorMessage } from '../../services/http';
import { getPermissions, putPermissions, resolveGitHubLogin } from '../../services/permissions';
import { useAuthStore } from '../../stores/auth';
import { changeAccess, maintainerCount, roles, type Access } from './permissions';
import pageStyles from '../drift/Status.module.scss';
import styles from './Admin.module.scss';

export function AdminPage() {
  const { user, loading: authLoading } = useAuthStore();
  const [config, setConfig] = useState<Permissions | null>(null);
  const [original, setOriginal] = useState<Permissions | null>(null);
  const [login, setLogin] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const permitted = user?.role === 'maintainer';
  useEffect(() => {
    if (!permitted || !apiUrl) return;
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    void getPermissions(controller.signal)
      .then((value) => {
        if (controller.signal.aborted) return;
        setConfig(value);
        setOriginal(value);
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) setError(errorMessage(cause));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [permitted, user?.id, reload]);

  if (authLoading) return <p role="status">Checking maintainer access...</p>;
  if (!permitted)
    return (
      <article>
        <h1>Administration</h1>
        <p role="alert">Maintainer access is required to manage permissions.</p>
      </article>
    );
  if (!apiUrl)
    return (
      <article>
        <h1>Administration</h1>
        <p role="alert">The API is not configured. Permissions cannot be edited.</p>
      </article>
    );

  function update(id: string, access: Access | undefined) {
    if (!config) return;
    try {
      setConfig(changeAccess(config, id, access));
      setError(null);
      setNotice(null);
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }
  async function add(event: FormEvent) {
    event.preventDefault();
    if (!config) return;
    setBusy(true);
    setError(null);
    try {
      const account = await resolveGitHubLogin(login);
      if (config.users[String(account.id)])
        throw new Error(`${account.login} already has access. Edit their existing row.`);
      setConfig(changeAccess(config, String(account.id), { login: account.login, role: 'trial' }));
      setLogin('');
      setNotice('Account resolved. Choose its role and languages, then save permissions.');
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }
  async function savePermissions() {
    if (!config) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const saved = await putPermissions(config);
      setConfig(saved);
      setOriginal(saved);
      setNotice('Permissions saved.');
      await useAuthStore.getState().load();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }
  const dirty = JSON.stringify(config) !== JSON.stringify(original);
  return (
    <article className={pageStyles.page}>
      <h1>Administration</h1>
      <p>Manage editor access by GitHub account. Changes apply only after saving.</p>
      {loading && <p role="status">Loading current permissions...</p>}
      {error && (
        <p role="alert">
          {error}{' '}
          {!config && (
            <button type="button" onClick={() => setReload((value) => value + 1)}>
              Retry
            </button>
          )}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      {config && (
        <fieldset disabled={busy || loading} style={{ border: 0, padding: 0, minWidth: 0 }}>
          <legend>Users and access</legend>
          <div className={styles.tableWrapper}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th scope="col">GitHub account</th>
                  <th scope="col">Role</th>
                  <th scope="col">Languages</th>
                  <th scope="col">Actions</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(config.users)
                  .sort((a, b) => a[1].login.localeCompare(b[1].login))
                  .map(([id, access]) => {
                    const last = access.role === 'maintainer' && maintainerCount(config) === 1;
                    return (
                      <tr key={id}>
                        <th scope="row">
                          <a
                            href={`https://github.com/${encodeURIComponent(access.login)}`}
                            target="_blank"
                            rel="noreferrer"
                          >
                            {access.login}
                          </a>
                          <small>ID {id}</small>
                        </th>
                        <td>
                          <select
                            aria-label={`Role for ${access.login}`}
                            value={access.role}
                            onChange={(event) => {
                              const role = roles.find((value) => value === event.target.value);
                              if (role)
                                update(id, {
                                  login: access.login,
                                  role,
                                  ...(role === 'translator'
                                    ? { languages: access.languages ?? [] }
                                    : {}),
                                });
                            }}
                          >
                            {roles.map((role) => (
                              <option
                                key={role}
                                value={role}
                                disabled={last && role !== 'maintainer'}
                              >
                                {role}
                              </option>
                            ))}
                          </select>
                          {last && <small>Last maintainer</small>}
                        </td>
                        <td>
                          {access.role === 'translator' ? (
                            <div className={styles.languages}>
                              {languages.map((lang) => (
                                <label key={lang}>
                                  <input
                                    type="checkbox"
                                    aria-label={`${access.login}: ${languageLabel(lang)}`}
                                    checked={access.languages?.includes(lang) ?? false}
                                    onChange={(event) =>
                                      update(id, {
                                        ...access,
                                        languages: event.target.checked
                                          ? [...(access.languages ?? []), lang]
                                          : (access.languages?.filter((value) => value !== lang) ??
                                            []),
                                      })
                                    }
                                  />{' '}
                                  {languageLabel(lang)}
                                </label>
                              ))}
                              {!access.languages?.length && (
                                <small>No translation languages assigned</small>
                              )}
                            </div>
                          ) : (
                            'All languages'
                          )}
                        </td>
                        <td>
                          <button
                            type="button"
                            disabled={last}
                            onClick={() => update(id, undefined)}
                          >
                            Remove
                          </button>
                        </td>
                      </tr>
                    );
                  })}
              </tbody>
            </table>
          </div>
          <form className={styles.add} onSubmit={(event) => void add(event)}>
            <label className={styles.login}>
              GitHub login
              <input
                required
                autoComplete="off"
                value={login}
                onChange={(event) => setLogin(event.target.value)}
              />
            </label>
            <button type="submit">Add account</button>
          </form>
          <div className={pageStyles.actions}>
            <button type="button" disabled={!dirty} onClick={() => void savePermissions()}>
              {busy ? 'Working...' : 'Save permissions'}
            </button>
            <button
              type="button"
              disabled={!dirty}
              onClick={() => {
                setConfig(original);
                setError(null);
                setNotice('Unsaved permission changes discarded.');
              }}
            >
              Discard changes
            </button>
          </div>
        </fieldset>
      )}
    </article>
  );
}
