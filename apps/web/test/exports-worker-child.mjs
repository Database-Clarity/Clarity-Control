// The local Worker for the export E2E (exports-browser.mjs): P3's in-memory GitHub
// (apps/worker/test/exportsLocal.ts, bundled by the parent) behind a local HTTP server. Never
// deployed. Real category ids are accepted (the item catalog the app loads), and `/__cooldown`
// makes the next saves see a commit from just now, so the 30 s cooldown (429) can be exercised.
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';

const [bundle, port, origin, categoriesJson] = process.argv.slice(2);
const { default: worker } = await import(pathToFileURL(bundle).href);
const categories = JSON.parse(categoriesJson);
let recent = false;
const inner = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.hostname === 'raw.githubusercontent.com' && url.pathname.endsWith('/categories.json'))
    return new Response(JSON.stringify(categories), {
      headers: { 'Content-Type': 'application/json' },
    });
  const response = await inner(input, init);
  if (!recent || url.pathname !== '/graphql') return response;
  const body = await response.json();
  const target = body?.data?.repository?.ref?.target;
  if (target?.last?.nodes?.length) target.last.nodes[0].committedDate = new Date().toISOString();
  return new Response(JSON.stringify(body), { status: response.status, headers: response.headers });
};

const env = {
  SITE_ORIGIN: origin,
  SITE_URL: `${origin}/`,
  GITHUB_OWNER: 'Database-Clarity',
  GITHUB_REPO: 'Live-Clarity-Database',
  DATA_BRANCH: 'editor-data',
  LIVE_BRANCH: 'converter-v2-test',
  GENERATOR_OWNER: 'Database-Clarity',
  GENERATOR_REPO: 'Description-data-generator',
  GENERATOR_BRANCH: 'v2',
  GITHUB_APP_ID: '1',
  GITHUB_APP_SLUG: 'clarity-local',
  GITHUB_INSTALLATION_ID: '2',
  GITHUB_CLIENT_ID: 'c',
  GITHUB_CLIENT_SECRET: 's',
  OAUTH_CALLBACK_URL: 'http://127.0.0.1/auth/callback',
};

createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const url = new URL(req.url, `http://127.0.0.1:${port}`);
  if (url.pathname === '/__cooldown') {
    recent = url.searchParams.get('on') === '1';
    res.writeHead(200, { 'Access-Control-Allow-Origin': '*' }).end('{}');
    return;
  }
  // exportsLocal re-wraps every response with a body, which a 204 cannot have: answer the CORS
  // preflight here with the Worker's own headers (src/index.ts).
  if (req.method === 'OPTIONS') {
    const allowed = req.headers.origin === origin;
    res
      .writeHead(allowed ? 204 : 403, {
        Vary: 'Origin',
        ...(allowed
          ? {
              'Access-Control-Allow-Origin': origin,
              'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
              'Access-Control-Allow-Headers': 'Authorization, Content-Type',
              'Access-Control-Max-Age': '600',
            }
          : {}),
      })
      .end();
    return;
  }
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers))
    if (typeof value === 'string') headers.set(name, value);
  const body = chunks.length ? Buffer.concat(chunks) : undefined;
  const request = new Request(url, {
    method: req.method,
    headers,
    ...(body && req.method !== 'GET' && req.method !== 'HEAD' ? { body } : {}),
  });
  try {
    const response = await worker.fetch(request, env, { waitUntil() {} });
    const out = {};
    response.headers.forEach((value, name) => (out[name] = value));
    res.writeHead(response.status, out).end(Buffer.from(await response.arrayBuffer()));
  } catch (error) {
    res.writeHead(500).end(String(error));
  }
}).listen(Number(port), '127.0.0.1', () => process.stdout.write('ready\n'));
