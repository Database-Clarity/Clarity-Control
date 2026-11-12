// A project page (spec section 8): header row (name, file tabs, Save, build status, copy URL),
// config on the left and the preview on the right; one column with Config | Preview tabs on
// phones and at 768. The URL holds the file tab (`file`), the preview pick (`pick`), and the
// narrow view (`view`), so Back walks through them.
import { configLimits, configSchema } from '@clarity/export/config';
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { errorMessage } from '../../services/http';
import { useAuthStore } from '../../stores/auth';
import { PaneDivider } from '../../ui/PaneDivider';
import { usePaneDivider } from '../../ui/usePaneDivider';
import { useMedia } from '../../ui/useMedia';
import { ExportsError, loadProject, saveProject, type SaveOutcome } from './api';
import { FileBuildStatus } from './BuildStatus';
import { ConfigPanel, RetainedSection } from './ConfigPanel';
import { addFile, fileKey, fromConfig, isDirty, rebase, type ProjectState } from './configModel';
import { PreviewPanel } from './PreviewPanel';
import { fileUrl } from './site';
import { useSiteRefresh, useSiteStore } from './useSite';
import styles from './Exports.module.scss';

/** Phones and 768 get one column with tabs (spec section 8). */
export const narrowQuery = '(max-width: 899px)';

/**
 * Unsaved edits per account and project for this session, so leaving the page and coming back
 * keeps them; another account never sees them.
 */
const sessionEdits = new Map<string, ProjectState>();
const anyDirty = () => [...sessionEdits.values()].some(isDirty);

/** Saves on their way, per scope: a page that comes back while one is pending waits for it. */
const pendingSaves = new Map<string, Promise<SaveOutcome>>();

/**
 * Sends a save. Its reply always lands in the scope's cache (the page may have been left), so a
 * stored config never meets a draft that predates it; the page itself applies it if still open.
 */
function startSave(scope: string, id: string, state: ProjectState): Promise<SaveOutcome> {
  const pending = saveProject(id, state.revision, state.config)
    .catch((error: unknown): SaveOutcome => ({ kind: 'refused', message: errorMessage(error) }))
    .then((outcome) => {
      pendingSaves.delete(scope);
      if (outcome.kind === 'saved')
        sessionEdits.set(scope, {
          ...fromConfig(outcome.config, outcome.revision),
          memory: sessionEdits.get(scope)?.memory ?? state.memory,
        });
      return outcome;
    });
  pendingSaves.set(scope, pending);
  return pending;
}

type Loaded =
  { kind: 'loading' } | { kind: 'error'; message: string; status?: number } | { kind: 'ready' };

type SaveState =
  | { kind: 'idle' }
  | { kind: 'saving' }
  | { kind: 'saved' }
  | { kind: 'conflict'; message: string }
  | { kind: 'cooldown'; until: number; message: string }
  | { kind: 'refused'; message: string; details?: unknown };

export function ProjectPage() {
  const { project: id = '' } = useParams();
  const userId = useAuthStore((auth) => auth.user?.id ?? null);
  // One page instance per account and project: a change of either starts afresh (and reloads),
  // and nothing still pending from the old one can reach the new one.
  const scope = `${userId ?? '-'}:${id}`;
  return <ProjectView key={scope} id={id} scope={scope} />;
}

