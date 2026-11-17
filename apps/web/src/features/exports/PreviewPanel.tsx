import {
  showcaseGlobals,
  showcaseId,
  showcaseName,
  type Lang,
  type MarkupLine,
} from '@clarity/core';
import { TooltipPreview } from '../preview';
import { MarkupLines } from '../preview/MarkupRenderer';
import { SkeletonBoundary } from '../../ui/Skeleton';
// The preview column (spec section 8, Exports redesign): the picked perk twice, side by side.
// "Rendered" draws the output itself (what an app that draws every part it receives shows),
// "Output" prints the entry exactly as the file has it, one tooltip line per row. After a config
// change, the rows it changed are marked in both until the next change. Under the tooltip,
// "Markup source" shows what the editors wrote. The Feature showcase is always offered: the file's
// include flag only decides whether the published file carries it.
import { deployedLegacyPresets } from '@clarity/export';
import { isLegacyFile, type ExportFile } from '@clarity/export/config';
import { useEffect, useMemo, useRef, useState, type MutableRefObject } from 'react';
import { languageLabel } from '../../languageLabels';
import { useDataStore } from '../../stores/data';
import { WordDiff } from '../../ui/diff';
import { When } from '../../ui/When';
import { classifiedCategory, editorName, itemFor, previewPiece } from '../navigation/catalog';
import { previewPieceIcon } from '../navigation/groupIcons';
import { formatBytes } from './BuildStatus';
import { fileKey, fileLanguages, savedFile, urlFor, type ProjectState } from './configModel';
import {
  isV1Lines,
  lastEdit,
  outputRows,
  renderLine,
  rowKey,
  rowsText,
  type Description,
  type Descriptions,
  type Row,
} from './output';
import type { FileNumbers, LiveRef, SampleResult } from './previewCore';
import type { SamplePair } from './previewClient';
import { recentPicks, rememberPick, TooltipSearch, type Pick } from './TooltipSearch';
import { usePreview, useSiteStore } from './useSite';
import styles from './Exports.module.scss';

const showsLive = (file: ExportFile) =>
  isLegacyFile(file) && (deployedLegacyPresets as readonly string[]).includes(file.preset);

/**
 * Where this file's published copy is: the pinned legacy file, or the saved file's URL on the
 * site (for a file split per language, the URL of the shown language).
 */
export function liveRefFor(
  state: ProjectState,
  file: ExportFile,
  projectId: string,
  manifest: ReturnType<typeof useSiteStore.getState>['manifest'],
  language: string | null = null,
): LiveRef | null {
  if (showsLive(file)) return { kind: 'legacy', name: `${file.preset}.json` };
  const saved = savedFile(state, file);
  if (!saved) return null;
  const path = urlFor(projectId, saved, language);
  const published = manifest?.files[path];
  return published ? { kind: 'site', path, sha256: published.sha256 } : null;
}

/**
 * The output last shown on this page, kept by the page (not the panel) so the phone's Preview
 * tab marks everything changed while the Config tab was open. `before` holds the rows of the
 * output before the change `fileJson` made; `key` names the file, perk, and language.
 */
export interface LastOutput {
  key: string;
  fileJson: string;
  rows: Set<string>;
  before: Set<string> | null;
}

const descriptionsOf = (result: SampleResult | null | undefined): Descriptions =>
  result?.kind === 'entry'
    ? ((result.entry as { descriptions?: Descriptions }).descriptions ?? {})
    : {};

