import { generateKeyPairSync } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { reportBudgetCases } from './reportsBudgetCases.js';
const root = process.argv[2] ?? 'http://127.0.0.1:5193';
const checked = async (path: string, init?: RequestInit) => {
  const response = await fetch(root + path, init);
  if (!response.ok) throw new Error(`${path}: ${response.status} ${await response.text()}`);
  return response;
};
await checked('/__configure', {
  method: 'POST',
  body: generateKeyPairSync('rsa', { modulusLength: 2048 })
    .privateKey.export({ type: 'pkcs8', format: 'pem' })
    .toString(),
});
for (const name of ['reports', 'files']) {
  const source = readFileSync(`apps/worker/migrations/${name}/0001_${name}.sql`, 'utf8').replace(
    /--[^\n]*/g,
    '',
  );
  const at = source.indexOf('CREATE TRIGGER');
  const statements =
    at < 0
      ? source.split(';').filter((s) => s.trim())
      : [
          ...source
            .slice(0, at)
            .split(';')
            .filter((s) => s.trim()),
          ...[...source.slice(at).matchAll(/CREATE TRIGGER[\s\S]+?END;/g)].map((s) => s[0]),
        ];
  for (const sql of statements)
    await checked('/__sql', {
      method: 'POST',
      body: JSON.stringify({ sql, files: name === 'files' }),
    });
}
const tokens = new Map<number, string>();
for (const id of [1, 5])
  tokens.set(id, ((await (await checked(`/__token?id=${id}`)).json()) as { token: string }).token);
const rows: Record<string, unknown>[] = [];
await reportBudgetCases(
  async (label, path, method = 'GET', data, id, extra = {}) => {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'CF-Connecting-IP': '192.0.2.100',
      ...extra,
    };
    if (id) headers.Authorization = `Bearer ${tokens.get(id)}`;
    const start = performance.now();
    const response = await fetch(root + path, {
      method,
      headers,
      ...(data === undefined
        ? {}
        : { body: data instanceof Uint8Array ? Uint8Array.from(data) : JSON.stringify(data) }),
    });
    const bytes = await response.arrayBuffer();
    rows.push({
      route: label,
      status: response.status,
      end_to_end_ms: performance.now() - start,
      handler_proxy_ms: Number(response.headers.get('X-Local-Handler-Proxy-Ms')),
      awaited_d1_ms: Number(response.headers.get('X-Local-D1-Awaited-Ms')),
      subrequests: Number(response.headers.get('X-Local-Subrequests')),
    });
    return new Response(response.status === 304 ? null : bytes, response);
  },
  async (sql) => {
    await checked('/__sql', { method: 'POST', body: JSON.stringify({ sql }) });
  },
);
const output = {
  label: 'proxy; real CPU verified after deploy',
  runtime: 'wrangler dev local workerd; local D1; mocked upstreams',
  rows,
};
console.log(JSON.stringify(output, null, 2));
writeFileSync(
  process.env.REPORTS_LOCAL_OUTPUT ??
    'D:/GitHub/Description-editor/.agents/reports/reports-server-workerd-proxy.json',
  JSON.stringify(output, null, 2),
);
if (rows.some((r) => Number(r.status) >= 400)) process.exitCode = 1;
