// The preview column (spec section 8): tooltip search and recent picks; the picked entry exactly
// as the file has it, labelled "Live file" (an unchanged deployed legacy preset: the deployed
// bytes the pin names) or "Preview build" (built from the pinned input in the Web Worker);
// "Diff vs live file" (the Compendium Changes word diff); and whole-file numbers on demand.
import { deployedLegacyPresets } from '@clarity/export';
import { isLegacyFile, type ExportFile } from '@clarity/export/config';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useDataStore } from '../../stores/data';
import { WordDiff } from '../../ui/diff';
import { When } from '../../ui/When';
import { formatBytes } from './BuildStatus';
import { savedFile, type ProjectState } from './configModel';
import type { FileNumbers, LiveRef, SampleResult } from './previewCore';
import type { SamplePair } from './previewClient';
import { recentPicks, rememberPick, TooltipSearch, type Pick } from './TooltipSearch';
import { usePreview, useSiteStore } from './useSite';
import styles from './Exports.module.scss';

const showsLive = (file: ExportFile) =>
  isLegacyFile(file) && (deployedLegacyPresets as readonly string[]).includes(file.preset);

/** Where this file's published copy is: the pinned legacy file, or its saved URL on the site. */
export function liveRefFor(
  state: ProjectState,
  file: ExportFile,
  projectId: string,
  manifest: ReturnType<typeof useSiteStore.getState>['manifest'],
): LiveRef | null {
  if (showsLive(file)) return { kind: 'legacy', name: `${file.preset}.json` };
  const saved = savedFile(state, file);
  if (!saved) return null;
  const path = `${projectId}/v${saved.formatVersion}/${saved.id}.json`;
  const published = manifest?.files[path];
  return published ? { kind: 'site', path, sha256: published.sha256 } : null;
}

const pretty = (result: SampleResult | null | undefined) =>
  result?.kind === 'entry' ? JSON.stringify(result.entry, null, 2) : '';

export function PreviewPanel({
  projectId,
  state,
  file,
  pick,
  onPick,
}: {
  projectId: string;
  state: ProjectState;
  file: ExportFile;
  pick: string | null;
  onPick(hash: string): void;
}) {
  const preview = usePreview();
  const manifest = useSiteStore((site) => site.manifest);
  const siteError = useSiteStore((site) => site.error);
  const data = useDataStore((store) => store.data);
  const [recent, setRecent] = useState(() => recentPicks(projectId));
  const [diff, setDiff] = useState(false);
  // Compared by value: an edit elsewhere in the project must not restart the sample.
  const liveKey = JSON.stringify(liveRefFor(state, file, projectId, manifest));
  const live = useMemo(() => JSON.parse(liveKey) as LiveRef | null, [liveKey]);
  const liveLabel = showsLive(file);
  const fileJson = useMemo(() => JSON.stringify(file), [file]);
  const hash = pick ?? recent[0]?.hash ?? null;

  // Every change of the file's config is a new version; the rendered entry names the version it
  // shows, so a measurement can wait for the repaint of exactly that change.
  const version = useRef(0);
  const lastJson = useRef(fileJson);
  if (lastJson.current !== fileJson) {
    lastJson.current = fileJson;
    version.current += 1;
  }
  const [sample, setSample] = useState<{
    pair: SamplePair;
    version: number;
    hash: string;
  } | null>(null);
  const client = preview.state.kind === 'ready' ? preview.state.client : null;
  useEffect(() => {
    if (!client || !hash) return;
    const asked = version.current;
    let current = true;
    client.sample(JSON.parse(fileJson) as ExportFile, hash, live, diff && !!live).then(
      (pair) => {
        if (pair && current) setSample({ pair, version: asked, hash });
      },
      (error: Error) =>
        current &&
        setSample({
          pair: { preview: { kind: 'error', message: error.message }, live: null },
          version: asked,
          hash,
        }),
    );
    return () => {
      current = false;
    };
  }, [client, fileJson, hash, live, diff]);

  const choose = (next: Pick) => {
    setRecent(rememberPick(projectId, next));
    onPick(next.hash);
  };
  const name = hash
    ? (recent.find((entry) => entry.hash === hash)?.name ??
      data?.items[hash]?.name ??
      `Hash ${hash}`)
    : null;
  const shown = sample && sample.hash === hash ? sample : null;

  return (
    <div className={styles.preview}>
      <TooltipSearch onPick={choose} recent={recent} />
      {preview.newer && (
        <p className={styles.banner} data-tone="warn" role="status">
          A newer build is out (<When value={preview.newer.builtAt} nowrap />
          ).{' '}
          <button type="button" className={styles.linkButton} onClick={preview.adopt}>
            Reload preview
          </button>
        </p>
      )}
      <div className={styles.previewBar}>
        <span className={styles.badge} data-kind={liveLabel ? 'live' : 'build'}>
          {liveLabel ? 'Live file' : 'Preview build'}
        </span>
        <span className={styles.previewName} title={name ?? undefined}>
          {name ?? 'No tooltip picked'}
          {hash && <span className={styles.meta}> {hash}</span>}
        </span>
        <button
          type="button"
          className={styles.toggle}
          aria-pressed={diff && !!live && !liveLabel}
          disabled={!live || liveLabel}
          title={
            liveLabel
              ? 'This file is the live file'
              : live
                ? 'Word diff of this entry against the published file'
                : 'Not published yet: no live file to compare with'
          }
          onClick={() => setDiff(!diff)}
        >
          Diff vs live file
        </button>
      </div>
      <div
        className={styles.entry}
        aria-live="polite"
        data-config-version={version.current}
        data-rendered-version={shown?.version}
      >
        {siteError && !client && (
          <p role="alert" className={styles.badText}>
            The data site cannot be read: {siteError}
          </p>
        )}
        {preview.state.kind === 'loading' && !siteError && (
          <p role="status" className={styles.meta}>
            Loading the published data…
          </p>
        )}
        {preview.state.kind === 'error' && (
          <p role="alert" className={styles.badText}>
            {preview.state.mismatch
              ? 'The data site changed while the preview was loading. Reload the page.'
              : `The preview cannot load: ${preview.state.message}`}
          </p>
        )}
        {client && !hash && (
          <p className={styles.meta}>
            Find a tooltip to see its entry exactly as this file has it.
          </p>
        )}
        {client && hash && !shown && <p className={styles.meta}>Building…</p>}
        {shown && (
          <EntryView
            pair={shown.pair}
            diff={diff && !!live && !liveLabel}
            stale={shown.version !== version.current}
          />
        )}
      </div>
      <NumbersStrip
        file={file}
        fileJson={fileJson}
        live={live}
        numbers={client ? (request) => client.numbers(request, live) : null}
      />
    </div>
  );
}

