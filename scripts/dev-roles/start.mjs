import { randomBytes } from 'node:crypto';
import { mkdtemp, readdir, readFile, mkdir } from 'node:fs/promises';
import { createServer as createSocket } from 'node:net';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { convertV4MiniflareOptions, Miniflare, Response as WorkerResponse } from 'miniflare';
import { unstable_splitSqlQuery } from 'wrangler';
import {
  createServer,
  rolePlugin,
  localPath,
  localChallenge,
} from '../../apps/web/test/dev-role-web.mjs';
import { makeRoleChoices } from './identities.mjs';

const root = resolve(import.meta.dirname, '../..');
const workerRoot = join(root, 'apps/worker');
const databases = {
  SETTINGS_DB: 'settings',
  REPORTS_DB: 'reports',
  REPORTS_FILES_DB: 'files',
};

async function initDatabases(runtime) {
  for (const [binding, name] of Object.entries(databases)) {
    const db = await runtime.getD1Database(binding);
    const dir = join(workerRoot, 'migrations', name);
    for (const file of (await readdir(dir)).filter((file) => file.endsWith('.sql')).sort()) {
      const sql = await readFile(join(dir, file), 'utf8');
      await db.batch(unstable_splitSqlQuery(sql).map((statement) => db.prepare(statement)));
    }
  }
}

