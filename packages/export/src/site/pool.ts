// Per-file isolation (spec section 3, "Workload bounds" and "build-site steps"): every file builds
// in a killable child process with a time limit, in a pool of two. A child parses the input once
// and then builds files one at a time; a child that times out or crashes is killed and replaced.
// Output validation (JSON, size, references, path) runs inside the child, so a file that breaks
// validation can never take the parent or another project down.
import { fork, type ChildProcess } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import type * as Engine from '../index.js';
import type { ExportFile } from '../v1/config.js';
import { sha256 } from './util.js';

export type ChildInit = {
  engineDir: string;
  inputPath: string;
  catalogPath: string;
  identicalPath: string;
};

export type BuildJob = {
  key: string;
  projectId: string;
  /** Site path, `<project>/v<format>/<file>.json`. */
  path: string;
  file: ExportFile;
  outPath: string;
  maxBytes: number;
};

export type BuildResult =
  | { key: string; ok: true; sha256: string; bytes: number; markers: string[]; notices: unknown[] }
  | { key: string; ok: false; error: string; reason: 'failed' | 'invalid' | 'timeout' | 'crashed' };

// --- child side -------------------------------------------------------------------------------

/** Entry of the child process (`build-site.mjs child`). */
export async function childMain() {
  let engine: typeof Engine | undefined;
  let input: Engine.LegacyInput | undefined;
  let options: Engine.CompileOptions | undefined;
  const send = (message: unknown) => process.send!(message);
  process.on('message', async (message: { type: string; init?: ChildInit; job?: BuildJob }) => {
    if (message.type === 'init' && message.init) {
      const init = message.init;
      engine = (await import(pathToFileURL(`${init.engineDir}/engine.mjs`).href)) as typeof Engine;
      input = JSON.parse(readFileSync(init.inputPath, 'utf8')) as Engine.LegacyInput;
      options = {
        catalog: JSON.parse(readFileSync(init.catalogPath, 'utf8')) as Engine.Catalog,
        identical: JSON.parse(readFileSync(init.identicalPath, 'utf8')) as number[],
      };
      send({ type: 'ready' });
      return;
    }
    if (message.type === 'build' && message.job)
      send({ type: 'done', result: buildOne(message.job) });
  });

  function buildOne(job: BuildJob): BuildResult {
    let bytes: Uint8Array;
    let notices: unknown[];
    try {
      const plan = engine!.compile(input!, job.file, options!);
      bytes = plan.bytes;
      notices = plan.notices;
    } catch (error) {
      return { key: job.key, ok: false, reason: 'failed', error: messageOf(error) };
    }
    // Output validation, inside the isolation (spec section 3, re-check F1).
    try {
      if (
        !job.path.startsWith(`${job.projectId}/`) ||
        job.path.split('/').some((part) => part === '..' || part === '' || part === '.')
      )
        throw new Error(`Path ${job.path} is outside project ${job.projectId}`);
      if (bytes.byteLength > job.maxBytes)
        throw new Error(`${bytes.byteLength} bytes is over the ${job.maxBytes}-byte limit`);
      const parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
      if (!engine!.isLegacyFile(job.file)) engine!.validateV1(parsed as Engine.FormatV1File);
      const markers = engine!.markerSet(parsed, engine!.outputTokens(job.file));
      writeFileSync(job.outPath, bytes);
      return {
        key: job.key,
        ok: true,
        sha256: sha256(bytes),
        bytes: bytes.byteLength,
        markers,
        notices,
      };
    } catch (error) {
      return { key: job.key, ok: false, reason: 'invalid', error: messageOf(error) };
    }
  }
}

const messageOf = (error: unknown) =>
  (error instanceof Error ? error.message : String(error)).slice(0, 500);

// --- parent side ------------------------------------------------------------------------------

type Worker = { child: ChildProcess; ready: Promise<void>; busy: boolean };

/** Environment a child gets: no tokens or secrets, only what Node needs. */
function childEnv(): NodeJS.ProcessEnv {
  const keep = [
    'PATH',
    'Path',
    'SYSTEMROOT',
    'SystemRoot',
    'TEMP',
    'TMP',
    'TMPDIR',
    'HOME',
    'USERPROFILE',
  ];
  return Object.fromEntries(
    keep.flatMap((name) => (process.env[name] ? [[name, process.env[name]]] : [])),
  );
}

export class BuildPool {
  private workers: Worker[] = [];
  private closed = false;

  constructor(
    private readonly script: string,
    private readonly init: ChildInit,
    private readonly size: number,
    private readonly timeoutMs: number,
  ) {}

  private spawn(): Worker {
    const child = fork(this.script, ['child'], {
      env: childEnv(),
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
      serialization: 'json',
    });
    const ready = new Promise<void>((resolve, reject) => {
      const onMessage = (message: { type: string }) => {
        if (message.type === 'ready') {
          child.off('message', onMessage);
          child.off('exit', onExit);
          resolve();
        }
      };
      const onExit = (code: number | null) =>
        reject(new Error(`Build child exited during start (${code})`));
      child.on('message', onMessage);
      child.once('exit', onExit);
    });
    child.send({ type: 'init', init: this.init });
    return { child, ready, busy: false };
  }

  private take(): Worker {
    let worker = this.workers.find(
      (candidate) =>
        !candidate.busy && candidate.child.exitCode === null && !candidate.child.killed,
    );
    if (!worker) {
      if (this.workers.length >= this.size) throw new Error('Pool is full');
      worker = this.spawn();
      this.workers.push(worker);
    }
    worker.busy = true;
    return worker;
  }

  private retire(worker: Worker) {
    worker.child.kill('SIGKILL');
    this.workers = this.workers.filter((candidate) => candidate !== worker);
  }

  get idle() {
    return this.size - this.workers.filter((worker) => worker.busy).length;
  }

  /** Builds one file; never rejects (a failure, timeout, or crash is a result). */
  async run(job: BuildJob): Promise<BuildResult> {
    if (this.closed) return { key: job.key, ok: false, reason: 'crashed', error: 'Pool closed' };
    const worker = this.take();
    try {
      await worker.ready;
    } catch (error) {
      this.retire(worker);
      return { key: job.key, ok: false, reason: 'crashed', error: messageOf(error) };
    }
    return new Promise<BuildResult>((resolve) => {
      const { child } = worker;
      const finish = (result: BuildResult, kill: boolean) => {
        clearTimeout(timer);
        child.off('message', onMessage);
        child.off('exit', onExit);
        if (kill) this.retire(worker);
        else worker.busy = false;
        resolve(result);
      };
      const onMessage = (message: { type: string; result?: BuildResult }) => {
        if (message.type === 'done' && message.result?.key === job.key)
          finish(message.result, false);
      };
      const onExit = (code: number | null, signal: string | null) =>
        finish(
          {
            key: job.key,
            ok: false,
            reason: 'crashed',
            error: `Build child exited (${code ?? signal})`,
          },
          true,
        );
      // The limit counts the build only, not the child's start (input parse).
      const timer = setTimeout(
        () =>
          finish(
            { key: job.key, ok: false, reason: 'timeout', error: `Over ${this.timeoutMs} ms` },
            true,
          ),
        this.timeoutMs,
      );
      child.on('message', onMessage);
      child.once('exit', onExit);
      child.send({ type: 'build', job });
    });
  }

  /** Kills every child (used at the end and when the job budget runs out). */
  close() {
    this.closed = true;
    for (const worker of this.workers) worker.child.kill('SIGKILL');
    this.workers = [];
  }
}