export function PreviewPanel({
  projectId,
  state,
  file,
  pick,
  onPick,
  language: picked,
  onLanguage,
  lastOutput,
}: {
  projectId: string;
  state: ProjectState;
  file: ExportFile;
  pick: string | null;
  onPick(hash: string): void;
  /** The language picked on this page (the header shows its URL too). */
  language: string | null;
  onLanguage(language: string): void;
  lastOutput: MutableRefObject<LastOutput | null>;
}) {
  const preview = usePreview();
  const manifest = useSiteStore((site) => site.manifest);
  const siteError = useSiteStore((site) => site.error);
  const data = useDataStore((store) => store.data);
  const [recent, setRecent] = useState(() => recentPicks(projectId));
  const [diff, setDiff] = useState(false);
  const legacy = isLegacyFile(file);
  const perLanguage = !legacy && file.data.languageFiles === 'perLanguage';
  const liveLabel = showsLive(file);
  const fileJson = useMemo(() => JSON.stringify(file), [file]);
  const languages = fileLanguages(file);
  const lang = picked !== null && languages.includes(picked) ? picked : (languages[0] ?? null);
  // Compared by value: an edit elsewhere in the project must not restart the sample.
  const liveKey = JSON.stringify(liveRefFor(state, file, projectId, manifest, lang));
  const live = useMemo(() => JSON.parse(liveKey) as LiveRef | null, [liveKey]);
  // Legacy files never carry the showcase: they start with no perk picked.
  const hash = pick ?? (legacy ? null : showcaseId);
  const showcase = hash === showcaseId;
  const included = !legacy && !!file.data.includeShowcase;
  const canDiff = !!live && !liveLabel && !(showcase && !included);
  const diffOn = diff && canDiff;
  const memoryKey = `${fileKey(file)}\n${hash}\n${lang}`;

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
    key: string;
    /** Row keys of the output before the config change this sample answers. */
    before: Set<string> | null;
  } | null>(null);
  const client = preview.state.kind === 'ready' ? preview.state.client : null;
  useEffect(() => {
    if (!client || !hash) return;
    const asked = version.current;
    let current = true;
    const show = (pair: SamplePair) => {
      const memory = lastOutput.current;
      // The same perk and language: a new config compares with the output shown before it, the
      // same config (a remount, the diff toggle) keeps its marks. Anything else starts clean.
      const before =
        memory?.key === memoryKey
          ? memory.fileJson === fileJson
            ? memory.before
            : memory.rows
          : null;
      if (pair.preview.kind === 'entry')
        lastOutput.current = {
          key: memoryKey,
          fileJson,
          rows: new Set(outputRows(pair.preview.entry).map(rowKey)),
          before,
        };
      setSample({ pair, version: asked, key: memoryKey, before });
    };
    client.sample(JSON.parse(fileJson) as ExportFile, hash, live, diffOn, lang).then(
      (pair) => {
        if (pair && current) show(pair);
      },
      (error: Error) =>
        current && show({ preview: { kind: 'error', message: error.message }, live: null }),
    );
    return () => {
      current = false;
    };
  }, [client, fileJson, hash, live, diffOn, lang, memoryKey, lastOutput]);

  const choose = (next: Pick) => {
    setRecent(rememberPick(projectId, next));
    onPick(next.hash);
  };
  const item = data && hash && !showcase ? itemFor(Number(hash), data) : undefined;
  const name = showcase
    ? showcaseName
    : hash
      ? (recent.find((entry) => entry.hash === hash)?.name ??
        (item ? editorName(item) : undefined) ??
        `Hash ${hash}`)
      : null;
  const shown = sample && sample.key === memoryKey ? sample : null;
  const result = shown?.pair.preview;
  const descriptions = descriptionsOf(result);
  // Legacy files have no language list: they offer the languages the entry carries.
  const options = legacy ? Object.keys(descriptions) : languages;
  const rendered = legacy
    ? picked !== null && options.includes(picked)
      ? picked
      : (options[0] ?? 'en')
    : (lang ?? 'en');

  // Rendered draws format v1 output only: legacy files keep their own shapes, and an engine
  // older than this page (before its install) writes the old lines.
  const olderEngine =
    !legacy &&
    Object.values(descriptions).some((text) => typeof text !== 'string' && !isV1Lines(text));
  const drawn = !legacy && !olderEngine;
  const rows = useMemo(() => (result?.kind === 'entry' ? outputRows(result.entry) : []), [result]);
  const edit = useMemo(
    () => (shown?.before && result?.kind === 'entry' ? lastEdit(rows, shown.before) : null),
    [rows, shown?.before, result?.kind],
  );
  const changedLines = useMemo(() => {
    const lines = new Set<number>();
    for (const row of edit?.changed ?? [])
      if (row.line?.language === rendered) lines.add(row.line.index);
    return lines;
  }, [edit, rendered]);
  const path = legacy
    ? `${projectId}/v${file.formatVersion}/${file.id}.json`
    : urlFor(projectId, file, lang);

  return (
    <div className={styles.preview}>
      <TooltipSearch
        onPick={choose}
        recent={recent}
        current={hash}
        lead={
          legacy ? undefined : (
            <button
              type="button"
              className={styles.recentPick}
              aria-pressed={showcase}
              title="The built-in example: one line for every formatting option"
              onClick={() => onPick(showcaseId)}
            >
              {showcaseName}
            </button>
          )
        }
      />
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
          {name ?? 'No perk picked'}
          {hash && !showcase && <span className={styles.meta}> {hash}</span>}
        </span>
        {showcase && (
          <span className={styles.barNote}>
            {included ? 'In your file as perk -1' : 'Example only, not in your file'}
          </span>
        )}
        {options.length > 1 && (
          <label className={styles.inlineLabel}>
            <span className={styles.visuallyHidden}>
              {perLanguage ? 'Language file' : 'Rendered language'}
            </span>
            <select
              className={styles.select}
              value={rendered}
              onChange={(event) => onLanguage(event.target.value)}
            >
              {options.map((code) => (
                <option key={code} value={code}>
                  {languageLabel(code as Lang)}
                </option>
              ))}
            </select>
          </label>
        )}
        {canDiff && (
          <button
            type="button"
            className={styles.toggle}
            aria-pressed={diffOn}
            title="Word diff of this perk against the published file"
            onClick={() => setDiff(!diff)}
          >
            Diff vs live file
          </button>
        )}
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
        {preview.state.kind === 'error' && (
          <p role="alert" className={styles.badText}>
            {preview.state.mismatch
              ? 'The data site changed while the preview was loading. Reload the page.'
              : `The preview cannot load: ${preview.state.message}`}
          </p>
        )}
        <SkeletonBoundary
          pending={preview.state.kind === 'loading' || !!(client && hash && !shown)}
          error={!!siteError || preview.state.kind === 'error'}
          identity={hash}
          label="Loading the published data…"
        >
          {client && !hash && (
            <p className={styles.meta}>
              Legacy files have no showcase. Find a perk to see it exactly as this file has it.
            </p>
          )}
          {result?.kind === 'error' && (
            <p role="alert" className={styles.badText}>
              This file fails to build: {result.message}
            </p>
          )}
          {result?.kind === 'absent' && (
            <p className={styles.meta}>Not in this file: {result.reason}.</p>
          )}
          {shown && result?.kind === 'entry' && olderEngine && (
            <p className={styles.meta}>
              The data site’s engine is older than this page: Rendered appears after the engine
              install.
            </p>
          )}
          {shown && result?.kind === 'entry' && (
            <div
              className={styles.panes}
              data-stale={shown.version !== version.current || undefined}
              data-single={!drawn || undefined}
            >
              {drawn && (
                <section className={styles.pane} aria-label="Rendered">
                  <h3 className={styles.paneHeading}>
                    Rendered
                    <span className={styles.meta}>
                      {typeof descriptions[rendered] === 'string'
                        ? 'the string, as plain text'
                        : 'drawn from the output'}
                    </span>
                  </h3>
                  <TooltipPreview
                    text=""
                    lang={rendered as Lang}
                    name={name ?? ''}
                    piece={item ? previewPiece(item) : undefined}
                    pieceIcon={item ? previewPieceIcon(item) : undefined}
                    icon={item?.icon}
                    categoryLabel={item && data ? classifiedCategory(item, data)?.label : undefined}
                    globals={showcaseGlobals}
                  >
                    <RenderedLines
                      text={descriptions[rendered]}
                      language={rendered}
                      changed={changedLines}
                    />
                  </TooltipPreview>
                  {result.standIn && (
                    <p className={styles.meta}>
                      No {languageLabel(rendered as Lang)} text yet: the English text stands in.
                    </p>
                  )}
                  {result.source !== undefined && <MarkupSource text={result.source} />}
                </section>
              )}
              <section className={styles.pane} aria-label="Output">
                <h3 className={styles.paneHeading}>
                  {diffOn ? 'Output, changes against the live file' : 'Output'}
                  {!diffOn && <span className={styles.path}>{path}</span>}
                  {!diffOn && edit && (
                    <span
                      className={styles.lastEdit}
                      data-none={!edit.changed.size || undefined}
                      role="status"
                    >
                      {edit.message}
                    </span>
                  )}
                  <CopyJson entry={result.entry} />
                </h3>
                {diffOn ? (
                  <DiffView live={shown.pair.live} after={rowsText(rows)} />
                ) : (
                  <OutputView rows={rows} changed={edit?.changed ?? null} />
                )}
              </section>
            </div>
          )}
        </SkeletonBoundary>
      </div>
      <NumbersStrip
        fileJson={`${fileJson}\n${lang}`}
        live={live}
        numbers={client ? () => client.numbers(file, live, lang) : null}
      />
    </div>
  );
}

