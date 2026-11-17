import { expect, it, vi } from 'vitest';
import { writeFileSync } from 'node:fs';
import { GitHub, blobContent } from '../src/github.js';
import { localizedSnippetsRoute } from '../src/localizedSnippets.js';
import { snippetEnglishHash } from '../../../packages/core/src/localizedSnippets.js';
import { snippetsPath } from '../../../packages/core/src/customSnippets.js';
import { config } from './fixture.js';
import type { Env } from '../src/types.js';

it('measures localized routes at the full team cap with current translations, excluding network I/O', async () => {
  const template = 'Bonus {{1:10}} ' + 'x'.repeat(1985);
  const enHash = await snippetEnglishHash(template);
  const entry = {
    label: 'Nachladen',
    keywords: 'x'.repeat(2000),
    template: 'Boni {{1:10}} ' + 'y'.repeat(1985),
    enHash,
  };
  const team = {
    v: 1,
    snippets: Array.from({ length: 100 }, (_, n) => ({
      id: `team:${n}`,
      label: `Bonus ${n}`,
      template,
      keywords: entry.keywords,
    })),
  };
  const translations = Object.fromEntries(team.snippets.map((s) => [s.id, entry]));
  const github = new GitHub({ DATA_BRANCH: 'editor-data' } as Env);
  vi.spyOn(github, 'head').mockResolvedValue('a'.repeat(40));
  vi.spyOn(github, 'requiredFile').mockResolvedValue({
    sha: 'b'.repeat(40),
    value: config,
    size: 0,
  });
  vi.spyOn(github, 'file').mockImplementation(async (path) => ({
    sha: 'c'.repeat(40),
    value: JSON.parse(blobContent(path === snippetsPath ? team : translations)),
    size: 0,
  }));
  // Include serialization performed by a real commit, without external I/O.
  vi.spyOn(github, 'commit').mockImplementation(async (_head, files) => {
    blobContent(files);
    return 'd'.repeat(40);
  });
  const user = { id: 1, login: 'alice' };
  const runs: Record<string, () => Promise<Response>> = {
    get: () =>
      localizedSnippetsRoute(new Request('https://api.test/snippets/local/de'), github, user, 'de'),
    management: () =>
      localizedSnippetsRoute(
        new Request('https://api.test/snippets/local/de?view=translations'),
        github,
        user,
        'de',
      ),
    put: () =>
      localizedSnippetsRoute(
        new Request('https://api.test/snippets/local/de', {
          method: 'PUT',
          body: JSON.stringify({ id: 'team:0', base: entry, next: { ...entry, label: 'Changed' } }),
        }),
        github,
        user,
        'de',
      ),
  };
  const rows = [];
  try {
    for (const [route, run] of Object.entries(runs)) {
      for (let n = 0; n < 5; n++) await (await run()).text();
      const samples = [];
      for (let batch = 0; batch < 7; batch++) {
        const cpu = process.cpuUsage();
        const start = performance.now();
        for (let n = 0; n < 20; n++) {
          const response = await run();
          expect(response.status).toBe(200);
          await response.text();
        }
        const elapsed = process.cpuUsage(cpu);
        samples.push({
          cpuProxyMs: (elapsed.user + elapsed.system) / 20000,
          wallMs: (performance.now() - start) / 20,
        });
      }
      const median = [...samples].sort((a, b) => a.cpuProxyMs - b.cpuProxyMs)[3]!;
      rows.push({ route, ...median, samples });
    }
    console.log('LOCALIZED_SNIPPETS_CPU_PROXY', JSON.stringify(rows));
    if (process.env.SNIPPETS_CPU_OUTPUT)
      writeFileSync(process.env.SNIPPETS_CPU_OUTPUT, JSON.stringify(rows, null, 2));
    if (process.env.SNIPPETS_CPU_GATE)
      for (const row of rows) expect(row.cpuProxyMs, row.route).toBeLessThanOrEqual(5);
  } finally {
    vi.restoreAllMocks();
  }
}, 60_000);
