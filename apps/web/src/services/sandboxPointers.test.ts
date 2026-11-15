import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiRequest } from './api';
import { putSandboxPointers, sandboxPointersChangedMessage } from './sandboxPointers';

vi.mock('./api', () => ({ apiRequest: vi.fn() }));
afterEach(() => vi.mocked(apiRequest).mockReset());

const conflict = (error: string) =>
  vi.mocked(apiRequest).mockResolvedValue(new Response(JSON.stringify({ error }), { status: 409 }));

describe('saving sandbox picks', () => {
  it('turns both reload-worthy 409s into the stale message the page offers Reload for', async () => {
    for (const error of [
      'Sandbox picks changed since they were loaded; reload and retry',
      'Data branch kept moving; reload sandbox picks and retry',
    ]) {
      conflict(error);
      await expect(putSandboxPointers({}, null)).rejects.toThrow(sandboxPointersChangedMessage);
    }
  });

  it('passes the publisher gate 409 through as it is', async () => {
    conflict('The installed publisher lacks the "sandboxPointers" capability');
    await expect(putSandboxPointers({}, null)).rejects.toThrow(
      'Sandbox picks HTTP 409: The installed publisher lacks the "sandboxPointers" capability',
    );
  });
});