function EntryView({ pair, diff, stale }: { pair: SamplePair; diff: boolean; stale: boolean }) {
  const after = pretty(pair.preview);
  if (pair.preview.kind === 'error')
    return (
      <p role="alert" className={styles.badText}>
        This file fails to build: {pair.preview.message}
      </p>
    );
  if (diff) {
    const before = pretty(pair.live);
    return (
      <div className={styles.diffView} data-stale={stale || undefined}>
        {pair.live?.kind !== 'entry' && (
          <p className={styles.meta}>
            {pair.live?.kind === 'error' ? pair.live.message : 'Not in the live file: all new.'}
          </p>
        )}
        {pair.preview.kind === 'absent' && (
          <p className={styles.meta}>Not in this file: {pair.preview.reason}.</p>
        )}
        <div className={styles.code}>
          <WordDiff before={before} after={after} />
        </div>
      </div>
    );
  }
  if (pair.preview.kind === 'absent')
    return <p className={styles.meta}>Not in this file: {pair.preview.reason}.</p>;
  return (
    <pre className={styles.code} data-stale={stale || undefined}>
      {after}
    </pre>
  );
}

const count = new Intl.NumberFormat('en');

function NumbersStrip({
  file,
  fileJson,
  live,
  numbers,
}: {
  file: ExportFile;
  fileJson: string;
  live: LiveRef | null;
  numbers: ((file: ExportFile) => Promise<FileNumbers>) | null;
}) {
  const [result, setResult] = useState<{ json: string; numbers: FileNumbers } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const request = useRef(0);
  const run = () => {
    if (!numbers) return;
    const id = ++request.current;
    setBusy(true);
    setError(null);
    numbers(file).then(
      (value) => {
        if (id !== request.current) return;
        setResult({ json: fileJson, numbers: value });
        setBusy(false);
      },
      (cause: Error) => {
        if (id !== request.current) return;
        setError(cause.message);
        setBusy(false);
      },
    );
  };
  const stale = result !== null && result.json !== fileJson;
  return (
    <div className={styles.numbers} aria-live="polite">
      <button type="button" className={styles.button} onClick={run} disabled={!numbers || busy}>
        {busy ? 'Building…' : result ? 'Rebuild file' : 'Build whole file'}
      </button>
      {error && <span className={styles.badText}>Build failed: {error}</span>}
      {result && !error && (
        <span className={styles.numberList} data-stale={stale || undefined}>
          <span>
            <b>{count.format(result.numbers.entries)}</b> entries
          </span>
          <span>
            <b>{formatBytes(result.numbers.raw)}</b> raw
          </span>
          {result.numbers.gzip !== null && (
            <span>
              <b>{formatBytes(result.numbers.gzip)}</b> gzip
            </span>
          )}
          <span>
            {result.numbers.changed === null ? (
              live ? (
                'live file unreadable'
              ) : (
                'not published yet'
              )
            ) : (
              <>
                <b>{count.format(result.numbers.changed)}</b> changed vs live
              </>
            )}
          </span>
          {stale && <span className={styles.meta}>before your last change</span>}
        </span>
      )}
      {!result && !error && !busy && (
        <span className={styles.meta}>Entries, size, and changes of the whole file</span>
      )}
    </div>
  );
}