export async function startRoleHarness({ port, prepareSandbox }) {
  if (!Number.isInteger(port) || port < 1024 || port > 65535)
    throw new Error('Pass a free port between 1024 and 65535');
  const host = '127.0.0.1';
  const origin = `http://${host}:${port}`;
  // Report a port already in use before fetching and materializing the disposable data.
  // Vite's strict listen still catches any bind race after this preflight.
  await new Promise((resolve, reject) => {
    const probe = createSocket();
    probe.once('error', reject);
    probe.listen(port, host, () => probe.close((error) => (error ? reject(error) : resolve())));
  });
  const scratch = join(root, '.agents', 'dev-roles');
  await mkdir(scratch, { recursive: true });
  const directory = await mkdtemp(join(scratch, 'run-'));
  let roles;
  const sandbox = await prepareSandbox({
    directory,
    siteOrigin: origin,
    seedPermissions(config, projectIds) {
      const seeded = makeRoleChoices(config, projectIds);
      roles = seeded.roles;
      return seeded.permissions;
    },
  });
  if (!roles) throw new Error('The disposable permissions were not seeded');

  const runner = join(directory, 'runtime');
  const secret = randomBytes(32).toString('base64url');
  const challengeSecret = randomBytes(32).toString('base64url');
  await build({
    absWorkingDir: workerRoot,
    entryPoints: ['src/index.ts', 'src/crypto.ts'],
    outdir: runner,
    outExtension: { '.js': '.mjs' },
    bundle: true,
    platform: 'browser',
    format: 'esm',
    target: 'es2022',
  });
  const { signToken } = await import(pathToFileURL(join(runner, 'crypto.mjs')).href);
  const runtime = new Miniflare(
    convertV4MiniflareOptions({
      host,
      port: 0,
      cf: false,
      telemetry: { enabled: false },
      modules: true,
      scriptPath: join(runner, 'index.mjs'),
      compatibilityDate: '2025-11-01',
      compatibilityFlags: ['service_binding_extra_handlers'],
      bindings: {
        ...sandbox.bindings,
        SITE_ORIGIN: origin,
        SITE_ORIGINS: '',
        SITE_URL: `${origin}/`,
        SESSION_SECRET: secret,
        OAUTH_CALLBACK_URL: `${origin}${localPath}/api/auth/callback`,
        TURNSTILE_SECRET: challengeSecret,
      },
      d1Databases: Object.fromEntries(Object.keys(databases).map((name) => [name, name])),
      async outboundService(request) {
        let response;
        if (
          request.url === 'https://challenges.cloudflare.com/turnstile/v0/siteverify' &&
          request.method === 'POST'
        ) {
          const form = new URLSearchParams(await request.text());
          response = Response.json({
            success:
              form.get('response') === localChallenge && form.get('secret') === challengeSecret,
            hostname: host,
            action: 'report',
          });
        } else {
          response = await sandbox.fetch(request);
        }
        return new WorkerResponse(response.body, {
          status: response.status,
          statusText: response.statusText,
          headers: [...response.headers],
        });
      },
    }),
  );
  let server;
  let minuteTimer;
  let scheduledWork;
  const close = async () => {
    clearInterval(minuteTimer);
    try {
      await server?.close();
      await scheduledWork;
    } finally {
      await runtime.dispose();
    }
  };
  try {
    await initDatabases(runtime);
    const worker = await runtime.getWorker();
    let hour = Math.floor(Date.now() / 3_600_000);
    async function tick() {
      const now = Date.now();
      const currentHour = Math.floor(now / 3_600_000);
      await worker.scheduled({ cron: '* * * * *', scheduledTime: now });
      if (currentHour !== hour) {
        await worker.scheduled({ cron: '0 * * * *', scheduledTime: now });
        hour = currentHour;
      }
    }
    minuteTimer = setInterval(() => {
      if (scheduledWork) return;
      scheduledWork = tick()
        .catch((error) => console.error('Local scheduled event failed', error))
        .finally(() => {
          scheduledWork = undefined;
        });
    }, 60_000);
    server = await createServer({
      root: join(root, 'apps/web'),
      configLoader: 'runner',
      envFile: false,
      envPrefix: 'CLARITY_UNUSED_ENV_PREFIX_',
      define: {
        'import.meta.env.VITE_API_URL': JSON.stringify(`${localPath}/api`),
        'import.meta.env.VITE_GLOBALS_ENABLED': JSON.stringify('1'),
        // The local proxy serves the same datasets under loopback URLs.
        'import.meta.env.VITE_COMPENDIUM_GUIDANCE_SCOPE': JSON.stringify(
          'https://raw.githubusercontent.com/Database-Clarity/Live-Clarity-Database/editor-data-bundle/bundle.json|' +
            'https://raw.githubusercontent.com/Database-Clarity/Compendium-data/main/compendium.json',
        ),
      },
      plugins: [
        rolePlugin({
          origin,
          roles,
          issue: ({ id, login }) =>
            signToken(
              {
                id,
                login,
                purpose: 'session',
                exp: Math.floor(Date.now() / 1000) + 8 * 3600,
              },
              secret,
            ),
          upstream: sandbox.fetch,
          dispatch: runtime.dispatchFetch,
        }),
      ],
      server: {
        host,
        port,
        strictPort: true,
        fs: {
          deny: [
            '**/.agents/**',
            '**/.git',
            '**/.git/**',
            '**/.env*',
            '**/.dev.vars*',
            '**/.npmrc',
            '**/*.{pem,crt}',
          ],
        },
      },
    });
    await server.listen();
    return {
      origin,
      close,
      directory,
      dataGitDir: sandbox.dataGitDir,
      revisions: sandbox.revisions,
    };
  } catch (error) {
    await close();
    throw error;
  }
}

if (resolve(process.argv[1] ?? '') === import.meta.filename) {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== '--port'))
    throw new Error('Usage: npm run dev:roles -- [--port PORT]');
  const { prepareSandbox } = await import('./sandbox.mjs');
  console.log('Preparing disposable data and publication proofs');
  const app = await startRoleHarness({
    port: args.length ? Number(args[1]) : 5187,
    prepareSandbox,
  });
  console.log(`Clarity local roles ready at ${app.origin}/\nDisposable data: ${app.dataGitDir}`);
  console.log(app.revisions);
  for (const signal of ['SIGINT', 'SIGTERM'])
    process.once(signal, () => {
      void app.close();
    });
}