/** The output drawn as an app that draws every part it receives would draw it. */
function RenderedLines({
  text,
  language,
  changed,
}: {
  text: Description | undefined;
  language: string;
  changed: ReadonlySet<number>;
}) {
  const lines = useMemo(() => (isV1Lines(text) ? text.map(renderLine) : []), [text]);
  const marked = useMemo(
    () => new Set<MarkupLine>(lines.filter((_, index) => changed.has(index))),
    [lines, changed],
  );
  if (text === undefined)
    return (
      <span className={styles.meta}>
        No {languageLabel(language as Lang)} text in this perk: apps fall back to its English text.
      </span>
    );
  if (typeof text === 'string')
    return (
      <>
        {text.split('\n').map((line, index) => (
          <div
            key={index}
            className={`${styles.textLine} ${changed.has(index) ? styles.changedLine : ''}`}
          >
            {line || ' '}
          </div>
        ))}
      </>
    );
  return (
    <MarkupLines
      lines={lines}
      lineClass={(line) => (marked.has(line) ? styles.changedLine : undefined)}
    />
  );
}

function OutputView({ rows, changed }: { rows: readonly Row[]; changed: ReadonlySet<Row> | null }) {
  const box = useRef<HTMLDivElement>(null);
  // The first row the last edit changed comes into view (inside this box only).
  useEffect(() => {
    const first = box.current?.querySelector<HTMLElement>('[data-changed]');
    if (!first || !box.current) return;
    const outer = box.current.getBoundingClientRect();
    const inner = first.getBoundingClientRect();
    if (inner.top < outer.top || inner.bottom > outer.bottom)
      box.current.scrollTop += inner.top - outer.top - outer.height / 3;
  }, [changed]);
  return (
    <div ref={box} className={styles.output} tabIndex={0} aria-label="Perk as this file has it">
      {rows.map((row, index) => (
        <div
          key={index}
          className={styles.outputRow}
          style={{ paddingLeft: `${row.indent * 0.75 + 1.5}rem` }}
          data-changed={changed?.has(row) || undefined}
        >
          {row.text}
        </div>
      ))}
    </div>
  );
}

