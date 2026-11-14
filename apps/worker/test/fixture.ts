import { createHash } from 'node:crypto';
import { z } from 'zod';
import { vi } from 'vitest';
import { type Aliases, type Permissions, type Tooltip } from '@clarity/core';
import worker from '../src/index.js';
import { signToken } from '../src/crypto.js';
import type { Env } from '../src/types.js';

export const sha = (number: number) => number.toString(16).padStart(40, '0');
/**
 * Edited English carries a newer revision than 'original', as the editor's save stamps it: the
 * Worker refuses an English change that keeps the revision without "No translation impact".
 */
export const tooltip = (text = 'original', updatedAt?: string): Tooltip => ({
  hash: 123,
  text: {
    en: {
      text,
      updatedAt:
        updatedAt ?? (text === 'original' ? '2026-10-01T00:00:00Z' : '2026-10-01T00:00:01Z'),
      updatedBy: 'alice',
    },
  },
  associated: [],
});
export const config: Permissions = {
  users: {
    '1': { login: 'alice', role: 'maintainer' },
    '2': { login: 'bob', role: 'editor' },
    '3': { login: 'carol', role: 'trial' },
    '4': { login: 'dan', role: 'translator', languages: ['de'] },
  },
};

/** Git's blob SHA-1 of a JSON file as the Worker commits it (pretty, trailing newline). */
export const blobOid = (value: unknown) => {
  const text = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
  return createHash('sha1')
    .update(Buffer.concat([Buffer.from(`blob ${text.length}\0`), text]))
    .digest('hex');
};

const objectSchema = z.record(z.string(), z.unknown());
const treeSchema = z.object({
  base_tree: z.string().optional(),
  tree: z.array(
    z.union([
      z.object({ path: z.string(), content: z.string() }),
      z.object({ path: z.string(), sha: z.null() }),
    ]),
  ),
});
const commitSchema = z.object({
  tree: z.string(),
  parents: z.array(z.string()),
  message: z.string(),
});
const putSchema = z.object({ sha: z.string(), content: z.string(), branch: z.string() });

export class Fixture {
  env: Env;
  dataHead = sha(1);
  /** Head of the synced-settings branch; null until the first sync creates it. */
  settingsHead: string | null = null;
  settingsRaces = 0;
  liveHead = sha(2);
  liveFileSha = sha(3);
  sequence = 10;
  snapshots = new Map<string, Record<string, unknown>>();
  commits: Record<string, unknown>[] = [];
  commitParents = new Map<string, string[]>();
  writes: Record<string, unknown>[] = [];
  live: Record<string, unknown> = {
    perks: { '999': { hash: 999, editor: { en: { main: 'untouched' } } } },
    databaseSettings: { folders: { saved: [] }, enhancedPerks: {} },
  };
  beforePatch?: () => void;
  beforeLive?: () => void;
  patchRaces = 0;
  liveRaces = 0;
  upstreamStatus?: number;
  blobReads = 0;
  /** Every outgoing fetch (what the Workers platform counts as a subrequest). */
  subrequests = 0;
  graphqlCalls = 0;
  /** Extra top-level errors on every Commit `file(path:)` read (fail-closed checks). */
  graphqlErrors: unknown[] = [];
  /** Extra fields on every Commit target in those reads (fields the query never selected). */
  graphqlTargetExtras: Record<string, unknown> = {};
  /** Serve GraphQL blobs as truncated, so reads fall back to the contents API. */
  truncateGraphql = false;
  /** Break contents-API base64 into 60-column lines, as GitHub does. */
  wrapBase64 = false;
  largeFile = false;
  googleCalls = 0;
  csv = 'Perk,Description\r\n"Thing","Line 1\nLine 2, ""quoted"""\r\n';
  failGoogle = false;
  aliases: Aliases = { 789: { to: 123, kind: 'sandbox' } };
  /** Generator `sandboxConflicts.json`: shared sandbox perk -> tooltips sharing it. */
  sandboxConflicts: Record<string, number[]> = {};
  sandboxConflictReads = 0;
  extraItems: Record<string, unknown> = {};
  /** Generator `weaponTypes.json`; undefined serves a 404 (the file is optional). */
  weaponTypeTable?: unknown;
  /** Status served for `weaponTypes.json` instead of the table or 404 (e.g. an upstream error). */
  weaponTypeStatus?: number;
  /** Extra generator fields on the canonical item 123. */
  canonicalFacts: Record<string, unknown> = {};
  /** Extra generator categories after `perk`. */
  extraCategories: unknown[] = [];
  history = [
    {
      sha: sha(1),
      commit: { author: { name: 'alice', date: '2026-10-01T00:00:00Z' }, message: 'initial' },
      author: { login: 'alice' },
    },
  ];
  pending: Promise<unknown>[] = [];
  /** Committer date of the last data-branch commit that touched each path. */
  touched = new Map<string, string>();
  /** Public GitHub accounts served by GET /users/:login. */
  accounts: Record<string, { id: number; login: string; type: string }> = {};
  accountLookups = 0;
  /** Kick files created through the Contents API (by request path). */
  kicks = new Set<string>();

