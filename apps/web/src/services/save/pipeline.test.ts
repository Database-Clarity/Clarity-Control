import { describe, expect, it, vi } from 'vitest';
import type { Me } from '../api';
import { permissionError, prepareChanges, validateChanges } from './pipeline';
import { editorData, english, tooltip } from './fixtures.testSupport';

const user: Me = { id: 1, login: 'user', role: 'editor' };
const translator: Me = { ...user, role: 'translator', languages: ['fr'] };
const next = { ...tooltip, text: { ...tooltip.text, en: { ...english, text: 'Changed English' } } };

describe('save preparation', () => {
  it('blocks malformed source before any enrichment/network request', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch');
    try {
      await expect(
        prepareChanges(
          [
            {
              hash: 123,
              base: tooltip,
              next: { ...tooltip, text: {} },
            },
          ],
          user,
          editorData(),
        ),
      ).rejects.toThrow('Validation');
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      fetch.mockRestore();
    }
  });
  it('allows warnings and stamps at the final save boundary', async () => {
    const result = await prepareChanges(
      [
        {
          hash: 123,
          base: tooltip,
          next: { ...next, text: { en: { ...english, text: '#unknown' } } },
        },
      ],
      user,
      editorData(),
    );
    expect(result[0].next.text.en?.updatedBy).toBe('user');
    expect(result[0].next.bungieSnapshot?.description).toBe('In-game');
  });
  it('resolves alias imports against the candidate save, not unsaved unrelated drafts', () => {
    const imported = {
      ...tooltip,
      hash: 124,
      text: { en: { ...english, text: 'import main from 456' } },
    };
    expect(validateChanges([{ hash: 124, base: null, next: imported }], editorData())).toEqual([]);
    expect(() =>
      validateChanges([{ hash: 456, base: null, next: { ...tooltip, hash: 456 } }], editorData()),
    ).toThrow('alias');
  });
  it('checks recovered drafts against the current role instead of silently filtering changes', () => {
    expect(permissionError([{ hash: 123, base: tooltip, next }], translator)).toContain(
      'cannot edit English',
    );
    const fr = { ...tooltip, text: { ...tooltip.text, fr: { ...english, text: 'French' } } };
    expect(permissionError([{ hash: 123, base: tooltip, next: fr }], translator)).toBeNull();
    expect(
      permissionError(
        [{ hash: 123, base: tooltip, next: { ...fr, associated: [20] } }],
        translator,
      ),
    ).toContain('Other fields');
    expect(permissionError([{ hash: 123, base: null, next: fr }], translator)).toContain(
      'cannot create',
    );
    expect(permissionError([], null)).toContain('Sign in');
  });
  it('validates simultaneous globals and dependent text using the same prospective catalog', () => {
    const variable = { ...tooltip, hash: 2, text: { en: { ...english, text: 'var new = Value' } } };
    const dependent = { ...next, text: { en: { ...english, text: '#new' } } };
    expect(
      validateChanges(
        [
          { hash: 2, base: null, next: variable },
          { hash: 123, base: tooltip, next: dependent },
        ],
        editorData(),
      ),
    ).toEqual([]);
  });
});
