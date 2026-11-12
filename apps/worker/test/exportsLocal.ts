// Local CPU/subrequest proxy for the /exports routes (export spec section 4, P3 gate). Never used
// by the production entrypoint. The same bundle runs in Node (import, call `fetch`) and in local
// workerd (`wrangler dev --local`); test/exportsBudget.mjs drives both. Upstreams are an in-memory
// GitHub sized to the declared maximum: 40 projects of 3 style files, 40 partners, 25 users.
// Every upstream call is a mocked `fetch`: it is counted (subrequests) and its awaited span is
// subtracted from the wall time (handler proxy; workerd's clock only moves on I/O, so the
// client-side end-to-end time is the conservative workerd number).
import worker from '../src/index.js';
import { signToken } from '../src/crypto.js';
import { blobSha } from '../src/github.js';
import type { Context, Env } from '../src/types.js';

const pretty = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
const categories = Array.from({ length: 60 }, (_, i) => ({ id: `category-${i}`, name: `C ${i}` }));
const styleFile = (id: string, uid: string, cats: string[]) => ({
  id,
  uid,
  formatVersion: 1,
  preset: 'markdown',
  shape: 'text',
  data: {
    categories: cats,
    sandboxPerks: cats.slice(0, 4),
    frameAliases: true,
    languages: ['en', 'de', 'fr', 'es'],
    keys: ['name', 'itemHash', 'itemName', 'type'],
    bungieIdentical: false,
  },
  format: {
    symbols: Object.fromEntries(
      ['arc', 'solar', 'void', 'stasis', 'strand', 'kinetic', 'bold', 'yellow', 'pve', 'pvp'].map(
        (symbol) => [symbol, { mode: 'replace', before: `[${symbol}]`, after: '' }],
      ),
    ),
    titles: { mode: 'inline', pattern: ['(', ')', '', ''] },
    links: { mode: 'replace', pattern: ['[', ']', '(', ')'] },
    elementTags: false,
    spacer: 'drop',
  },
});
const uid = (n: number) => `u${String(n).padStart(15, '0')}`;
const project = (n: number) => ({
  schema: 1,
  id: `project-${n}`,
  name: `Project ${n}`,
  files: [0, 1, 2].map((f) =>
    styleFile(
      `file-${f}`,
      uid(n * 3 + f),
      categories.slice(0, 20).map((c) => c.id),
    ),
  ),
});

let files = new Map<string, string>();
let dates = new Map<string, string>();
let trees = new Map<string, Map<string, string>>();
let commits = new Map<string, string>();
let head = '';
let sequence = 0;
const sha = () => (++sequence).toString(16).padStart(40, '0');

function reset() {
  files = new Map();
  dates = new Map();
  trees = new Map();
  commits = new Map();
  const users: Record<string, unknown> = {
    '1': { login: 'owner', role: 'maintainer' },
  };
  for (let i = 2; i <= 25; i++) users[String(i)] = { login: `user${i}`, role: 'editor' };
  const partners: Record<string, unknown> = {};
  for (let n = 0; n < 40; n++)
    partners[String(1000 + n)] = { login: `partner${n}`, projects: [`project-${n}`] };
  files.set('config/permissions.json', pretty({ users, partners }));
  for (let n = 0; n < 40; n++) files.set(`exports/projects/project-${n}.json`, pretty(project(n)));
  for (let i = 0; i < 200; i++) files.set(`tooltips/${i}.json`, pretty({ hash: i }));
  head = sha();
}
reset();

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