function ProjectView({ id, scope }: { id: string; scope: string }) {
  const [params, setParams] = useSearchParams();
  const user = useAuthStore((auth) => auth.user);
  const maintainer = user?.role === 'maintainer';
  const narrow = useMedia(narrowQuery);
  useSiteRefresh();
  const manifest = useSiteStore((site) => site.manifest);
  const notices = useSiteStore((site) => site.notices);
  const refreshSite = useSiteStore((site) => site.refresh);

  const [loaded, setLoaded] = useState<Loaded>(() =>
    sessionEdits.has(scope) ? { kind: 'ready' } : { kind: 'loading' },
  );
  const [state, setStateRaw] = useState<ProjectState | null>(() => sessionEdits.get(scope) ?? null);
  const setState = useCallback(
    (next: ProjectState | ((current: ProjectState) => ProjectState)) =>
      setStateRaw((current) => {
        if (!current) return current;
        const value = typeof next === 'function' ? next(current) : next;
        sessionEdits.set(scope, value);
        return value;
      }),
    [scope],
  );
  const [save, setSave] = useState<SaveState>({ kind: 'idle' });
  const [now, setNow] = useState(() => Date.now());

  // Completions land only on this page instance, and only from the latest load.
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const loads = useRef(0);

  const load = useCallback(
    async (keepEdits: boolean) => {
      const ticket = ++loads.current;
      const latest = () => alive.current && ticket === loads.current;
      try {
        const project = await loadProject(id);
        if (!latest()) return;
        setStateRaw((held) => {
          const next =
            keepEdits && held && isDirty(held)
              ? rebase(held, project.config, project.revision)
              : fromConfig(project.config, project.revision);
          sessionEdits.set(scope, next);
          return next;
        });
        setLoaded({ kind: 'ready' });
      } catch (error) {
        if (!latest()) return;
        const status = error instanceof ExportsError ? error.status : undefined;
        // Refused or gone: a cached draft must not stay editable.
        if (status === 403 || status === 404) {
          sessionEdits.delete(scope);
          setStateRaw(null);
        }
        setLoaded({ kind: 'error', message: errorMessage(error), status });
      }
    },
    [id, scope],
  );
  // A save's reply (from this page instance or an earlier one of the same scope).
  const finishSave = useCallback(
    async (pending: Promise<SaveOutcome>) => {
      setSave({ kind: 'saving' });
      const outcome = await pending;
      if (!alive.current) return;
      if (outcome.kind === 'saved') {
        // startSave already wrote the stored config into this scope's cache.
        setStateRaw(sessionEdits.get(scope) ?? null);
        setSave({ kind: 'saved' });
        void refreshSite();
        return;
      }
      if (outcome.kind === 'conflict') {
        // Reload the stored config and keep the edits on top; the person saves again.
        await load(true);
        if (!alive.current) return;
        setSave({ kind: 'conflict', message: outcome.message });
        return;
      }
      if (outcome.kind === 'cooldown') {
        setSave({
          kind: 'cooldown',
          until: Date.now() + outcome.retryAfter * 1000,
          message: outcome.message,
        });
        setNow(Date.now());
        return;
      }
      setSave(outcome);
    },
    [load, refreshSite, scope],
  );

  useEffect(() => {
    // Back on a project whose save is still on its way: its reply brings the stored config.
    const pending = pendingSaves.get(scope);
    if (pending) void finishSave(pending);
    // A kept session edit is rebased on the stored config, so a stale base is found at once.
    else void load(sessionEdits.has(scope));
  }, [scope, load, finishSave]);

  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (!anyDirty()) return;
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', beforeUnload);
    return () => window.removeEventListener('beforeunload', beforeUnload);
  }, []);

  // Cooldown countdown (429): Save comes back by itself when the wait is over.
  useEffect(() => {
    if (save.kind !== 'cooldown') return;
    const timer = window.setInterval(() => {
      setNow(Date.now());
      if (Date.now() >= save.until) setSave({ kind: 'idle' });
    }, 1000);
    return () => window.clearInterval(timer);
  }, [save]);

  const files = state?.config.files ?? [];
  const fileParam = params.get('file');
  // The URL names the file by id (none: the first file). When the named id is gone because the
  // shown file was just renamed (the URL update arrives in a later render), the tab stays: by
  // the file's identity (a saved file's uid), else by its place (an unsaved file's key is its id).
  const shown = useRef<{ key: string | null; index: number }>({ key: null, index: -1 });
  const file =
    fileParam === null
      ? files[0]
      : (files.find((candidate) => candidate.id === fileParam) ??
        files.find((candidate) => fileKey(candidate) === shown.current.key) ??
        (files[shown.current.index]?.uid ? undefined : files[shown.current.index]) ??
        files[0]);
  const key = file ? fileKey(file) : null;
  const index = file ? files.indexOf(file) : -1;
  useEffect(() => {
    shown.current = { key, index };
  }, [key, index]);
  const view = narrow && params.get('view') === 'preview' ? 'preview' : 'config';

  const setParam = useCallback(
    (name: string, value: string | null, replace = false) =>
      setParams(
        (current) => {
          const next = new URLSearchParams(current);
          if (value === null) next.delete(name);
          else next.set(name, value);
          return next;
        },
        { replace },
      ),
    [setParams],
  );

  // A renamed file keeps its tab: the URL follows the id.
  useEffect(() => {
    if (file && fileParam !== null && fileParam !== file.id) setParam('file', file.id, true);
  }, [file, fileParam, setParam]);

  const pane = usePaneDivider({
    storeKey: 'exports:config',
    sizes: 'start',
    min: 360,
    max: 760,
    reserve: 360,
    defaultWidth: (width) => Math.round(Math.min(680, Math.max(520, width * 0.5))),
    persist: !narrow,
    // The columns mount once the project has loaded (and only on wide screens): measuring
    // resumes then, so the default width follows the real container instead of its minimum.
    paused: narrow || !state,
  });

  const dirty = state ? isDirty(state) : false;
  const validation = useMemo(
    () => (state && dirty ? configSchema.safeParse(state.config) : null),
    [state, dirty],
  );
  const invalid = validation && !validation.success ? validation.error.issues : null;
  const slots = files.length + (state?.config.retained?.length ?? 0);
  const canAdd = files.length < configLimits.files && slots < configLimits.urlSlots;

  // The config is read-only while a save is on its way, so no edit can land between the request
  // and its reply (the reply's config replaces the page's).
  const saving = save.kind === 'saving';
  const onSave = () => {
    if (!state || !dirty || invalid || saving) return;
    void finishSave(startSave(scope, id, state));
  };

  if (loaded.kind === 'error' && !state)
    return (
      <section className={styles.listPage}>
        <h1 className={styles.pageTitle}>{id}</h1>
        <p role="alert" className={styles.alert}>
          {loaded.status === 403
            ? 'This account cannot open this export project.'
            : loaded.status === 404
              ? 'There is no export project with this id.'
              : `Cannot load the project: ${loaded.message}`}{' '}
          {loaded.status !== 403 && loaded.status !== 404 && (
            <button type="button" className={styles.button} onClick={() => void load(false)}>
              Retry
            </button>
          )}
        </p>
        <Link to="/exports">All projects</Link>
      </section>
    );
  if (!state) return <p role="status">Loading project…</p>;

  const cooling = save.kind === 'cooldown' ? Math.max(0, Math.ceil((save.until - now) / 1000)) : 0;
  const path = file ? `${id}/v${file.formatVersion}/${file.id}.json` : null;
  const saveLabel = save.kind === 'saving' ? 'Saving…' : cooling ? `Save in ${cooling} s` : 'Save';

  const header = (
    <div className={styles.projectHeader}>
      <div className={styles.titleRow}>
        {maintainer && (
          <Link to="/exports" className={styles.crumb}>
            Exports
          </Link>
        )}
        <h1 className={styles.projectTitle} title={state.config.name}>
          {state.config.name}
        </h1>
        <span className={styles.meta}>{id}</span>
      </div>
      <div className={styles.fileTabs} role="tablist" aria-label="Files">
        {files.map((candidate) => (
          <button
            key={fileKey(candidate)}
            type="button"
            role="tab"
            id={`file-tab-${fileKey(candidate)}`}
            aria-selected={candidate === file}
            aria-controls="export-file-panel"
            className={styles.fileTab}
            onClick={() => candidate !== file && setParam('file', candidate.id)}
          >
            {candidate.id}
          </button>
        ))}
        <button
          type="button"
          className={styles.addFile}
          disabled={!canAdd || saving}
          title={
            canAdd
              ? 'Add a file'
              : files.length >= configLimits.files
                ? `At most ${configLimits.files} files per project`
                : `At most ${configLimits.urlSlots} URLs per project, old URLs included`
          }
          onClick={() => {
            const next = addFile(state);
            setState(next);
            setParam('file', next.config.files.at(-1)!.id);
          }}
        >
          + File
        </button>
      </div>
      <div className={styles.headerActions}>
        {path && file && (
          <FileBuildStatus
            manifest={manifest}
            notices={notices}
            path={path}
            formatVersion={file.formatVersion}
          />
        )}
        {path && <CopyUrl url={fileUrl(path)} />}
        <button
          type="button"
          className={styles.primary}
          onClick={() => void onSave()}
          disabled={!dirty || !!invalid || save.kind === 'saving' || cooling > 0}
          title={invalid ? 'Fix the marked fields first' : undefined}
        >
          {saveLabel}
        </button>
      </div>
    </div>
  );

  const banner =
    loaded.kind === 'error' ? (
      <p role="alert" className={styles.banner} data-tone="bad">
        Cannot reload the project: {loaded.message}{' '}
        <button type="button" className={styles.linkButton} onClick={() => void load(true)}>
          Retry
        </button>
      </p>
    ) : save.kind === 'conflict' ? (
      <p role="alert" className={styles.banner} data-tone="warn">
        Someone saved this project after you opened it. It is reloaded with your edits kept on top;
        check them and Save again.
      </p>
    ) : save.kind === 'cooldown' ? (
      <p role="status" className={styles.banner} data-tone="warn">
        {save.message.replace(/\d+ s$/, `${cooling} s`)}
      </p>
    ) : save.kind === 'refused' ? (
      <p role="alert" className={styles.banner} data-tone="bad">
        Not saved: {save.message}
      </p>
    ) : save.kind === 'saved' && !dirty ? (
      <p role="status" className={styles.banner} data-tone="ok">
        Saved. The data site rebuilds within minutes.
      </p>
    ) : invalid ? (
      <p role="alert" className={styles.banner} data-tone="bad">
        {invalid.length === 1 ? 'One field needs' : `${invalid.length} fields need`} fixing:{' '}
        {invalid[0]!.message}
      </p>
    ) : dirty ? (
      <p role="status" className={styles.banner}>
        Unsaved changes
      </p>
    ) : null;

  const config =
    file && key ? (
      <ConfigPanel
        state={state}
        file={file}
        fileKey={key}
        maintainer={maintainer}
        projectId={id}
        onChange={setState}
        onRemoved={() => setParam('file', null, true)}
        onRenamed={(renamed) => setParam('file', renamed, true)}
      />
    ) : (
      // Old URLs stay manageable with no file left (an expired one can free a slot).
      <div className={styles.config}>
        <EmptyProject canAdd={canAdd && !saving} onAdd={() => setState(addFile(state))} />
        <RetainedSection state={state} maintainer={maintainer} projectId={id} update={setState} />
      </div>
    );
  const preview =
    file && key ? (
      <PreviewPanel
        projectId={id}
        state={state}
        file={file}
        pick={params.get('pick')}
        onPick={(hash) => setParam('pick', hash)}
      />
    ) : null;

  return (
    <section className={styles.projectPage} aria-labelledby="export-project-title">
      <span id="export-project-title" className={styles.visuallyHidden}>
        Export project {state.config.name}
      </span>
      {header}
      {banner}
      {narrow ? (
        <>
          <div className={styles.viewTabs} role="tablist" aria-label="View">
            {(['config', 'preview'] as const).map((name) => (
              <button
                key={name}
                type="button"
                role="tab"
                aria-selected={view === name}
                className={styles.viewTab}
                onClick={() => setParam('view', name === 'config' ? null : name, true)}
              >
                {name === 'config' ? 'Config' : 'Preview'}
              </button>
            ))}
          </div>
          <div
            id="export-file-panel"
            role="tabpanel"
            aria-labelledby={file ? `file-tab-${key}` : undefined}
            className={styles.narrowBody}
            {...inertWhile(saving && view === 'config')}
          >
            {view === 'config' ? config : preview}
          </div>
        </>
      ) : (
        <div
          ref={pane.containerRef}
          className={styles.columns}
          style={{ '--config-w': `${pane.width}px` } as CSSProperties}
        >
          <div
            id="export-file-panel"
            role="tabpanel"
            aria-labelledby={file ? `file-tab-${key}` : undefined}
            className={styles.configColumn}
            {...inertWhile(saving)}
          >
            {config}
          </div>
          <PaneDivider
            {...pane.divider}
            className={styles.columnDivider}
            label="Resize config and preview"
            controls="export-file-panel"
          />
          <div className={styles.previewColumn}>{preview}</div>
        </div>
      )}
    </section>
  );
}

/** No input reaches the subtree (React 18 passes `inert` through as a plain attribute). */
const inertWhile = (on: boolean) =>
  (on ? { inert: '', 'aria-busy': true } : {}) as Record<string, unknown>;

function EmptyProject({ canAdd, onAdd }: { canAdd: boolean; onAdd(): void }) {
  return (
    <div className={styles.emptyProject}>
      <p>This project has no files yet. A file is one URL partners download.</p>
      <button type="button" className={styles.button} onClick={onAdd} disabled={!canAdd}>
        Add a file
      </button>
    </div>
  );
}

function CopyUrl({ url }: { url: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1500);
    return () => window.clearTimeout(timer);
  }, [copied]);
  return (
    <button
      type="button"
      className={styles.button}
      title={url}
      onClick={() =>
        void navigator.clipboard?.writeText(url).then(
          () => setCopied(true),
          () => undefined,
        )
      }
    >
      {copied ? 'Copied' : 'Copy URL'}
    </button>
  );
}
