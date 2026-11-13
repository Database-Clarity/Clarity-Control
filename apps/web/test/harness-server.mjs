import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build, createServer, preview } from 'vite';

// The browser harnesses' server. By default it builds the synthetic test pages with the app's
// own Vite config (production mode: the real plugins, chunking, and workers) and serves the
// built assets with `vite preview`, so a harness checks what ships. HARNESS_PREBUILT=<dir>
// reuses a build made by `node apps/web/test/harness-server.mjs <dir>` (one build for many
// harnesses); HARNESS_SERVER=dev serves the sources through the dev server instead.

/** Every synthetic page a browser harness opens. */
export const harnessPages = ['shell.html', 'history-hover.html', 'reference-hover.html'];

/** Builds the test pages into `outDir` (a new temporary directory when omitted). */
export async function buildHarnessPages(web, outDir) {
  const dir = outDir ?? (await mkdtemp(join(tmpdir(), 'clarity-harness-')));
  process.env.VITE_API_URL ??= 'https://api.fixture.invalid';
  await build({
    root: web,
    configLoader: 'runner',
    logLevel: 'error',
    build: {
      outDir: dir,
      emptyOutDir: true,
      rollupOptions: { input: harnessPages.map((page) => resolve(web, 'test', page)) },
    },
  });
  return dir;
}

/** Starts the server on 127.0.0.1:`port` (strict); `close()` stops it. */
export async function startHarnessServer(web, port) {
  process.env.VITE_API_URL ??= 'https://api.fixture.invalid';
  const host = { host: '127.0.0.1', port, strictPort: true };
  if (process.env.HARNESS_SERVER === 'dev') {
    const server = await createServer({ root: web, configLoader: 'runner', server: host });
    await server.listen();
    console.log(`harness server: dev (sources) on ${port}`);
    return { close: () => server.close() };
  }
  const outDir = process.env.HARNESS_PREBUILT || (await buildHarnessPages(web));
  const server = await preview({
    root: web,
    configLoader: 'runner',
    logLevel: 'error',
    build: { outDir },
    preview: host,
  });
  console.log(`harness server: production build ${outDir} on ${port}`);
  return {
    close: () => new Promise((done) => server.httpServer.close(() => done())),
  };
}

// CLI: build the pages once, for HARNESS_PREBUILT.
if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const web = resolve(import.meta.dirname, '..');
  console.log(await buildHarnessPages(web, process.argv[2] && resolve(process.argv[2])));
}
