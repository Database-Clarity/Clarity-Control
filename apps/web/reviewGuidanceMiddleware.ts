import { createHash, randomUUID } from 'node:crypto';
import { open, readFile, rename, unlink } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Connect, Plugin } from 'vite';
import { guidanceSchema, guidanceWriteSchema } from './src/features/compendium/guidanceSchema';

const maxBytes = 2_000_000;
function missing(error: unknown) {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}
async function readGuidance(file: string) {
  try {
    const raw = await readFile(file, 'utf8');
    return {
      document: guidanceSchema.parse(JSON.parse(raw)),
      revision: createHash('sha256').update(raw).digest('hex'),
    };
  } catch (error) {
    if (missing(error)) return { document: null, revision: null };
    throw error;
  }
}
function send(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(body));
}
async function body(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += buffer.length;
    if (length > maxBytes) throw new Error('Guidance request exceeds 2 MB');
    chunks.push(buffer);
  }
  return guidanceWriteSchema.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
}

export function createGuidanceMiddleware(file: string): Connect.NextHandleFunction {
  return (request, response, next) => {
    if (request.url?.split('?')[0] !== '/__review-guidance') return next();
    void (async () => {
      if (
        request.headers.origin &&
        !['http:', 'https:'].some(
          (protocol) => request.headers.origin === `${protocol}//${request.headers.host}`,
        )
      ) {
        send(response, 403, { error: 'Guidance accepts same-origin requests only' });
        return;
      }
      if (request.method === 'GET') {
        send(response, 200, await readGuidance(file));
        return;
      }
      if (request.method !== 'POST') {
        send(response, 405, { error: 'Use GET or POST for local guidance' });
        return;
      }
      if (
        !request.headers.origin ||
        request.headers['content-type']?.split(';')[0] !== 'application/json'
      ) {
        send(response, 403, { error: 'Guidance writes require same-origin JSON' });
        return;
      }
      let payload;
      try {
        payload = await body(request);
      } catch (error) {
        send(response, 400, { error: error instanceof Error ? error.message : String(error) });
        return;
      }
      let lock;
      try {
        lock = await open(`${file}.lock`, 'wx');
      } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'EEXIST') {
          send(response, 409, {
            error: 'Another server is saving guidance. Retry after it finishes.',
          });
          return;
        }
        throw error;
      }
      const temporary = `${file}.${randomUUID()}.tmp`;
      let temporaryExists = false;
      let result: { status: number; body: unknown };
      try {
        const current = await readGuidance(file);
        if (current.revision !== payload.revision) {
          result = {
            status: 409,
            body: { error: 'Guidance changed on disk. Reload it before editing again.' },
          };
        } else {
          const raw = `${JSON.stringify(payload.document, null, 2)}\n`;
          const output = await open(temporary, 'wx');
          temporaryExists = true;
          try {
            await output.writeFile(raw, 'utf8');
            await output.sync();
          } finally {
            await output.close();
          }
          await rename(temporary, file);
          temporaryExists = false;
          result = {
            status: 200,
            body: {
              document: payload.document,
              revision: createHash('sha256').update(raw).digest('hex'),
            },
          };
        }
      } finally {
        await lock.close();
        await unlink(`${file}.lock`);
        if (temporaryExists) await unlink(temporary);
      }
      send(response, result.status, result.body);
    })().catch((error: unknown) => {
      console.error('Local review guidance failed:', error);
      if (!response.headersSent)
        send(response, 500, { error: error instanceof Error ? error.message : String(error) });
    });
  };
}

export function reviewGuidancePlugin(file: string): Plugin {
  return {
    name: 'local-review-guidance',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use(createGuidanceMiddleware(file));
    },
  };
}
