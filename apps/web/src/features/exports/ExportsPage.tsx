import { SkeletonBoundary } from '../../ui/Skeleton';
import { LoadingSkeleton, useSkeletonVisible } from '../../ui/Skeleton';
// Exports (spec section 8): maintainers get the projects list, one dense row per project; a
// partner lands on their own project (or a list of their projects when they have several).
import { configSchemaVersion, isValidId } from '@clarity/export/config';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { errorMessage } from '../../services/http';
import { useAuthStore } from '../../stores/auth';
import { Dialog } from '../../ui/Dialog';
import { When } from '../../ui/When';
import {
  createProject,
  deleteProject,
  listProjects,
  loadProject,
  setPartners,
  type ProjectList,
  type ProjectRow,
} from './api';
import { BuildDot, projectBuild } from './BuildStatus';
import { useSiteRefresh, useSiteStore } from './useSite';
import styles from './Exports.module.scss';

export function ExportsPage() {
  const user = useAuthStore((state) => state.user);
  const authLoading = useAuthStore((state) => state.loading);
  const maintainer = user?.role === 'maintainer';
  const partnerProjects = user?.projects ?? [];
  useSiteRefresh();
  const loadingSkeleton = useSkeletonVisible(authLoading, 'Loading your account…', true);
  if (authLoading || loadingSkeleton)
    return <LoadingSkeleton label="Loading your account…" shape="page" visible={loadingSkeleton} />;
  if (!maintainer && partnerProjects.length === 1)
    return <Navigate to={`/exports/${partnerProjects[0]}`} replace />;
  if (!maintainer && !partnerProjects.length)
    return (
      <section className={styles.listPage}>
        <h1 className={styles.pageTitle}>Exports</h1>
        <p>Export projects are managed by maintainers and their partners.</p>
      </section>
    );
  return <ProjectsList maintainer={maintainer} />;
}

