import { afterEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { errorMessage, fetchJson, fetchOptionalJson } from './http';
import { itemsSchema } from './generatorSchema';
import { validateJsonBytes } from './jsonValidation';

afterEach(() => vi.unstubAllGlobals());

it('offloads known large schemas while preserving validation and custom schemas', async () => {
  const posted = vi.fn();
  class ValidationWorker {
    onmessage?: (event: { data: unknown }) => void;
    postMessage(message: { id: number; kind: 'items'; bytes: ArrayBuffer }) {
      posted(message.kind);
      queueMicrotask(() => {
        try {
          this.onmessage?.({
            data: { id: message.id, bytes: validateJsonBytes(message.kind, message.bytes) },
          });
        } catch (error) {
          this.onmessage?.({ data: { id: message.id, error: String(error) } });
        }
      });
    }
  }
  vi.stubGlobal('Worker', ValidationWorker);
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation(async () => Response.json({ 42: { hash: 43 } })),
  );
  await expect(fetchJson('/items.json', itemsSchema)).rejects.toThrow();
  expect(posted).toHaveBeenCalledWith('items');
  // The URL alone must never select a different schema.
  await expect(fetchJson('/items.json', z.object({ custom: z.string() }))).rejects.toThrow();
  expect(posted).toHaveBeenCalledTimes(1);
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 404 })));
  await expect(fetchOptionalJson('/optional', itemsSchema)).resolves.toBeUndefined();
});

it('turns raw browser fetch failures into a plain retry message', () => {
  for (const raw of ['Failed to fetch', 'Load failed', 'NetworkError when attempting to fetch']) {
    expect(errorMessage(new TypeError(raw))).toMatch(/Could not reach the server/);
  }
  expect(errorMessage(new Error('HTTP 500'))).toBe('HTTP 500');
  expect(errorMessage(new TypeError('x is not a function'))).toBe('x is not a function');
});
