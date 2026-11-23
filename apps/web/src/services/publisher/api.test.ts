import { publicationSyncPendingCode } from '@clarity/core';
import { expect, it, vi } from 'vitest';
import { apiRequest } from '../api';
import { postPublish } from './api';

vi.mock('../api', () => ({ apiRequest: vi.fn() }));

it.each([
  { status: 409, error: 'Tooltip 10 changed since review' },
  { status: 502, error: 'Upstream request failed' },
  { status: 409, error: 'Sync pending', details: { code: publicationSyncPendingCode } },
])(
  'preserves Worker errors and optional retry details ($status $error)',
  async ({ status, error, details }) => {
    vi.mocked(apiRequest).mockResolvedValueOnce(
      Response.json(details ? { error, details } : { error }, { status }),
    );
    await expect(
      postPublish({ opId: 'op', hashes: [10], expected: { 10: 'digest' } }),
    ).rejects.toMatchObject({
      status,
      message: error,
      fromWorker: true,
      code: details?.code,
    });
  },
);