  constructor(privateKey: string) {
    this.env = {
      SITE_ORIGIN: 'https://editor.example',
      SITE_URL: 'https://editor.example/app/',
      GITHUB_OWNER: 'test-org',
      GITHUB_REPO: 'scratch',
      DATA_BRANCH: 'editor-data',
      LIVE_BRANCH: 'converter-v2-test',
      GENERATOR_OWNER: 'test-org',
      GENERATOR_REPO: 'generator',
      GENERATOR_BRANCH: 'v2',
      GITHUB_APP_ID: '99',
      GITHUB_APP_SLUG: 'clarity-test',
      GITHUB_INSTALLATION_ID: '100',
      GITHUB_CLIENT_ID: 'client',
      GITHUB_CLIENT_SECRET: 'secret',
      GITHUB_PRIVATE_KEY: privateKey,
      SESSION_SECRET: '0123456789abcdef0123456789abcdef',
      OAUTH_CALLBACK_URL: 'https://api.example/auth/callback',
    };
    this.snapshots.set(this.dataHead, {
      'tooltips/123.json': tooltip(),
      'config/permissions.json': config,
      'live/pushed.json': {},
    });
    vi.stubGlobal('fetch', vi.fn(this.fetch.bind(this)));
    const responses = new Map<string, { response: Response; expires: number }>();
    vi.stubGlobal('caches', {
      open: async () => ({
        match: async (request: Request) => {
          const hit = responses.get(request.url);
          return hit && hit.expires > Date.now() ? hit.response.clone() : undefined;
        },
        put: async (request: Request, response: Response) => {
          responses.set(request.url, { response, expires: Date.now() + 900_000 });
        },
      }),
    });
  }

  current(): Record<string, unknown> {
    return this.snapshots.get(this.dataHead)!;
  }

  moveData(changes: Record<string, unknown> = {}): void {
    const before = this.current();
    const files = { ...before, ...changes };
    for (const [path, value] of Object.entries(changes))
      if (value === undefined) delete files[path];
    this.dataHead = sha(this.sequence++);
    this.snapshots.set(this.dataHead, files);
    this.touch(before, files);
  }

  private touch(before: Record<string, unknown>, after: Record<string, unknown>): void {
    const date = new Date().toISOString().replace('.000Z', 'Z');
    for (const path of new Set([...Object.keys(before), ...Object.keys(after)]))
      if (JSON.stringify(before[path]) !== JSON.stringify(after[path]))
        this.touched.set(path, date);
  }