function ProjectsList({ maintainer }: { maintainer: boolean }) {
  const [list, setList] = useState<ProjectList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<ProjectRow | null>(null);
  const reload = useCallback(async () => {
    try {
      setList(await listProjects());
      setError(null);
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }, []);
  useEffect(() => {
    void reload();
  }, [reload]);
  const manifest = useSiteStore((state) => state.manifest);
  const notices = useSiteStore((state) => state.notices);
  const siteError = useSiteStore((state) => state.error);

  return (
    <section className={styles.listPage} aria-labelledby="exports-title">
      <div className={styles.listHeader}>
        <h1 id="exports-title" className={styles.pageTitle}>
          Exports
        </h1>

        {list && (
          <span className={styles.meta}>
            {list.projects.length} {list.projects.length === 1 ? 'project' : 'projects'}
          </span>
        )}
        {siteError && (
          <span className={styles.warnText}>Build status unavailable: {siteError}</span>
        )}
      </div>
      {error && (
        <p role="alert" className={styles.alert}>
          Cannot load projects: {error}{' '}
          <button type="button" className={styles.button} onClick={() => void reload()}>
            Retry
          </button>
        </p>
      )}

      <SkeletonBoundary pending={!list} error={!!error} label="Loading projects…" shape="rows">
        {list && (
          <div className={styles.tableScroll}>
            <table className={styles.projects}>
              <thead>
                <tr>
                  <th scope="col">Project</th>
                  {maintainer && <th scope="col">Partners</th>}
                  <th scope="col">Files</th>
                  <th scope="col">Format</th>
                  <th scope="col">Last build</th>
                  <th scope="col">Notices</th>
                  {maintainer && (
                    <th scope="col">
                      <span className={styles.visuallyHidden}>Actions</span>
                    </th>
                  )}
                </tr>
              </thead>
              <tbody>
                {list.projects.map((row) => (
                  <ProjectListRow
                    key={row.id}
                    row={row}
                    maintainer={maintainer}
                    partnersRevision={list.partnersRevision}
                    build={projectBuild(manifest, notices, row.id)}
                    onPartners={reload}
                    onDelete={() => setDeleting(row)}
                  />
                ))}
                {!list.projects.length && (
                  <tr>
                    <td colSpan={maintainer ? 7 : 5} className={styles.empty}>
                      No export projects yet.
                    </td>
                  </tr>
                )}
              </tbody>
              {maintainer && (
                <tfoot>
                  <NewProjectRow taken={list.projects.map((row) => row.id)} />
                </tfoot>
              )}
            </table>
          </div>
        )}
      </SkeletonBoundary>
      {deleting && (
        <DeleteProject
          row={deleting}
          onClose={() => setDeleting(null)}
          onDeleted={() => {
            setDeleting(null);
            void reload();
          }}
        />
      )}
    </section>
  );
}

function ProjectListRow({
  row,
  maintainer,
  partnersRevision,
  build,
  onPartners,
  onDelete,
}: {
  row: ProjectRow;
  maintainer: boolean;
  partnersRevision?: string;
  build: ReturnType<typeof projectBuild>;
  onPartners(): Promise<void>;
  onDelete(): void;
}) {
  const formats = [...new Set((row.files ?? []).map((file) => `v${file.formatVersion}`))];
  return (
    <tr>
      <th scope="row" className={styles.projectCell} data-col="project">
        <Link to={`/exports/${row.id}`} className={styles.projectLink}>
          {row.id}
        </Link>
        <span className={styles.projectName}>{row.name ?? row.error}</span>
      </th>
      {maintainer && (
        <td data-col="partners">
          <PartnersCell row={row} revision={partnersRevision} onSaved={onPartners} />
        </td>
      )}
      <td className={styles.filesCell} data-col="files">
        {(row.files ?? []).map((file) => (
          <span key={file.id} className={styles.fileChip} title={`${file.id} · ${file.preset}`}>
            {file.id}
            <span className={styles.meta}> {file.preset}</span>
          </span>
        ))}
        {!row.files?.length && <span className={styles.meta}>No files</span>}
        {row.retained ? <span className={styles.meta}> +{row.retained} old URL</span> : null}
      </td>
      <td className={styles.meta} data-col="format">
        {formats.join(', ') || '–'}
      </td>
      <td data-col="build">
        <span className={styles.buildCell}>
          <BuildDot state={build.state} />
          {build.at ? <When value={build.at} nowrap /> : <span>{build.label}</span>}
        </span>
      </td>
      <td data-col="notices" data-empty={build.failures || build.notices ? undefined : ''}>
        {build.failures ? (
          <span className={styles.badText}>{build.failures} failed</span>
        ) : build.notices ? (
          <span className={styles.meta}>{build.notices}</span>
        ) : (
          <span className={styles.meta}>–</span>
        )}
      </td>
      {maintainer && (
        <td className={styles.actionsCell} data-col="actions">
          <button type="button" className={styles.quiet} onClick={onDelete}>
            Delete…
          </button>
        </td>
      )}
    </tr>
  );
}

function PartnersCell({
  row,
  revision,
  onSaved,
}: {
  row: ProjectRow;
  revision?: string;
  onSaved(): Promise<void>;
}) {
  const logins = (row.partners ?? []).map((partner) => partner.login);
  const [draft, setDraft] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (draft === null || !revision) return;
    setBusy(true);
    try {
      const next = draft
        .split(/[\s,]+/)
        .map((login) => login.replace(/^@/, '').trim())
        .filter(Boolean);
      await setPartners(row.id, revision, next);
      await onSaved();
      setDraft(null);
      setError(null);
    } catch (cause) {
      setError(errorMessage(cause));
      await onSaved();
    } finally {
      setBusy(false);
    }
  };
  if (draft === null)
    return (
      <span className={styles.partners}>
        <span className={logins.length ? undefined : styles.meta}>
          {logins.length ? logins.join(', ') : 'None'}
        </span>
        <button
          type="button"
          className={styles.quiet}
          onClick={() => setDraft(logins.join(', '))}
          aria-label={`Edit partners of ${row.id}`}
        >
          Edit
        </button>
      </span>
    );
  return (
    <form className={styles.partnersForm} onSubmit={(event) => void submit(event)}>
      <input
        className={styles.field}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        aria-label={`GitHub logins of ${row.id}'s partners, comma separated`}
        placeholder="GitHub logins"
        disabled={busy}
        autoFocus
      />
      <button type="submit" className={styles.button} disabled={busy}>
        Save
      </button>
      <button
        type="button"
        className={styles.quiet}
        onClick={() => {
          setDraft(null);
          setError(null);
        }}
        disabled={busy}
      >
        Cancel
      </button>
      {error && (
        <span role="alert" className={styles.badText}>
          {error}
        </span>
      )}
    </form>
  );
}

