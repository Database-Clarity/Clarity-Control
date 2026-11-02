import { z } from 'zod';

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });

export async function body<T>(
  request: Request,
  schema: z.ZodType<T>,
  maxBytes = 2_000_000,
): Promise<T> {
  const reader = request.body?.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let text = '';
  let size = 0;
  if (reader) {
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > maxBytes) {
          await reader.cancel();
          throw new HttpError(
            413,
            `Request exceeds ${maxBytes >= 1_000_000 ? `${maxBytes / 1_000_000} MB` : `${maxBytes} bytes`}`,
          );
        }
        text += decoder.decode(chunk.value, { stream: true });
      }
      text += decoder.decode();
    } catch (error) {
      if (error instanceof TypeError) throw new HttpError(400, 'Invalid UTF-8 request body');
      throw error;
    } finally {
      reader.releaseLock();
    }
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new HttpError(400, 'Invalid JSON');
  }
  const result = schema.safeParse(value);
  if (!result.success) throw new HttpError(400, 'Invalid request', result.error.issues);
  return result.data;
}

export async function upstreamJson(response: Response): Promise<unknown> {
  if (!response.ok) throw new HttpError(502, `Upstream request failed (${response.status})`);
  return response.json();
}

export function hashParam(value: string): number {
  if (!/^(0|[1-9]\d*)$/.test(value) || Number(value) > 0xffffffff) {
    throw new HttpError(400, 'Invalid tooltip hash');
  }
  return Number(value);
}