  async request(path: string, method = 'GET', value?: unknown, id = 1): Promise<Response> {
    const token = await signToken(
      {
        id,
        login: config.users[String(id)]?.login ?? 'unknown',
        purpose: 'session',
        exp: Math.floor(Date.now() / 1000) + 3600,
      },
      this.env.SESSION_SECRET,
    );
    return worker.fetch(
      new Request(`https://api.example${path}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, Origin: this.env.SITE_ORIGIN },
        ...(value === undefined ? {} : { body: JSON.stringify(value) }),
      }),
      this.env,
      { waitUntil: (promise) => this.pending.push(promise) },
    );
  }

  /**
   * GitHub answers a `Commit.file(path:)` that resolves to nothing with `null` data AND a
   * top-level NOT_FOUND error (verified live 2026-11-14), unlike `object(expression:)`, which is
   * a silent `null`. The fixture reproduces that so reads must tolerate exactly those errors.
   */
  private commitResponse(target: Record<string, unknown>, fileAliases: readonly string[]) {
    const errors = fileAliases
      .filter((alias) => alias in target && target[alias] === null)
      .map((alias) => ({
        type: 'NOT_FOUND',
        path: ['repository', 'ref', 'target', alias],
        locations: [{ line: 1, column: 1 }],
        message: `Could not resolve file for path '${alias}'.`,
      }))
      .concat(this.graphqlErrors as never[]);
    return this.response({
      data: { repository: { ref: { target: { ...target, ...this.graphqlTargetExtras } } } },
      ...(errors.length ? { errors } : {}),
    });
  }

  private response(value: unknown, status = 200) {
    return new Response(JSON.stringify(value), { status });
  }

  private wrap(base64: string): string {
    return this.wrapBase64 ? `${(base64.match(/.{1,60}/g) ?? []).join('\n')}\n` : base64;
  }

  private graphql(raw: unknown): Response {
    this.graphqlCalls++;
    const input = z
      .object({ query: z.string(), variables: z.record(z.string(), z.string()) })
      .parse(raw);
    const repository: Record<string, unknown> = {};
    if (input.query.includes('perm:file(path:$perm)')) {
      const files = this.current();
      const blob = (value: unknown) =>
        value === undefined
          ? null
          : { object: { oid: blobOid(value), isTruncated: false, text: JSON.stringify(value) } };
      const target: Record<string, unknown> = {
        oid: this.dataHead,
        tree: { oid: this.dataHead },
        perm: blob(files[input.variables.perm!]),
      };
      if (input.variables.config) {
        const path = input.variables.config;
        target.config = blob(files[path]);
        const date = this.touched.get(path) ?? (path in files ? '2026-10-01T00:00:00Z' : null);
        target.last = { nodes: date ? [{ committedDate: date }] : [] };
      }
      if (input.variables.dir) {
        const prefix = `${input.variables.dir}/`;
        const entries = Object.entries(files)
          .filter(([path]) => path.startsWith(prefix) && !path.slice(prefix.length).includes('/'))
          .map(([path, value]) => ({
            name: path.slice(prefix.length),
            object: blob(value)!.object,
          }));
        target.dir = entries.length ? { object: { entries } } : null;
      }
      return this.commitResponse(target, ['perm', 'config', 'dir']);
    }
    if (input.variables.branch) {
      const files = this.current();
      const target: Record<string, unknown> = { oid: this.dataHead, tree: { oid: this.dataHead } };
      for (const [name, path] of Object.entries(input.variables)) {
        if (!/^p[0-9]+$/.test(name)) continue;
        const value = files[path];
        const oidOnly = input.query.includes(
          `o${name.slice(1)}:file(path:$${name}){object{... on Blob{oid}}}`,
        );
        target[`o${name.slice(1)}`] =
          value === undefined
            ? null
            : {
                object: {
                  oid: blobOid(value),
                  ...(oidOnly
                    ? {}
                    : {
                        isTruncated: this.truncateGraphql,
                        text: this.truncateGraphql ? null : JSON.stringify(value),
                      }),
                },
              };
      }
      for (const [name, path] of Object.entries(input.variables)) {
        if (!/^t[0-9]+$/.test(name)) continue;
        // Depth = nested `entries{` in this listing's selection (publishSnapshot `trees`).
        const start = input.query.indexOf(`${name}:file(path:$${name})`);
        const end = input.query.indexOf(' t', start + 1);
        const selection = input.query.slice(start, end < 0 ? undefined : end);
        target[name] = listTree(files, path, (selection.match(/entries\{/g) ?? []).length);
      }
      return this.commitResponse(
        target,
        Object.keys(target).filter((key) => /^[ot][0-9]+$/.test(key)),
      );
    }

    for (const [name, expression] of Object.entries(input.variables)) {
      if (!/^e[0-9]+$/.test(name)) continue;
      const [ref, path] = expression.split(':');
      const value = this.snapshots.get(ref!)?.[path!];
      repository[`o${name.slice(1)}`] =
        value === undefined
          ? null
          : {
              oid: blobOid(value),
              isTruncated: this.truncateGraphql,
              text: this.truncateGraphql ? null : JSON.stringify(value),
            };
    }
    return this.response({ data: { repository } });
  }

  async fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = init?.method ?? 'GET';
    const raw: unknown = init?.body ? JSON.parse(String(init.body)) : undefined;
    this.subrequests++;
    if (url.hostname === 'docs.google.com') {
      this.googleCalls++;
      expectGoogleUrl(url);
      return new Response(this.csv, {
        status: this.failGoogle ? 401 : 200,
        headers: { 'Content-Type': 'text/csv' },
      });
    }
    if (url.hostname === 'raw.githubusercontent.com') {
      if (url.pathname.endsWith('/items.json'))
        return this.response({
          ...this.extraItems,
          '123': {
            hash: 123,
            name: 'Demo perk',
            categoryId: 'perk',
            itemHash: 456,
            itemName: 'Demo item',
            ...this.canonicalFacts,
          },
        });
      if (url.pathname.endsWith('/categories.json'))
        return this.response([{ id: 'perk', legacyType: 'Weapon Perk' }, ...this.extraCategories]);
      if (url.pathname.endsWith('/aliases.json')) return this.response(this.aliases);
      if (url.pathname.endsWith('/sandboxConflicts.json')) {
        this.sandboxConflictReads++;
        return this.response(this.sandboxConflicts);
      }
      if (url.pathname.endsWith('/weaponTypes.json')) {
        if (this.weaponTypeStatus) return this.response({}, this.weaponTypeStatus);
        return this.weaponTypeTable === undefined
          ? this.response({ message: '404: Not Found' }, 404)
          : this.response(this.weaponTypeTable);
      }
    }
    if (url.hostname === 'github.com' && url.pathname === '/login/oauth/access_token') {
      return this.response({ access_token: 'oauth-user-token' });
    }
    if (url.pathname === '/user') return this.response({ id: 1, login: 'alice' });
    if (url.hostname === 'api.github.com' && url.pathname.startsWith('/users/')) {
      if (new Headers(init?.headers).get('Authorization') !== 'Bearer installation-token')
        throw new Error('Account lookup did not use the installation token');
      this.accountLookups++;
      const account = this.accounts[decodeURIComponent(url.pathname.slice(7)).toLowerCase()];
      return account ? this.response(account) : this.response({ message: 'Not Found' }, 404);
    }
    if (url.pathname === '/app/installations/100/access_tokens')
      return this.response({ token: 'installation-token' });
    if (new Headers(init?.headers).get('Authorization') !== 'Bearer installation-token') {
      throw new Error('Repository operation did not use the installation token');
    }
    if (this.upstreamStatus) return this.response({}, this.upstreamStatus);
    if (url.pathname === '/graphql' && method === 'POST') return this.graphql(raw);
    const path = url.pathname.replace(
      '/repos/' + this.env.GITHUB_OWNER + '/' + this.env.GITHUB_REPO,
      '',
    );
    if (path.startsWith('/git/ref/heads/')) {
      const branch = decodeURIComponent(path.slice('/git/ref/heads/'.length));
      if (branch === 'editor-settings') {
        return this.settingsHead
          ? this.response({ object: { sha: this.settingsHead } })
          : this.response({ message: 'Not Found' }, 404);
      }
      return this.response({
        object: { sha: branch === this.env.DATA_BRANCH ? this.dataHead : this.liveHead },
      });
    }
    if (path.startsWith('/contents/') && method === 'GET') {
      const name = decodeURIComponent(path.slice('/contents/'.length));
      const ref = url.searchParams.get('ref')!;
      const value = name === 'liveDescriptions.json' ? this.live : this.snapshots.get(ref)?.[name];
      if (value === undefined) return this.response({ message: 'Not Found' }, 404);
      return this.response({
        sha: name === 'liveDescriptions.json' ? this.liveFileSha : blobOid(value),
        encoding: this.largeFile && name === 'liveDescriptions.json' ? 'none' : 'base64',
        content:
          this.largeFile && name === 'liveDescriptions.json'
            ? ''
            : this.wrap(Buffer.from(JSON.stringify(value), 'utf8').toString('base64')),
      });
    }
    if (path.startsWith('/git/blobs/')) {
      this.blobReads++;
      return this.response({
        sha: this.liveFileSha,
        encoding: 'base64',
        content: Buffer.from(JSON.stringify(this.live), 'utf8').toString('base64'),
      });
    }
    if (path.startsWith('/git/commits/') && method === 'GET') {
      return this.response({ tree: { sha: path.slice('/git/commits/'.length) } });
    }
    if (path === '/git/trees' && method === 'POST') {
      const input = treeSchema.parse(raw);
      const id = sha(this.sequence++);
      const files: Record<string, unknown> = {
        ...(input.base_tree ? this.snapshots.get(input.base_tree) : {}),
      };
      for (const entry of input.tree) {
        if ('content' in entry) files[entry.path] = JSON.parse(entry.content);
        else delete files[entry.path];
      }
      this.snapshots.set(id, files);
      return this.response({ sha: id });
    }
    if (path === '/git/commits' && method === 'POST') {
      const input = commitSchema.parse(raw);
      const id = sha(this.sequence++);
      this.commits.push(objectSchema.parse(raw));
      this.commitParents.set(id, input.parents);
      this.snapshots.set(id, this.snapshots.get(input.tree)!);
      return this.response({ sha: id });
    }
    if (path === '/git/refs/heads/editor-settings' && method === 'PATCH') {
      if (this.settingsRaces-- > 0) return this.response({}, 422);
      this.settingsHead = z.object({ sha: z.string(), force: z.literal(false) }).parse(raw).sha;
      return this.response({ object: { sha: this.settingsHead } });
    }
    if (path === '/git/refs' && method === 'POST') {
      const input = z
        .object({ ref: z.literal('refs/heads/editor-settings'), sha: z.string() })
        .parse(raw);
      if (this.settingsHead || this.settingsRaces-- > 0) return this.response({}, 422);
      this.settingsHead = input.sha;
      return this.response({ object: { sha: input.sha } });
    }
    if (path.startsWith('/git/refs/heads/') && method === 'PATCH') {
      if (this.patchRaces-- > 0) return this.response({}, 422);
      const hook = this.beforePatch;
      this.beforePatch = undefined;
      if (hook) hook();
      const next = z.object({ sha: z.string(), force: z.literal(false) }).parse(raw).sha;
      // GitHub refuses this sole-parent commit once H has moved. Never fake a race rejection.
      if (next !== this.dataHead && this.commitParents.get(next)?.[0] !== this.dataHead)
        return this.response({}, 422);
      this.touch(this.current(), this.snapshots.get(next)!);
      this.dataHead = next;
      return this.response({ object: { sha: this.dataHead } });
    }
    if (path.startsWith('/contents/publish/kicks/') && method === 'PUT') {
      // A create without a sha of an existing name is refused, as GitHub does.
      if (this.kicks.has(path)) return this.response({ message: 'sha missing' }, 422);
      this.kicks.add(path);
      this.writes.push(objectSchema.parse(raw));
      return this.response({ commit: { sha: sha(this.sequence++) } }, 201);
    }
    if (path === '/contents/liveDescriptions.json' && method === 'PUT') {
      if (this.liveRaces-- > 0) return this.response({}, 409);
      const hook = this.beforeLive;
      this.beforeLive = undefined;
      if (hook) {
        hook();
        return this.response({}, 409);
      }
      const input = putSchema.parse(raw);
      if (input.sha !== this.liveFileSha) return this.response({}, 409);
      this.writes.push(objectSchema.parse(raw));
      this.live = objectSchema.parse(
        JSON.parse(Buffer.from(input.content, 'base64').toString('utf8')),
      );
      this.liveHead = sha(this.sequence++);
      this.liveFileSha = sha(this.sequence++);
      return this.response({ commit: { sha: this.liveHead } });
    }
    if (path === '/commits') return this.response(this.history);
    throw new Error(`Unexpected mock request: ${method} ${url.href}`);
  }
}

/** Names-only GraphQL listing of `dir` in a flat file map, `depth` levels deep (null: missing). */
function listTree(files: Record<string, unknown>, dir: string, depth: number): unknown {
  const prefix = `${dir}/`;
  const paths = Object.keys(files).filter((path) => path.startsWith(prefix));
  if (!paths.length) return null;
  const level = (base: string, left: number): unknown => {
    const children = new Map<string, boolean>();
    for (const path of paths) {
      if (!path.startsWith(base)) continue;
      const rest = path.slice(base.length);
      const slash = rest.indexOf('/');
      const name = slash < 0 ? rest : rest.slice(0, slash);
      children.set(name, children.get(name) || slash >= 0);
    }
    return {
      entries: [...children].map(([name, isDir]) =>
        left <= 1 ? { name } : { name, object: isDir ? level(`${base}${name}/`, left - 1) : {} },
      ),
    };
  };
  return { object: level(prefix, depth) };
}

function expectGoogleUrl(url: URL) {
  if (url.searchParams.get('tqx') !== 'out:csv' || !url.searchParams.has('sheet')) {
    throw new Error('Expected gviz CSV sheet query');
  }
}

export async function makePrivateKey(): Promise<string> {
  const keys = await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify'],
  );
  return `-----BEGIN PRIVATE KEY-----\n${Buffer.from(await crypto.subtle.exportKey('pkcs8', keys.privateKey)).toString('base64')}\n-----END PRIVATE KEY-----`;
}
