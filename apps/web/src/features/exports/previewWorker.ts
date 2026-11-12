/// <reference lib="webworker" />
// The export preview's Web Worker (spec section 3, "Pinned engine and inputs"): it fetches the
// snapshot's engine.mjs as text, verifies its sha256, and imports it from a blob: URL, so every
// build here uses exactly the engine the data site was built with. Samples coalesce: only the
// newest sample request is answered (older ones are superseded on the page).
import type { ExportFile } from '@clarity/export';
import {
  loadSnapshot,
  Preview,
  SnapshotMismatch,
  type Engine,
  type LiveRef,
  type PreviewIo,
} from './previewCore';
import type { BuildStatus } from './site';

export type PreviewRequest =
  | { type: 'init'; site: string; liveRaw: string; status: BuildStatus }
  | {
      type: 'sample';
      id: number;
      file: ExportFile;
      hash: string;
      live: LiveRef | null;
      withLive: boolean;
    }
  | { type: 'numbers'; id: number; file: ExportFile; live: LiveRef | null }
  | { type: 'bytes'; id: number; file: ExportFile }
  | { type: 'published'; id: number; language: string };

export type PreviewReply =
  | { type: 'ready'; buildId: string }
  | { type: 'init-error'; message: string; mismatch: boolean }
  | { type: 'result'; id: number; result: unknown; ms: number }
  | { type: 'error'; id: number; message: string };

const scope = self as unknown as DedicatedWorkerGlobalScope;

const io: PreviewIo = {
  fetch: (url, init) => fetch(url, init),
  async importEngine(source) {
    const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
    try {
      return (await import(/* @vite-ignore */ url)) as Engine;
    } finally {
      URL.revokeObjectURL(url);
    }
  },
  async sha256(bytes) {
    const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  },
  async gzipSize(bytes) {
    if (typeof CompressionStream === 'undefined') return null;
    const stream = new Blob([bytes as BlobPart])
      .stream()
      .pipeThrough(new CompressionStream('gzip'));
    return (await new Response(stream).arrayBuffer()).byteLength;
  },
};

let preview: Promise<Preview> | null = null;
let latestSample: Extract<PreviewRequest, { type: 'sample' }> | null = null;
let sampling = false;

const post = (reply: PreviewReply) => scope.postMessage(reply);

async function answer(id: number, work: () => Promise<unknown>) {
  const started = performance.now();
  try {
    const result = await work();
    post({ type: 'result', id, result, ms: performance.now() - started });
  } catch (error) {
    post({ type: 'error', id, message: error instanceof Error ? error.message : String(error) });
  }
}

async function drainSamples() {
  if (sampling) return;
  sampling = true;
  try {
    while (latestSample) {
      const request = latestSample;
      latestSample = null;
      const ready = await preview!;
      await answer(request.id, async () => ({
        preview: await ready.sample(request.file, request.hash, request.live),
        live:
          request.withLive && request.live
            ? await ready.liveSample(request.live, request.hash)
            : null,
      }));
    }
  } finally {
    sampling = false;
  }
}

scope.onmessage = (event: MessageEvent<PreviewRequest>) => {
  const request = event.data;
  if (request.type === 'init') {
    preview = loadSnapshot(io, request.site, request.status).then(
      (snapshot) => new Preview(io, snapshot, { site: request.site, liveRaw: request.liveRaw }),
    );
    preview.then(
      () => post({ type: 'ready', buildId: request.status.buildId }),
      (error: unknown) =>
        post({
          type: 'init-error',
          message: error instanceof Error ? error.message : String(error),
          mismatch: error instanceof SnapshotMismatch,
        }),
    );
    return;
  }
  if (!preview) {
    post({ type: 'error', id: request.id, message: 'The preview is not loaded' });
    return;
  }
  if (request.type === 'sample') {
    latestSample = request;
    void drainSamples();
    return;
  }
  const ready = preview;
  if (request.type === 'numbers')
    void answer(request.id, async () => (await ready).numbers(request.file, request.live));
  else if (request.type === 'bytes')
    void answer(request.id, async () => {
      const bytes = await (await ready).bytes(request.file);
      return { sha256: await io.sha256(bytes), bytes: bytes.byteLength };
    });
  else if (request.type === 'published')
    void answer(request.id, async () => (await ready).published(request.language));
};
