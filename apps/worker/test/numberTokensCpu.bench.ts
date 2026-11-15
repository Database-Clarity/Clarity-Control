// Local route CPU proxy: immediate mocked I/O, with fixture CPU subtracted. This is not a
// deployed Workers CPU measurement. Run separately with a Vitest config including *.bench.ts.
import { generateKeyPairSync } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import { publishableHash, type Tooltip } from '@clarity/core';
import publisherConfig from '../../../config/publisher.json';
import worker from '../src/index.js';
import { signToken } from '../src/crypto.js';
import { Fixture, makePrivateKey } from './fixture.js';

it('measures number-token save and publish routes', async () => {
  publisherConfig.enabled = true;
  const f = new Fixture(await makePrivateKey());
  f.env.PUBLISH_SIGNING_KEY = generateKeyPairSync('ed25519')
    .privateKey.export({ type: 'pkcs8', format: 'pem' })
    .toString();
  const token = await signToken(
    {
      id: 2,
      login: 'bob',
      purpose: 'session',
      exp: Math.floor(Date.now() / 1000) + 3600,
    },
    f.env.SESSION_SECRET,
  );
  const originalFetch = globalThis.fetch;
  let mockCpu = 0;
  vi.stubGlobal('fetch', async (...args: Parameters<typeof fetch>) => {
    const start = performance.now();
    try {
      return await originalFetch(...args);
    } finally {
      mockCpu += performance.now() - start;
    }
  });
  const base: Tooltip = {
    hash: 123,
    associated: [],
    text: {
      en: {
        text: 'Grants 5 stacks. Each lasts 5 seconds.',
        updatedAt: '2026-10-01T00:00:00Z',
        updatedBy: 'alice',
      },
      de: {
        text: 'Hält #{=2} Sekunden, bis zu #{=1} Stapel.',
        updatedAt: '2026-10-01T00:00:00Z',
        updatedBy: 'dan',
        sourceUpdatedAt: '2026-10-01T00:00:00Z',
      },
    },
  };
  const call = async (path: string, body: unknown, expected = 200) => {
    const request = new Request('https://api.example' + path, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, Origin: f.env.SITE_ORIGIN },
      body: JSON.stringify(body),
    });
    mockCpu = 0;
    const requests = f.subrequests;
    const start = performance.now();
    const response = await worker.fetch(request, f.env, { waitUntil() {} });
    const text = await response.text();
    const cpu = performance.now() - start - mockCpu;
    expect(response.status, text).toBe(expected);
    expect(f.subrequests - requests).toBeLessThanOrEqual(50);
    return { cpu, subrequests: f.subrequests - requests };
  };
  const results: Record<string, unknown> = {};
  for (const scenario of ['carry', 'translator', 'text-retirement', 'publish'] as const) {
    const samples: number[] = [];
    let subrequests = 0;
    for (let i = 0; i < 21; i++) {
      f.moveData({
        'tooltips/123.json': base,
        '.publisher/PIN': { capabilities: ['numberTokens'] },
      });
      let result;
      if (scenario === 'publish') {
        const opId = '01K95H00000000000000000001';
        const now = [...opId.slice(0, 10)].reduce(
          (n, c) => n * 32 + '0123456789ABCDEFGHJKMNPQRSTVWXYZ'.indexOf(c),
          0,
        );
        vi.useFakeTimers({ toFake: ['Date'], now });
        // The session was minted before changing Date; its expiry still covers the fixture clock.
        f.moveData({ [`publish/requests/${opId}.json`]: undefined });
        try {
          result = await call(
            '/publish',
            { opId, hashes: [123], expected: { 123: await publishableHash(base, f.aliases) } },
            202,
          );
        } finally {
          vi.useRealTimers();
        }
      } else {
        const next = structuredClone(base);
        if (scenario === 'translator')
          next.text.de = {
            ...next.text.de!,
            text: 'Bis zu #{=1} Stapel für #{=2} Sekunden.',
            updatedAt: '2026-10-02T00:00:00Z',
          };
        else
          next.text.en = {
            ...next.text.en!,
            text:
              scenario === 'carry'
                ? 'Grants 6 stacks. Each lasts 7 seconds.'
                : 'No longer grants stacks.',
            updatedAt: '2026-10-02T00:00:00Z',
          };
        result = await call('/save', { changes: [{ hash: 123, base, next }], message: 'Edit' });
      }
      if (i === 0) results[scenario + 'ColdMs'] = result.cpu;
      else samples.push(result.cpu);
      subrequests = Math.max(subrequests, result.subrequests);
    }
    samples.sort((a, b) => a - b);
    results[scenario] = {
      medianMs: samples[10],
      p95Ms: samples[18],
      maxMs: samples.at(-1),
      subrequests,
    };
  }
  console.log('NUMBER_TOKENS_CPU ' + JSON.stringify(results));
  if (process.env.NUMBER_TOKENS_CPU_OUT)
    writeFileSync(process.env.NUMBER_TOKENS_CPU_OUT, JSON.stringify(results, null, 2));
  vi.unstubAllGlobals();
});
