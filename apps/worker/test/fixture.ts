import { z } from 'zod';
import { vi } from 'vitest';
import { type Aliases, type Permissions, type Tooltip } from '@clarity/core';
import worker from '../src/index.js';
import { signToken } from '../src/crypto.js';
import type { Env } from '../src/types.js';

export const sha = (number: number) => number.toString(16).padStart(40, '0');
export const tooltip = (text = 'original'): Tooltip => ({
  hash: 123,
  text: { en: { text, updatedAt: '2026-10-01T00:00:00Z', updatedBy: 'alice' } },
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

const objectSchema = z.record(z.string(), z.unknown());
const treeSchema = z.object({
  base_tree: z.string(),
  tree: z.array(z.object({ path: z.string(), content: z.string() })),
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
  liveHead = sha(2);
  liveFileSha = sha(3);
  sequence = 10;
  snapshots = new Map<string, Record<string, unknown>>();
  commits: Record<string, unknown>[] = [];
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
  largeFile = false;
  googleCalls = 0;
  csv = 'Perk,Description\r\n"Thing","Line 1\nLine 2, ""quoted"""\r\n';
  failGoogle = false;
  aliases: Aliases = { 789: { to: 123, kind: 'sandbox' } };
  extraItems: Record<string, unknown> = {};
  /** Generator `weaponTypes.json`; undefined serves a 404 (the file is optional). */
  weaponTypeTable?: unknown;
  /** Status served for `weaponTypes.json` instead of the table or 404 (e.g. an upstream error). */
  weaponTypeStatus?: number;
  /** Extra generator fields on the canonical item 123. */
  canonicalFacts: Record<string, unknown> = {};
  history = [
    {
      sha: sha(1),
      commit: { author: { name: 'alice', date: '2026-10-01T00:00:00Z' }, message: 'initial' },
      author: { login: 'alice' },
    },
  ];
  pending: Promise<unknown>[] = [];

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
    const files = { ...this.current(), ...changes };
    this.dataHead = sha(this.sequence++);
    this.snapshots.set(this.dataHead, files);
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

  private response(value: unknown, status = 200) {
    return new Response(JSON.stringify(value), { status });
  }

  async fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = init?.method ?? 'GET';
    const raw: unknown = init?.body ? JSON.parse(String(init.body)) : undefined;
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
        return this.response([{ id: 'perk', legacyType: 'Weapon Perk' }]);
      if (url.pathname.endsWith('/aliases.json')) return this.response(this.aliases);
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
    if (url.pathname === '/app/installations/100/access_tokens')
      return this.response({ token: 'installation-token' });
    if (new Headers(init?.headers).get('Authorization') !== 'Bearer installation-token') {
      throw new Error('Repository operation did not use the installation token');
    }
    if (this.upstreamStatus) return this.response({}, this.upstreamStatus);
    const path = url.pathname.replace('/repos/test-org/scratch', '');
    if (path.startsWith('/git/ref/heads/')) {
      const branch = decodeURIComponent(path.slice('/git/ref/heads/'.length));
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
        sha: name === 'liveDescriptions.json' ? this.liveFileSha : sha(4),
        encoding: this.largeFile && name === 'liveDescriptions.json' ? 'none' : 'base64',
        content:
          this.largeFile && name === 'liveDescriptions.json'
            ? ''
            : Buffer.from(JSON.stringify(value), 'utf8').toString('base64'),
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
      this.snapshots.set(id, {
        ...this.snapshots.get(input.base_tree),
        ...Object.fromEntries(input.tree.map((entry) => [entry.path, JSON.parse(entry.content)])),
      });
      return this.response({ sha: id });
    }
    if (path === '/git/commits' && method === 'POST') {
      const input = commitSchema.parse(raw);
      const id = sha(this.sequence++);
      this.commits.push(objectSchema.parse(raw));
      this.snapshots.set(id, this.snapshots.get(input.tree)!);
      return this.response({ sha: id });
    }
    if (path.startsWith('/git/refs/heads/') && method === 'PATCH') {
      if (this.patchRaces-- > 0) return this.response({}, 422);
      const hook = this.beforePatch;
      this.beforePatch = undefined;
      if (hook) {
        hook();
        return this.response({}, 422);
      }
      this.dataHead = z.object({ sha: z.string(), force: z.literal(false) }).parse(raw).sha;
      return this.response({ object: { sha: this.dataHead } });
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
