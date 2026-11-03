import { describe, expect, it, vi } from 'vitest';
import type { Me } from '../api';
import { permissionError, prepareChanges, validateChanges } from './pipeline';
import { editorData, english, tooltip } from './fixtures.testSupport';

const user: Me = { id: 1, login: 'user', role: 'editor' };
const translator: Me = { ...user, role: 'translator', languages: ['fr'] };
const next = { ...tooltip, text: { ...tooltip.text, en: { ...english, text: 'Changed English' } } };

describe('conflict markers block saving', () => {
  const block = '<<<<<<< mine\nMine\n=======\nTheirs\n>>>>>>> theirs (bob)';
  const marked = (en: string, fr?: string) => ({
    ...tooltip,
    text: {
      en: { ...english, text: en },
      ...(fr === undefined ? {} : { fr: { ...english, text: fr } }),
    },
  });
  it('is an error per language that still has a block, and nothing else is reported for it', () => {
    const issues = validateChanges(
      [{ hash: 123, base: tooltip, next: marked(`Line\n${block}`, block) }],
      editorData(),
    );
    const errors = issues.filter((issue) => issue.severity === 'error');
    expect(errors.map((issue) => issue.lang).sort()).toEqual(['en', 'fr']);
    expect(errors[0]!.message).toContain('unresolved conflict');
    // The markers themselves raise no markup errors beyond the conflict error.
    expect(
      issues.filter((issue) => issue.lang === 'en' && issue.severity === 'error'),
    ).toHaveLength(1);
  });
  it('a stray marker left by a hand edit still blocks', () => {
    const issues = validateChanges(
      [{ hash: 123, base: tooltip, next: marked('Line\n>>>>>>> theirs') }],
      editorData(),
    );
    expect(issues.some((issue) => issue.severity === 'error')).toBe(true);
  });
  it('is gone once the block is resolved', () => {
    expect(
      validateChanges(
        [{ hash: 123, base: tooltip, next: marked('Line\nMine') }],
        editorData(),
      ).filter((issue) => issue.severity === 'error'),
    ).toEqual([]);
  });
  it('prepareChanges refuses a change with markers before any request', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch');
    try {
      await expect(
        prepareChanges([{ hash: 123, base: tooltip, next: marked(block) }], user, editorData()),
      ).rejects.toThrow('Validation');
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      fetch.mockRestore();
    }
  });
});

describe('save preparation', () => {
  it('surfaces glyph warnings in save review and allows preparation', async () => {
    const change = {
      hash: 123,
      base: tooltip,
      next: { ...next, text: { en: { ...english, text: 'Damage 🠚 higher' } } },
    };
    expect(validateChanges([change], editorData())).toEqual([
      expect.objectContaining({
        severity: 'warning',
        hash: 123,
        lang: 'en',
        message: expect.stringContaining('U+1F81A'),
      }),
    ]);
    const prepared = await prepareChanges([change], user, editorData());
    expect(prepared[0].next.text.en?.text).toBe('Damage 🠚 higher');
  });
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
  it('blocks saving a tooltip that defines a global name locally, and only that tooltip', async () => {
    const clashing = {
      ...next,
      text: { en: { ...english, text: 'var range = 1\n#range' } },
    };
    const other = { ...tooltip, hash: 124, text: { en: { ...english, text: 'Plain' } } };
    const data = editorData();
    data.bundle.tooltips[2] = {
      ...tooltip,
      hash: 2,
      text: { en: { ...english, text: 'var range = 5' } },
    };
    const issues = validateChanges(
      [
        { hash: 123, base: tooltip, next: clashing },
        { hash: 124, base: null, next: other },
      ],
      data,
    );
    expect(issues).toEqual([
      expect.objectContaining({
        severity: 'error',
        hash: 123,
        message: expect.stringContaining('#range is already a global variable'),
      }),
    ]);
    await expect(
      prepareChanges([{ hash: 123, base: tooltip, next: clashing }], user, data),
    ).rejects.toThrow('Validation errors');
    await expect(
      prepareChanges([{ hash: 124, base: null, next: other }], user, data),
    ).resolves.toHaveLength(1);
  });
  it('blocks adding a global whose name is defined locally in another tooltip', () => {
    const data = editorData();
    data.bundle.tooltips[123] = {
      ...tooltip,
      text: { en: { ...english, text: 'var range = 1' } },
    };
    const base = { ...tooltip, hash: 2, text: { en: { ...english, text: 'var other = 1' } } };
    const added = { ...base, text: { en: { ...english, text: 'var other = 1\nvar range = 5' } } };
    const issues = validateChanges([{ hash: 2, base, next: added }], data);
    expect(issues.filter((issue) => issue.severity === 'error')).toEqual([
      expect.objectContaining({ hash: 2, message: expect.stringContaining('tooltip 123') }),
    ]);
    const renamed = { ...base, text: { en: { ...english, text: 'var free = 1' } } };
    expect(validateChanges([{ hash: 2, base, next: renamed }], data)).toEqual([]);
  });
});
