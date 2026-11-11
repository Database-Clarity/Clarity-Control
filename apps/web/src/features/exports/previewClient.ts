// Main-thread side of the preview worker. Two workers share one snapshot (the status the page
// read): one answers samples, the other runs whole-file builds, so a sample never waits behind a
// full build (spec section 8, snappiness).
import type { ExportFile } from '@clarity/export';
import type { FileNumbers, LiveRef, SampleResult } from './previewCore';
import type { PreviewReply, PreviewRequest } from './previewWorker';
import { dataSiteUrl, liveRawUrl, type BuildStatus } from './site';

export interface SamplePair {
  preview: SampleResult;
  live: SampleResult | null;
}

type Pending = { resolve(value: unknown): void; reject(error: Error): void };

class Channel {
  private worker: Worker;
  private pending = new Map<number, Pending>();
  private next = 1;
  private latestSample: { id: number; resolve(value: SamplePair | null): void } | null = null;
  readonly ready: Promise<void>;

  constructor(status: BuildStatus) {
    this.worker = new Worker(new URL('./previewWorker.ts', import.meta.url), { type: 'module' });
    this.ready = new Promise((resolve, reject) => {
      this.worker.onmessage = (event: MessageEvent<PreviewReply>) => {
        const reply = event.data;
        if (reply.type === 'ready') return resolve();
        if (reply.type === 'init-error') {
          const error = new Error(reply.message);
          (error as Error & { mismatch?: boolean }).mismatch = reply.mismatch;
          return reject(error);
        }
        const pending = this.pending.get(reply.id);
        if (!pending) return;
        this.pending.delete(reply.id);
        if (reply.type === 'result') pending.resolve(reply.result);
        else pending.reject(new Error(reply.message));
      };
      this.worker.onerror = (event) => reject(new Error(event.message || 'The preview failed'));
    });
    this.ready.catch(() => undefined);
    this.post({ type: 'init', site: dataSiteUrl, liveRaw: liveRawUrl, status });
  }

  private post(request: PreviewRequest) {
    this.worker.postMessage(request);
  }

  request<T>(make: (id: number) => PreviewRequest): Promise<T> {
    const id = this.next++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      this.post(make(id));
    });
  }

  /** The newest sample wins: an older one still waiting resolves to null. */
  sample(file: ExportFile, hash: string, live: LiveRef | null, withLive: boolean) {
    this.latestSample?.resolve(null);
    const id = this.next++;
    return new Promise<SamplePair | null>((resolve, reject) => {
      this.latestSample = { id, resolve };
      this.pending.set(id, {
        resolve: (value) => {
          if (this.latestSample?.id === id) this.latestSample = null;
          resolve(value as SamplePair);
        },
        reject,
      });
      this.post({ type: 'sample', id, file, hash, live, withLive });
    });
  }

  dispose() {
    this.worker.terminate();
    for (const pending of this.pending.values()) pending.reject(new Error('Preview closed'));
    this.pending.clear();
    this.latestSample?.resolve(null);
  }
}

export class PreviewClient {
  private samples: Channel;
  private builds: Channel | null = null;
  readonly ready: Promise<void>;

  constructor(readonly status: BuildStatus) {
    this.samples = new Channel(status);
    this.ready = this.samples.ready;
  }

  sample(file: ExportFile, hash: string, live: LiveRef | null, withLive = false) {
    return this.samples.sample(file, hash, live, withLive);
  }

  /** Whole-file numbers; the build worker starts on first use. */
  numbers(file: ExportFile, live: LiveRef | null): Promise<FileNumbers> {
    this.builds ??= new Channel(this.status);
    const builds = this.builds;
    return builds.ready.then(() =>
      builds.request<FileNumbers>((id) => ({ type: 'numbers', id, file, live })),
    );
  }

  /** sha256 and size of a whole-file build (render QA compares them with build-site's). */
  fileHash(file: ExportFile): Promise<{ sha256: string; bytes: number }> {
    this.builds ??= new Channel(this.status);
    const builds = this.builds;
    return builds.ready.then(() => builds.request((id) => ({ type: 'bytes', id, file })));
  }

  published(language: string) {
    return this.ready.then(() =>
      this.samples.request<{ variables: string; titles: string; texts: Record<string, string> }>(
        (id) => ({ type: 'published', id, language }),
      ),
    );
  }

  dispose() {
    this.samples.dispose();
    this.builds?.dispose();
  }
}
