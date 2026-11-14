import { expect, it, vi } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { glossaryRoute } from '../src/glossary.js';
import { GitHub } from '../src/github.js';
import { config, Fixture, makePrivateKey } from './fixture.js';
import {
  emptyGlossary,
  maxGlossaryTerms,
  type Glossary,
} from '../../../packages/core/src/glossary/schema.js';

it('records a local CPU proxy at empty, typical, and maximum glossary sizes', async () => {
  const identity = { id: 1, login: 'alice' };
  const rows = [];
  for (const size of [100, 500, maxGlossaryTerms]) {
    const document: Glossary = {
      ...emptyGlossary('de'),
      terms: Object.fromEntries(
        Array.from({ length: size }, (_, index) => [
          `term ${index}`,
          {
            en: `Term ${index}`,
            term: `Begriff ${index}`,
            note: 'A note',
            forms: ['Form'],
            also: ['Alternative'],
            updatedAt: '2026-11-14T00:00:00Z',
            updatedBy: 'alice',
          },
        ]),
      ),
    };
    const github = new GitHub({ DATA_BRANCH: 'editor-data' } as never);
    vi.spyOn(github, 'head').mockResolvedValue('a'.repeat(40));
    vi.spyOn(github, 'requiredFile').mockResolvedValue({ sha: 'b'.repeat(40), value: config });
    const stored = JSON.stringify(document);
    vi.spyOn(github, 'file').mockImplementation(async () => ({
      sha: 'c'.repeat(40),
      value: JSON.parse(stored),
    }));
    vi.spyOn(github, 'commit').mockResolvedValue('d'.repeat(40));
    for (const method of ['GET', 'POST']) {
      const input = {
        ops: [
          {
            key: size ? 'term 0' : 'new',
            base: size ? document.terms['term 0'] : null,
            next: { en: size ? 'Term 0' : 'New', term: 'Geändert' },
          },
        ],
      };
      const run = async () => {
        const result = await glossaryRoute(
          new Request('https://api.example/glossary/de', {
            method,
            ...(method === 'POST' ? { body: JSON.stringify(input) } : {}),
          }),
          github,
          identity,
          'de',
        );
        expect(result.status).toBe(200);
        await result.text();
      };
      for (let index = 0; index < 5; index++) await run();
      const start = process.cpuUsage();
      const wall = performance.now();
      for (let index = 0; index < 100; index++) await run();
      const cpu = process.cpuUsage(start);
      rows.push({
        size,
        method,
        bytes: Buffer.byteLength(stored),
        cpuProxyMs: (cpu.user + cpu.system) / 1000 / 100,
        wallMs: (performance.now() - wall) / 100,
      });
    }
  }
  console.log('GLOSSARY_CPU_PROXY', JSON.stringify(rows));
  if (process.env.GLOSSARY_METRICS)
    writeFileSync(
      join(process.env.GLOSSARY_METRICS, 'cpu-proxy.json'),
      JSON.stringify(rows, null, 2),
    );
  vi.restoreAllMocks();
});

it('keeps GET, POST, and all three branch-race attempts inside the free-plan subrequest budget', async () => {
  const fixture = new Fixture(await makePrivateKey());
  try {
    const rows = [];
    for (const method of ['GET', 'POST']) {
      const start = fixture.subrequests;
      expect(
        (
          await fixture.request(
            '/glossary/de',
            method,
            method === 'POST'
              ? { ops: [{ key: 'jolt', base: null, next: { en: 'Jolt', term: 'Aufschrecken' } }] }
              : undefined,
          )
        ).status,
      ).toBe(200);
      rows.push({ method, subrequests: fixture.subrequests - start });
    }
    fixture.patchRaces = 3;
    const start = fixture.subrequests;
    expect(
      (
        await fixture.request('/glossary/fr', 'POST', {
          ops: [{ key: 'jolt', base: null, next: { en: 'Jolt', term: 'Secousse' } }],
        })
      ).status,
    ).toBe(409);
    rows.push({ method: 'POST+3races', subrequests: fixture.subrequests - start });
    expect(rows.every((row) => row.subrequests < 50)).toBe(true);
    console.log('GLOSSARY_SUBREQUESTS', JSON.stringify(rows));
    if (process.env.GLOSSARY_METRICS)
      writeFileSync(
        join(process.env.GLOSSARY_METRICS, 'subrequests.json'),
        JSON.stringify(rows, null, 2),
      );
  } finally {
    vi.unstubAllGlobals();
  }
});
