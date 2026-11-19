import { afterEach, expect, it, vi } from 'vitest';
import { apiRequest } from './apiAuth';
import { getTranslators } from './managers';
import { plainError } from './httpError';

vi.mock('./apiAuth', () => ({ apiRequest: vi.fn() }));
afterEach(() => vi.mocked(apiRequest).mockReset());

it('never puts an HTML error page in the message; the Worker sentence stays', async () => {
  const page = '<html><body>Bad gateway</body></html>';
  vi.mocked(apiRequest).mockResolvedValueOnce(new Response(page, { status: 502 }));
  const failed = (await getTranslators('de').catch((error: Error) => error)) as Error;
  expect(failed.message).toBe('Translation managers request failed (the server answered 502).');
  expect(failed.cause).toBe(page);

  vi.mocked(apiRequest).mockResolvedValueOnce(
    Response.json({ error: 'Only managers of de can list its translators' }, { status: 403 }),
  );
  await expect(getTranslators('de')).rejects.toThrow(
    'Translation managers request: Only managers of de can list its translators',
  );
});

it('shows a reply in the wrong shape as a plain message, not the schema issues', async () => {
  vi.mocked(apiRequest).mockResolvedValueOnce(Response.json({ translators: null }));
  const failed = await getTranslators('de').catch((error: unknown) => error);
  expect(plainError(failed)).toBe(
    'The server sent data in an unexpected shape. Retry, or reload the page.',
  );
});
