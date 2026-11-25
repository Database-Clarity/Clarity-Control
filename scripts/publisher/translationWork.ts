import { fork } from 'node:child_process';
import type { TranslationPublishPayload } from '../../packages/core/src/index.js';
import { LocalRepository, type Repository } from './git.js';
import { GlobalsPublisher } from './globals.js';
import { Publisher, type Options } from './publisher.js';
import {
  bundleTranslations,
  planTranslations,
  TranslationPartRefusal,
  translationCheckRefusal,
} from './translations.js';

type Source = {
  options: Omit<Options, 'now'>;
  source: string;
  live: string;
};
type Job = Source & ({ kind: 'preview' } | { kind: 'plan'; payload: TranslationPublishPayload });
type Response =
  | { kind: 'preview'; value: Awaited<ReturnType<typeof bundleTranslations>> }
  | { kind: 'plan'; value: Awaited<ReturnType<typeof planTranslations>> }
  | { kind: 'refused'; rows: TranslationPartRefusal['rows'] };

class TranslationReadOnlyRepository extends LocalRepository {
  protected override preserveModes = true;
  override writeBlob(): never {
    throw new Error('Translation check is read-only');
  }
  override commit(): never {
    throw new Error('Translation check is read-only');
  }
  override cas(): never {
    throw new Error('Translation check is read-only');
  }
  override casMany(): never {
    throw new Error('Translation check is read-only');
  }
}

export async function translationWorkChild(path: string) {
  const job = await new Promise<Job>((resolve) => process.once('message', resolve));
  const { source, live, options } = job;
  if (!/^[a-f0-9]{40}$/.test(source) || !/^[a-f0-9]{40}$/.test(live))
    throw new Error('Translation check requires pinned commits');
  const git = new TranslationReadOnlyRepository(path);
  const pub = new Publisher(git, { ...options, now: Date.now });
  const tree = git.tree(source);
  let result: Response;
  if (job.kind === 'preview') {
    const docs = new GlobalsPublisher(pub).documents(tree, 'tooltips');
    result = { kind: 'preview', value: await bundleTranslations(pub, tree, live, docs) };
  } else {
    try {
      result = { kind: 'plan', value: await planTranslations(pub, tree, live, job.payload) };
    } catch (error) {
      if (!(error instanceof TranslationPartRefusal)) throw error;
      result = { kind: 'refused', rows: error.rows };
    }
  }
  await new Promise<void>((resolve, reject) => {
    process.send!(result, (error) => (error ? reject(error) : resolve()));
  });
  process.disconnect!();
}

// The installed runtime supplies this adapter. The child only sees the disposable object
// store and pinned commits. A CPU-bound check cannot hold the publisher past its timeout.
export function createTranslationWork(
  runtime: string,
  previewTimeout = 120_000,
  planTimeout = 45_000,
) {
  const run = (
    git: Repository,
    options: Options,
    job: Omit<Source, 'options'> &
      ({ kind: 'preview' } | { kind: 'plan'; payload: TranslationPublishPayload }),
    timeout: number,
  ) => {
    if (!(git instanceof LocalRepository))
      throw new Error('Missing translation check object store');
    const snapshotOptions = { ...options, now: undefined };
    return new Promise<Response | 'timeout' | undefined>((resolve) => {
      const child = fork(runtime, ['--translation-work', git.path], {
        execArgv: ['--max-old-space-size=768'],
        serialization: 'advanced',
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        env: {
          PATH: process.env.PATH,
          SystemRoot: process.env.SystemRoot,
          TEMP: process.env.TEMP,
          TMP: process.env.TMP,
        },
      });
      let response: Response | undefined;
      let timedOut = false;
      const finish = (result?: Response | 'timeout') => {
        clearTimeout(timer);
        resolve(result);
      };
      const timer = setTimeout(() => {
        timedOut = true;
        if (!child.kill('SIGKILL')) finish('timeout');
      }, timeout);
      child.once('error', () => finish());
      child.once('close', (code) =>
        finish(timedOut ? 'timeout' : code === 0 ? response : undefined),
      );
      child.once('message', (message: Response) => (response = message));
      child.send({ ...job, options: snapshotOptions } satisfies Job, (error) => {
        if (error) child.kill('SIGKILL');
      });
    });
  };
  return {
    async preview(git: Repository, options: Options, source: string, live: string) {
      const result = await run(git, options, { kind: 'preview', source, live }, previewTimeout);
      if (result && result !== 'timeout' && result.kind === 'preview') return result.value;
    },
    async plan(
      git: Repository,
      options: Options,
      source: string,
      live: string,
      payload: TranslationPublishPayload,
    ) {
      const result = await run(git, options, { kind: 'plan', source, live, payload }, planTimeout);
      if (result === 'timeout') throw translationCheckRefusal(payload.rows);
      if (result?.kind === 'plan') return result.value;
      if (result?.kind === 'refused') throw new TranslationPartRefusal(result.rows);
      throw translationCheckRefusal(payload.rows, 'review-changed');
    },
  };
}

export type TranslationWork = ReturnType<typeof createTranslationWork>;