function NewProjectRow({ taken }: { taken: string[] }) {
  const navigate = useNavigate();
  const [id, setId] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const idProblem = !id
    ? null
    : !isValidId(id)
      ? 'Use 2–32 of a–z, 0–9, and -, starting with a letter; not a reserved name'
      : taken.includes(id)
        ? 'That id is taken'
        : null;
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!id || idProblem || !name.trim()) return;
    setBusy(true);
    const outcome = await createProject({
      schema: configSchemaVersion,
      id,
      name: name.trim(),
      files: [],
    }).catch((cause: unknown) => ({ kind: 'refused' as const, message: errorMessage(cause) }));
    setBusy(false);
    if (outcome.kind === 'saved') navigate(`/exports/${id}`);
    else setError(outcome.message);
  };
  return (
    <tr>
      <td colSpan={7}>
        <form className={styles.newProject} onSubmit={(event) => void submit(event)}>
          <span className={styles.newLabel}>New project</span>
          <input
            className={styles.field}
            value={id}
            onChange={(event) => setId(event.target.value.toLowerCase())}
            placeholder="id (dim)"
            aria-label="New project id"
            aria-invalid={idProblem ? true : undefined}
            aria-describedby={idProblem ? 'new-project-problem' : undefined}
            disabled={busy}
            maxLength={32}
          />
          <input
            className={styles.field}
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Name (Destiny Item Manager)"
            aria-label="New project name"
            disabled={busy}
            maxLength={64}
          />
          <button
            type="submit"
            className={styles.button}
            disabled={busy || !id || !!idProblem || !name.trim()}
          >
            Create
          </button>
          {(idProblem || error) && (
            <span id="new-project-problem" role="alert" className={styles.badText}>
              {idProblem ?? error}
            </span>
          )}
        </form>
      </td>
    </tr>
  );
}

function DeleteProject({
  row,
  onClose,
  onDeleted,
}: {
  row: ProjectRow;
  onClose(): void;
  onDeleted(): void;
}) {
  const [urls, setUrls] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    loadProject(row.id).then(
      (project) =>
        live &&
        setUrls([
          ...project.config.files.map(
            (file) => `${project.id}/v${file.formatVersion}/${file.id}.json`,
          ),
          ...(project.config.retained ?? []).map((entry) => entry.path),
        ]),
      // An unreadable config can still be deleted; it names no URLs.
      () => live && setUrls([]),
    );
    return () => {
      live = false;
    };
  }, [row.id]);
  const confirm = async () => {
    setBusy(true);
    try {
      await deleteProject(row.id, row.revision);
      onDeleted();
    } catch (cause) {
      setError(errorMessage(cause));
      setBusy(false);
    }
  };
  return (
    <Dialog
      title={`Delete ${row.id}?`}
      onClose={onClose}
      busy={busy}
      compact
      footer={
        <>
          <button type="button" className={styles.button} onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            className={styles.danger}
            onClick={() => void confirm()}
            disabled={busy || urls === null}
          >
            Delete project
          </button>
        </>
      }
    >
      <p>
        The next build removes these URLs, and partners of {row.id} lose access. This cannot be
        undone from here.
      </p>
      {urls === null ? (
        <p role="status">Listing URLs…</p>
      ) : urls.length ? (
        <ul className={styles.urlList}>
          {urls.map((url) => (
            <li key={url}>{url}</li>
          ))}
        </ul>
      ) : (
        <p className={styles.meta}>No URLs.</p>
      )}
      {error && (
        <p role="alert" className={styles.badText}>
          {error}
        </p>
      )}
    </Dialog>
  );
}
