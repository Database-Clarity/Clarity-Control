import { describe, expect, it } from 'vitest';
import type { Tooltip } from '@clarity/core';
import { known, lastEdit } from './lastEdit';

const entry = (updatedAt: string, updatedBy: string) => ({ text: 'x', updatedAt, updatedBy });

describe('lastEdit', () => {
  it('takes the newest recorded edit in any language', () => {
    const tooltip = {
      hash: 1,
      associated: [],
      text: {
        en: entry('2026-10-01T00:00:00Z', 'ann'),
        de: entry('2026-10-03T00:00:00Z', 'bo'),
        fr: entry('2026-10-02T00:00:00Z', 'cy'),
      },
    } as Tooltip;
    expect(lastEdit(tooltip)).toEqual({ at: '2026-10-03T00:00:00Z', by: 'bo' });
  });
  it('ignores epoch-0 and missing times, then falls back to the legacy upload', () => {
    const tooltip = {
      hash: 1,
      associated: [],
      text: { en: entry('1970-01-01T00:00:00.000Z', '') },
      legacy: { lastUpload: '2025-01-01T00:00:00Z', uploadedBy: 'legacy' },
    } as unknown as Tooltip;
    expect(lastEdit(tooltip)).toEqual({ at: '2025-01-01T00:00:00Z', by: 'legacy' });
    expect(lastEdit({ hash: 1, associated: [], text: {} })).toEqual({});
    expect(known(undefined)).toBeUndefined();
  });
});