async function upstream(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = new URL(input instanceof Request ? input.url : String(input));
  const method = init?.method ?? 'GET';
  const body = init?.body ? JSON.parse(String(init.body)) : undefined;
  if (url.pathname.endsWith('/access_tokens')) return json({ token: 'local-token' });
  if (url.hostname === 'raw.githubusercontent.com' && url.pathname.endsWith('/categories.json'))
    return json(categories);
  if (url.pathname.startsWith('/users/')) {
    const login = decodeURIComponent(url.pathname.slice(7));
    return json({ id: 5000 + login.length, login, type: 'User' });
  }
  if (url.pathname === '/graphql') {
    const { variables } = body as { variables: Record<string, string> };
    const blob = async (text: string | undefined) =>
      text === undefined
        ? null
        : { object: { oid: await blobSha(text), isTruncated: false, text } };
    const target: Record<string, unknown> = {
      oid: head,
      tree: { oid: head },
      perm: await blob(files.get(variables.perm!)),
    };
    if (variables.config) {
      target.config = await blob(files.get(variables.config));
      const date = dates.get(variables.config) ?? '2026-01-01T00:00:00Z';
      target.last = { nodes: files.has(variables.config) ? [{ committedDate: date }] : [] };
    }
    if (variables.dir) {
      const entries = [];
      for (const [path, text] of files)
        if (path.startsWith(`${variables.dir}/`))
          entries.push({
            name: path.slice(variables.dir.length + 1),
            object: (await blob(text))!.object,
          });
      target.dir = { object: { entries } };
    }
    return json({ data: { repository: { ref: { target } } } });
  }
  const path = url.pathname.replace(/^\/repos\/[^/]+\/[^/]+/, '');
  if (path.startsWith('/git/ref/heads/')) return json({ object: { sha: head } });
  if (path.startsWith('/contents/') && method === 'GET') {
    const text = files.get(decodeURIComponent(path.slice(10)));
    if (text === undefined) return json({ message: 'Not Found' }, 404);
    return json({
      sha: await blobSha(text),
      encoding: 'base64',
      content: btoa(String.fromCharCode(...new TextEncoder().encode(text))),
    });
  }
  if (path === '/git/trees' && method === 'POST') {
    const next = new Map(files);
    for (const entry of body.tree as { path: string; content?: string }[])
      if (entry.content === undefined) next.delete(entry.path);
      else next.set(entry.path, entry.content);
    const id = sha();
    trees.set(id, next);
    return json({ sha: id });
  }
  if (path === '/git/commits' && method === 'POST') {
    const id = sha();
    commits.set(id, body.tree);
    return json({ sha: id });
  }
  if (path.startsWith('/git/refs/heads/') && method === 'PATCH') {
    const next = trees.get(commits.get(body.sha)!)!;
    for (const [file, text] of next)
      if (files.get(file) !== text) dates.set(file, '2026-01-01T00:00:00Z');
    files = next;
    head = body.sha;
    return json({ object: { sha: head } });
  }
  throw new Error(`Unmocked local upstream ${method} ${url.href}`);
}

let key = '';
let network = 0;
let awaited = 0;
globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  network++;
  const start = performance.now();
  try {
    return await upstream(input, init);
  } finally {
    awaited += performance.now() - start;
  }
};

const secret = 'local-test-session-secret-not-for-production-0000';
export default {
  async fetch(request: Request, bindings: Env, context: Context) {
    const path = new URL(request.url).pathname;
    const env: Env = {
      ...bindings,
      SESSION_SECRET: secret,
      GITHUB_PRIVATE_KEY: key,
      DATA_BRANCH: 'editor-data',
    };
    if (path === '/__configure') {
      key = await request.text();
      return json({ ok: true });
    }
    if (path === '/__drop') {
      files.delete(`exports/projects/${new URL(request.url).searchParams.get('id')}.json`);
      return json({ ok: true });
    }
    if (path === '/__reset') {
      reset();
      return json({ ok: true });
    }
    if (path === '/__token') {
      const id = Number(new URL(request.url).searchParams.get('id'));
      return json({
        token: await signToken(
          { purpose: 'session', id, login: `user${id}`, exp: Math.floor(Date.now() / 1000) + 3600 },
          secret,
        ),
      });
    }
    if (path === '/__revision') {
      const id = new URL(request.url).searchParams.get('id')!;
      const text =
        id === 'permissions'
          ? files.get('config/permissions.json')
          : files.get(`exports/projects/${id}.json`);
      return json({
        revision: text === undefined ? null : await blobSha(text),
        config: text === undefined ? null : JSON.parse(text),
      });
    }
    const startNetwork = network;
    const startAwaited = awaited;
    const start = performance.now();
    const response = await worker.fetch(request, env, context);
    const text = await response.text();
    const wall = performance.now() - start;
    const io = awaited - startAwaited;
    const headers = new Headers(response.headers);
    headers.set('X-Local-Handler-Proxy-Ms', String(Math.max(0, wall - io)));
    headers.set('X-Local-Upstream-Awaited-Ms', String(io));
    headers.set('X-Local-Subrequests', String(network - startNetwork));
    return new Response(text, { status: response.status, headers });
  },
};
