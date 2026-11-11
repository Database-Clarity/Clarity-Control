import { spawn } from 'node:child_process';
const run = (args, env = process.env) =>
  new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { env, windowsHide: true, stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`Proxy command exited ${code}`)),
    );
  });
await run(
  [
    'node_modules/vitest/vitest.mjs',
    'run',
    'apps/worker/test/reports.test.ts',
    '-t',
    'handler budget proxy',
  ],
  {
    ...process.env,
    REPORTS_BUDGET: '1',
    REPORTS_BUDGET_OUTPUT:
      'D:/GitHub/Description-editor/.agents/reports/reports-server-handler-proxy.json',
  },
);
await run(['apps/worker/test/reportsLocalConfirm.mjs'], {
  ...process.env,
  REPORTS_LOCAL_OUTPUT:
    'D:/GitHub/Description-editor/.agents/reports/reports-server-workerd-proxy.json',
});
