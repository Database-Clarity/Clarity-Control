import { spawn, execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
const child = spawn(
  process.execPath,
  [
    'node_modules/wrangler/bin/wrangler.js',
    'dev',
    '.wrangler/reports-local.mjs',
    '--config',
    'apps/worker/wrangler.jsonc',
    '--no-bundle',
    '--local',
    '--port',
    '5193',
    '--ip',
    '127.0.0.1',
    '--inspector-port',
    '0',
    '--persist-to',
    `.wrangler/reports-perf-${randomUUID()}`,
  ],
  { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
);
child.stderr.on('data', (data) => process.stderr.write(data));
let output = '';
try {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Wrangler readiness timeout')), 30000);
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`Wrangler exited ${code}`));
    });
    child.stdout.on('data', (data) => {
      output += data;
      process.stdout.write(data);
      if (output.includes('Ready on http')) {
        clearTimeout(timer);
        resolve();
      }
    });
  });
  const runner = spawn(process.execPath, ['.wrangler/reports-local-run.mjs'], {
    windowsHide: true,
    stdio: 'inherit',
  });
  process.exitCode = await new Promise((resolve) => runner.once('exit', resolve));
} finally {
  await new Promise((resolve) =>
    execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, () =>
      resolve(),
    ),
  );
}
