import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
if (process.argv.includes('--code-review')) {
  const base = 'D:/GitHub/Description-editor/.agents/reports/';
  if (!existsSync(base + 'reports-server-security-baseline.json'))
    writeFileSync(
      base + 'reports-server-security-baseline.json',
      JSON.stringify(
        {
          candidate: '6f20ac85a77ff8f844ec320cbb8c538894741aec',
          handler: JSON.parse(readFileSync(base + 'reports-server-handler-proxy.json', 'utf8')),
          workerd: JSON.parse(readFileSync(base + 'reports-server-workerd-proxy.json', 'utf8')),
        },
        null,
        2,
      ),
    );
  process.env.REPORTS_BUDGET_FILTER =
    '^(POST max|Tooltip|Public anchors|Grouped list|Full index|Reanchor|Close action|Reopen action|Withdraw|Maintainer DELETE|Purge)';
}
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