function DiffView({ live, after }: { live: SampleResult | null; after: string }) {
  const before = live?.kind === 'entry' ? rowsText(outputRows(live.entry)) : '';
  return (
    <div
      className={`${styles.output} ${styles.outputDiff}`}
      tabIndex={0}
      aria-label="Changes against the live file"
    >
      {live?.kind !== 'entry' ? (
        <p className={styles.meta}>
          {live?.kind === 'error' ? live.message : 'Not in the live file: all new.'}
        </p>
      ) : before === after ? (
        <p className={styles.meta}>Same as the live file.</p>
      ) : null}
      {before !== after && <WordDiff before={before} after={after} />}
    </div>
  );
}

function CopyJson({ entry }: { entry: unknown }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1500);
    return () => window.clearTimeout(timer);
  }, [copied]);
  return (
    <button
      type="button"
      className={styles.paneAction}
      onClick={() =>
        void navigator.clipboard?.writeText(JSON.stringify(entry, null, 2)).then(
          () => setCopied(true),
          () => undefined,
        )
      }
    >
      {copied ? 'Copied' : 'Copy JSON'}
    </button>
  );
}

const sourceKey = 'exports:markup-source';

/** What the editors wrote, on request (open or closed is remembered on this device). */
function MarkupSource({ text }: { text: string }) {
  const [open, setOpen] = useState(() => {
    try {
      return localStorage.getItem(sourceKey) === '1';
    } catch {
      return false;
    }
  });
  const toggle = () => {
    try {
      localStorage.setItem(sourceKey, open ? '0' : '1');
    } catch {
      // Private windows: the choice stays for this page only.
    }
    setOpen(!open);
  };
  return (
    <div className={styles.source}>
      <button type="button" className={styles.disclosure} aria-expanded={open} onClick={toggle}>
        <span aria-hidden="true">{open ? '▾' : '▸'}</span> Markup source
        <span className={styles.groupCount}>what the editors wrote, before export</span>
      </button>
      {open && <pre className={styles.sourceText}>{text}</pre>}
    </div>
  );
}

const count = new Intl.NumberFormat('en');

function NumbersStrip({
  fileJson,
  live,
  numbers,
}: {
  /** The file and shown language the numbers belong to. */
  fileJson: string;
  live: LiveRef | null;
  numbers: (() => Promise<FileNumbers>) | null;
}) {
  const [result, setResult] = useState<{ json: string; numbers: FileNumbers } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const request = useRef(0);
  const run = () => {
    if (!numbers) return;
    const id = ++request.current;
    const json = fileJson;
    setBusy(true);
    setError(null);
    numbers().then(
      (value) => {
        if (id !== request.current) return;
        setResult({ json, numbers: value });
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
