import { DatabaseSync } from 'node:sqlite';
import { readFileSync, writeFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import { GitHub, blobContent } from '../src/github.js';
import { personalSnippetsRoute, teamSnippetsRoute } from '../src/snippets.js';
import { snippetsAccountId, snippetsKey, encryptSnippet } from '../src/snippetCrypto.js';
import { config } from './fixture.js';
import type { SettingsDatabase, SettingsStatement } from '../src/settings.js';
import type { Env } from '../src/types.js';

it('measures every snippets route with full-cap documents and local D1, excluding network I/O', async () => {
  const db = new DatabaseSync(':memory:');
  db.exec(
    readFileSync(new URL('../migrations/settings/0003_user_snippets.sql', import.meta.url), 'utf8'),
  );
  const binding: SettingsDatabase = {
    prepare(sql) {
      let values: (string | number | null)[] = [];
      const stmt: SettingsStatement = {
        bind(...args) {
          values = args;
          return stmt;
        },
        async first<T>() {
          return (db.prepare(sql).get(...values) ?? null) as T | null;
        },
        async run() {
          return { meta: { changes: Number(db.prepare(sql).run(...values).changes) } };
        },
      };
      return stmt;
    },
  };
  const secret = 's'.repeat(40);
  const account = await snippetsAccountId(secret, 1);
  const key = await snippetsKey(secret);
  const template = 'Bonus {{1:10}} ' + 'x'.repeat(1985);
  const mine = { id: 'me:0', label: 'My bonus', template };
  const team = {
    v: 1,
    snippets: Array.from({ length: 100 }, (_, n) => ({
      ...mine,
      id: `team:${n}`,
      label: 'Team bonus',
    })),
  };
  const initialRevision = 'a'.repeat(32);
  for (let n = 0; n < 50; n++) {
    const id = `me:${n}`;
    const cipher = await encryptSnippet(key, `${account}:${id}`, {
      snippet: { ...mine, id },
      revision: initialRevision,
    });
    db.prepare('INSERT INTO user_snippets VALUES (?, ?, ?, ?, ?)').run(
      account,
      id,
      cipher.iv,
      cipher.ct,
      initialRevision,
    );
  }
  const github = new GitHub({
    DATA_BRANCH: 'editor-data',
    SESSION_SECRET: secret,
    SETTINGS_DB: binding,
  } as Env);
  vi.spyOn(github, 'head').mockResolvedValue('a'.repeat(40));
  vi.spyOn(github, 'requiredFile').mockResolvedValue({
    sha: 'b'.repeat(40),
    value: config,
    size: 0,
  });
  vi.spyOn(github, 'file').mockImplementation(async () => ({
    sha: 'c'.repeat(40),
    value: JSON.parse(blobContent(team)),
    size: 0,
  }));
  vi.spyOn(github, 'commit').mockResolvedValue('d'.repeat(40));
  const user = { id: 1, login: 'alice' };
  let revision = initialRevision;
  let sequence = 0;
  const makeRequest = (path: string, method = 'GET', body?: unknown) =>
    new Request(`https://api.test${path}`, {
      method,
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  const runs: Record<string, () => Promise<Response>> = {
    'mine-index': () => personalSnippetsRoute(makeRequest('/snippets/mine'), github, user),
    'mine-get': () =>
      personalSnippetsRoute(makeRequest('/snippets/mine/me:0'), github, user, 'me:0'),
    'mine-update': async () => {
      const response = await personalSnippetsRoute(
        makeRequest('/snippets/mine/me:0', 'PUT', {
          snippet: { ...mine, label: `Bonus ${sequence++}` },
          revision,
        }),
        github,
        user,
        'me:0',
      );
      revision = ((await response.clone().json()) as { revision: string }).revision;
      return response;
    },
    'mine-delete-create': async () => {
      await personalSnippetsRoute(
        makeRequest('/snippets/mine/me:0', 'PUT', { snippet: null, revision }),
        github,
        user,
        'me:0',
      );
      const response = await personalSnippetsRoute(
        makeRequest('/snippets/mine/me:0', 'PUT', { snippet: mine, revision: null }),
        github,
        user,
        'me:0',
      );
      revision = ((await response.clone().json()) as { revision: string }).revision;
      return response;
    },
    'team-get': () => teamSnippetsRoute(makeRequest('/snippets/team'), github, user),
    'team-update': () =>
      teamSnippetsRoute(
        makeRequest('/snippets/team', 'PUT', {
          id: 'team:0',
          base: team.snippets[0],
          next: { ...team.snippets[0], label: 'Changed' },
        }),
        github,
        user,
      ),
    'team-copy': () =>
      teamSnippetsRoute(
        makeRequest('/snippets/team/copy', 'POST', {
          id: 'team:0',
          base: team.snippets[0],
          sourceId: mine.id,
          sourceRevision: revision,
        }),
        github,
        user,
        true,
      ),
  };
  const rows = [];
  try {
    for (const [route, run] of Object.entries(runs)) {
      for (let n = 0; n < 5; n++) {
        const response = await run();
        expect(response.status).toBe(200);
        await response.text();
      }
      const cpu = process.cpuUsage();
      const start = performance.now();
      for (let n = 0; n < 100; n++) {
        const response = await run();
        expect(response.status).toBe(200);
        await response.text();
      }
      const elapsed = process.cpuUsage(cpu);
      rows.push({
        route,
        cpuProxyMs: (elapsed.user + elapsed.system) / 100000,
        wallMs: (performance.now() - start) / 100,
      });
    }
    console.log('SNIPPETS_CPU_PROXY', JSON.stringify(rows));
    if (process.env.SNIPPETS_CPU_OUTPUT)
      writeFileSync(process.env.SNIPPETS_CPU_OUTPUT, JSON.stringify(rows, null, 2));
    if (process.env.SNIPPETS_CPU_GATE)
      for (const row of rows) expect(row.cpuProxyMs, row.route).toBeLessThanOrEqual(5);
  } finally {
    db.close();
    vi.restoreAllMocks();
  }
}, 60_000);
