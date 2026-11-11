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
import { ExportsError, loadProject, saveProject } from './api';
import { FileBuildStatus } from './BuildStatus';
import { ConfigPanel } from './ConfigPanel';
import { addFile, fileKey, fromConfig, isDirty, rebase, type ProjectState } from './configModel';
import { PreviewPanel } from './PreviewPanel';
import { fileUrl } from './site';
import { useSiteRefresh, useSiteStore } from './useSite';
import styles from './Exports.module.scss';

/** Phones and 768 get one column with tabs (spec section 8). */
export const narrowQuery = '(max-width: 899px)';

/** Unsaved edits per project for this session, so leaving the page and coming back keeps them. */
const sessionEdits = new Map<string, ProjectState>();
const anyDirty = () => [...sessionEdits.values()].some(isDirty);

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
  const [params, setParams] = useSearchParams();
  const user = useAuthStore((auth) => auth.user);
  const maintainer = user?.role === 'maintainer';
  const narrow = useMedia(narrowQuery);
  useSiteRefresh();
  const manifest = useSiteStore((site) => site.manifest);
  const notices = useSiteStore((site) => site.notices);
  const refreshSite = useSiteStore((site) => site.refresh);

  const [loaded, setLoaded] = useState<Loaded>({ kind: 'loading' });
  const [state, setStateRaw] = useState<ProjectState | null>(() => sessionEdits.get(id) ?? null);
  const setState = useCallback(
    (next: ProjectState | ((current: ProjectState) => ProjectState)) =>
      setStateRaw((current) => {
        if (!current) return current;
        const value = typeof next === 'function' ? next(current) : next;
        sessionEdits.set(id, value);
        return value;
      }),
    [id],
  );
  const [save, setSave] = useState<SaveState>({ kind: 'idle' });

  const load = useCallback(
    async (keepEdits: boolean) => {
      try {
        const project = await loadProject(id);
        setStateRaw((current) => {
          const next =
            keepEdits && current && isDirty(current)
              ? rebase(current, project.config, project.revision)
              : fromConfig(project.config, project.revision);
          sessionEdits.set(id, next);
          return next;
        });
        setLoaded({ kind: 'ready' });
      } catch (error) {
        setLoaded({
          kind: 'error',
          message: errorMessage(error),
          status: error instanceof ExportsError ? error.status : undefined,
        });
      }
    },
    [id],
  );
  useEffect(() => {
    const cached = sessionEdits.get(id);
    setStateRaw(cached ?? null);
    setSave({ kind: 'idle' });
    setLoaded(cached ? { kind: 'ready' } : { kind: 'loading' });
    // A kept session edit is rebased on the stored config, so a stale base is found at once.
    void load(Boolean(cached));
  }, [id, load]);

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
  const [now, setNow] = useState(() => Date.now());
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
  const file = files.find((candidate) => candidate.id === fileParam) ?? files[0];
  const key = file ? fileKey(file) : null;
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
  const lastKey = useRef<string | null>(null);
  useEffect(() => {
    if (!file) return;
    if (lastKey.current === fileKey(file) && fileParam !== file.id && fileParam !== null)
      setParam('file', file.id, true);
    lastKey.current = fileKey(file);
  }, [file, fileParam, setParam]);

  const pane = usePaneDivider({
    storeKey: 'exports:config',
    sizes: 'start',
    min: 360,
    max: 760,
    reserve: 360,
    defaultWidth: (width) => Math.round(Math.min(600, Math.max(480, width * 0.45))),
    persist: !narrow,
  });

  const dirty = state ? isDirty(state) : false;
  const validation = useMemo(
    () => (state && dirty ? configSchema.safeParse(state.config) : null),
    [state, dirty],
  );
  const invalid = validation && !validation.success ? validation.error.issues : null;
  const slots = files.length + (state?.config.retained?.length ?? 0);
  const canAdd = files.length < configLimits.files && slots < configLimits.urlSlots;

  const onSave = async () => {
    if (!state || !dirty || invalid) return;
    setSave({ kind: 'saving' });
    const outcome = await saveProject(id, state.revision, state.config).catch((error: unknown) => ({
      kind: 'refused' as const,
      message: errorMessage(error),
    }));
    if (outcome.kind === 'saved') {
      setState(fromConfig(outcome.config, outcome.revision));
      setSave({ kind: 'saved' });
      void refreshSite();
      return;
    }
    if (outcome.kind === 'conflict') {
      // Reload the stored config and keep the edits on top; the person saves again.
      await load(true);
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
          disabled={!canAdd}
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
    save.kind === 'conflict' ? (
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
      />
    ) : (
      <EmptyProject canAdd={canAdd} onAdd={() => setState(addFile(state))} />
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
