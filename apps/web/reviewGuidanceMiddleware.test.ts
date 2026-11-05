import { createServer, type Server } from 'node:http';
import { readdirSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createGuidanceMiddleware, reviewGuidancePlugin } from './reviewGuidanceMiddleware';
import { guidanceSchema } from './src/features/compendium/guidanceSchema';

const servers: Server[] = [];
const directories: string[] = [];
async function fixture(file?: string) {
  if (!file) {
    const directory = await mkdtemp(join(tmpdir(), 'clarity-guidance-test-'));
    directories.push(directory);
    file = join(directory, 'review-guidance.json');
  }
  const middleware = createGuidanceMiddleware(file);
  const server = createServer((request, response) =>
    middleware(request, response, () => {
      response.writeHead(404);
      response.end();
    }),
  );
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No test listener');
  const origin = `http://127.0.0.1:${address.port}`;
  return {
    file,
    server,
    origin,
    get: () => fetch(`${origin}/__review-guidance`),
    write: (document: unknown, revision: string | null, requestOrigin = origin) =>
      fetch(`${origin}/__review-guidance`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: requestOrigin },
        body: JSON.stringify({ document, revision }),
      }),
  };
}
const document = {
  version: 1,
  scope: 'test data',
  baseline: 'test source',
  categories: {
    'catalog:weapon-trait': {
      id: 'catalog:weapon-trait',
      name: 'Traits',
      rule: 'categoryId = weapon-trait',
      hashes: [10, 20],
      count: 2,
      active: true,
      comment: 'Owner says: investigate mechanics.',
    },
  },
};
afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve())),
          ),
      ),
  );
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
  vi.restoreAllMocks();
});
it('writes readable guidance atomically and reads it from another server without export', async () => {
  const first = await fixture();
  expect(await (await first.get()).json()).toEqual({ document: null, revision: null });
  const response = await first.write(document, null);
  expect(response.status).toBe(200);
  const saved = await response.json();
  expect(saved.revision).toMatch(/^[a-f0-9]{64}$/);
  expect(guidanceSchema.parse(JSON.parse(await readFile(first.file, 'utf8')))).toEqual(document);
  const phone = await fixture(first.file);
  expect(await (await phone.get()).json()).toEqual(saved);
  expect(await readdir(directories[0])).toEqual(['review-guidance.json']);
});
it('releases the lock before completing a save so an immediate sequential save succeeds', async () => {
  const first = await fixture();
  let filesAtCompletion: string[] | undefined;
  first.server.once('request', (_request, response) => {
    response.once('finish', () => {
      // Observe cleanup synchronously: awaiting filesystem work here would hide the race.
      filesAtCompletion = readdirSync(directories[0]);
    });
  });
  const updated = { ...document, baseline: 'immediate sequential save' };
  const second = await first.write(document, null).then(async (response) => {
    expect(response.status).toBe(200);
    const saved = await response.json();
    return first.write(updated, saved.revision);
  });
  expect(filesAtCompletion).toEqual(['review-guidance.json']);
  expect(second.status).toBe(200);
  expect((await second.json()).document).toEqual(updated);
  expect(JSON.parse(await readFile(first.file, 'utf8'))).toEqual(updated);
});
it('atomically extends legacy comments with readable sample decisions without dropping owner guidance', async () => {
  const server = await fixture();
  const first = await (await server.write(document, null)).json();
  const updated = {
    ...document,
    categories: {
      ...document.categories,
      'catalog:weapon-trait': {
        ...document.categories['catalog:weapon-trait'],
        references: {
          10: {
            hash: 10,
            name: 'Example',
            categoryId: 'catalog:weapon-trait',
            evidence: 'entry evidence',
            baseline: document.baseline,
            timestamp: '2026-11-01T00:00:00Z',
            decision: 'no-equivalent',
            note: 'No matching source',
          },
        },
      },
    },
  };
  expect((await server.write(updated, first.revision)).status).toBe(200);
  expect(JSON.parse(await readFile(server.file, 'utf8'))).toEqual(updated);
  const phone = await fixture(server.file);
  expect((await (await phone.get()).json()).document).toEqual(updated);
});
it('rejects stale/concurrent writes from separate Vite servers, retaining the accepted owner comment', async () => {
  const first = await fixture();
  const second = await fixture(first.file);
  const responses = await Promise.all([
    first.write(document, null),
    second.write({ ...document, baseline: 'concurrent' }, null),
  ]);
  expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
  const saved = await (await first.get()).json();
  expect((await second.write(document, 'stale')).status).toBe(409);
  expect(await (await first.get()).json()).toEqual(saved);
});
it('rejects cross-origin, non-JSON and invalid category counts without creating a file', async () => {
  const server = await fixture();
  expect((await server.write(document, null, 'https://untrusted.example')).status).toBe(403);
  expect(
    (
      await server.write(
        {
          ...document,
          categories: {
            ...document.categories,
            'catalog:weapon-trait': { ...document.categories['catalog:weapon-trait'], count: 100 },
          },
        },
        null,
      )
    ).status,
  ).toBe(400);
  expect(
    (
      await fetch(`${server.origin}/__review-guidance`, {
        method: 'POST',
        body: 'not json',
      })
    ).status,
  ).toBe(403);
  expect(await readdir(directories[0])).toEqual([]);
  expect(reviewGuidancePlugin(server.file).apply).toBe('serve');
  expect(reviewGuidancePlugin(server.file)).not.toHaveProperty('configurePreviewServer');
});
it('surfaces invalid disk data without replacing it with an empty successful record', async () => {
  const server = await fixture();
  await writeFile(server.file, '{"version":999}');
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  expect((await server.get()).status).toBe(500);
  expect((await server.write(document, null)).status).toBe(500);
  expect(await readFile(server.file, 'utf8')).toBe('{"version":999}');
  expect(log).toHaveBeenCalledTimes(2);
});
