import { describe, expect, it, vi } from 'vitest';
import type { Me } from '../api';
import { noTooltipYet, permissionError, prepareChanges, validateChanges } from './pipeline';
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

describe('validation is scoped to text the change edits', () => {
  const entry = (text: string) => ({ ...english, text });
  const errors = (issues: ReturnType<typeof validateChanges>) =>
    issues.filter((issue) => issue.severity === 'error');
  const emptyEnglish = { ...tooltip, text: {} };

  it('a link-only change on an empty-English tooltip saves', async () => {
    const change = { hash: 123, base: emptyEnglish, next: { ...emptyEnglish, associated: [30] } };
    expect(validateChanges([change], editorData())).toEqual([]);
    const prepared = await prepareChanges([change], user, editorData());
    expect(prepared[0].next.associated).toEqual([30]);
  });
  it('editing English to empty still blocks', async () => {
    const change = { hash: 123, base: tooltip, next: { ...tooltip, text: { en: entry('  ') } } };
    expect(errors(validateChanges([change], editorData()))).toEqual([
      expect.objectContaining({ lang: 'en', message: 'English text must not be empty.' }),
    ]);
    await expect(prepareChanges([change], user, editorData())).rejects.toThrow('Validation');
  });
  it('an error in unchanged French does not block an English edit, but edited French does', () => {
    const base = { ...tooltip, text: { en: entry('Old'), fr: entry('import main from 999') } };
    const english = { ...base, text: { ...base.text, en: entry('New') } };
    const issues = validateChanges([{ hash: 123, base, next: english }], editorData());
    expect(errors(issues)).toEqual([]);
    expect(issues).toContainEqual(
      expect.objectContaining({ lang: 'fr', severity: 'warning', message: expect.any(String) }),
    );
    const french = { ...base, text: { ...base.text, fr: entry('import main from 998') } };
    expect(errors(validateChanges([{ hash: 123, base, next: french }], editorData()))).toEqual([
      expect.objectContaining({ lang: 'fr' }),
    ]);
  });
  it('an unknown-variable error in unchanged English does not block a link-only change', () => {
    const base = { ...tooltip, text: { en: entry('import main from 999') } };
    const issues = validateChanges(
      [{ hash: 123, base, next: { ...base, associated: [30] } }],
      editorData(),
    );
    expect(errors(issues)).toEqual([]);
  });
  it('one bad edited tooltip still blocks a batch of otherwise fine changes', () => {
    const second = { ...tooltip, hash: 124 };
    const bad = { ...second, text: { en: entry('import main from 999') } };
    const data = editorData();
    data.bundle.tooltips[124] = second;
    const issues = validateChanges(
      [
        { hash: 123, base: emptyEnglish, next: { ...emptyEnglish, associated: [30] } },
        { hash: 124, base: second, next: bad },
      ],
      data,
    );
    expect(errors(issues).map((issue) => issue.hash)).toEqual([124]);
  });
  describe('an error in unchanged text (rule A: blocks only if it uses something this save changes)', () => {
    const newline = String.fromCharCode(10);
    const lines = (...parts: string[]) => parts.join(newline);
    const hidden = (name: string, ...body: string[]) =>
      lines(`export hidden ${name} (`, ...body, ')');
    type Edit = [hash: number, before: string | null, after: string];
    /** Saves a link-only change on 123 (unchanged text) with the given edits in the same batch. */
    const save = (dependentText: string, saved: Record<number, string>, edits: Edit[] = []) => {
      const state = editorData();
      const dependent = { ...tooltip, text: { en: entry(dependentText) } };
      state.bundle.tooltips[123] = dependent;
      for (const [hash, text] of Object.entries(saved)) {
        state.bundle.tooltips[Number(hash)] = {
          ...tooltip,
          hash: Number(hash),
          text: { en: entry(text) },
        };
      }
      const changes = [{ hash: 123, base: dependent, next: { ...dependent, associated: [30] } }];
      for (const [hash, before, after] of edits) {
        const base = before === null ? null : { ...tooltip, hash, text: { en: entry(before) } };
        if (base) state.bundle.tooltips[hash] = base;
        changes.push({
          hash,
          base,
          next: { ...tooltip, hash, text: { en: entry(after) } },
        } as never);
      }
      return { state, changes, issues: validateChanges(changes, state) };
    };
    const blocks123 = (issues: ReturnType<typeof validateChanges>) =>
      errors(issues).some((issue) => issue.hash === 123);
    const warns123 = (issues: ReturnType<typeof validateChanges>) =>
      errors(issues).length === 0 &&
      issues.some((issue) => issue.hash === 123 && issue.severity === 'warning');
    const foo = hidden('foo', 'Shared');

    it('blocks when a sibling removes the export the text imports, with the reason', async () => {
      const run = save('import foo from 124', { 124: foo }, [[124, foo, 'No export now']]);
      expect(errors(run.issues)).toEqual([
        expect.objectContaining({
          hash: 123,
          message: expect.stringContaining('uses "Tooltip 124" (124), which this save changes'),
        }),
      ]);
      await expect(prepareChanges(run.changes, user, run.state)).rejects.toThrow('Validation');
    });
    it('does not block when the import keeps working', () => {
      const run = save('import foo from 124', { 124: foo }, [[124, foo, hidden('foo', 'Changed')]]);
      expect(errors(run.issues)).toEqual([]);
    });
    it('blocks a second path to the same missing import (P7)', () => {
      const run = save(lines('import bad from 999', 'import foo from 124'), { 124: foo }, [
        [124, foo, hidden('foo', 'import bad from 999')],
      ]);
      expect(blocks123(run.issues)).toBe(true);
    });
    it('blocks when the batch repairs one broken import and breaks another', () => {
      const bar = hidden('bar', 'Shared');
      const brokenFoo = hidden('foo', 'import bad from 999');
      const run = save(
        lines('import foo from 124', 'import bar from 125'),
        { 124: brokenFoo, 125: bar },
        [
          [124, brokenFoo, foo],
          [125, bar, hidden('bar', 'import bad from 999')],
        ],
      );
      expect(blocks123(run.issues)).toBe(true);
    });
    it('blocks a nested repair and break under one import line (F1)', () => {
      const left = hidden('left', 'import bad from 999');
      const right = hidden('right', 'Shared');
      const run = save(
        'import foo from 124',
        {
          124: hidden('foo', 'import left from 125', 'import right from 126'),
          125: left,
          126: right,
        },
        [
          [125, left, hidden('left', 'Shared')],
          [126, right, hidden('right', 'import bad from 999')],
        ],
      );
      expect(blocks123(run.issues)).toBe(true);
    });
    it('only warns for two untouched import cycles on a metadata-only save (F2)', () => {
      const run = save(lines('import foo from 124', 'import bar from 125'), {
        124: hidden('foo', 'import foo from 124'),
        125: hidden('bar', 'import bar from 125'),
      });
      expect(warns123(run.issues)).toBe(true);
    });
    it('blocks a commented-out path that becomes visible', () => {
      const commented = hidden('foo', '/*', 'import bad from 999', '*/');
      const run = save(lines('import bad from 999', 'import foo from 124'), { 124: commented }, [
        [124, commented, hidden('foo', 'import bad from 999')],
      ]);
      expect(blocks123(run.issues)).toBe(true);
    });
    it('blocks a repaired dependency beside a newly broken import self', () => {
      const brokenFoo = hidden('foo', 'import self');
      const bar = hidden('bar', 'Shared');
      const run = save(
        lines('import foo from 124', 'import bar from 125'),
        { 124: brokenFoo, 125: bar },
        [
          [124, brokenFoo, foo],
          [125, bar, hidden('bar', 'import self')],
        ],
      );
      expect(blocks123(run.issues)).toBe(true);
    });
    it('blocks when a target it already failed to import is added in the batch', () => {
      const run = save('import foo from 125', {}, [
        [125, null, hidden('foo', 'import bad from 999')],
      ]);
      expect(blocks123(run.issues)).toBe(true);
    });
    it('only warns when the batch changes nothing the text uses', () => {
      const run = save('import bad from 999', { 130: 'Other' }, [[130, 'Other', 'Other, edited']]);
      expect(warns123(run.issues)).toBe(true);
    });
    it('only warns for a changed global the text never mentions', () => {
      const run = save('import bad from 999', {}, [[2, 'var unused = One', 'var unused = Two']]);
      expect(warns123(run.issues)).toBe(true);
    });
    it('blocks when the batch changes a global the text mentions', () => {
      const run = save(lines('import bad from 999', '#unused'), {}, [
        [2, 'var unused = One', 'var unused = Two'],
      ]);
      expect(blocks123(run.issues)).toBe(true);
    });
    it('blocks when the batch adds a global the text also defines locally', () => {
      const run = save(lines('import bad from 999', 'var range = 1'), {}, [
        [2, 'var other = 1', lines('var other = 1', 'var range = 2')],
      ]);
      expect(blocks123(run.issues)).toBe(true);
    });
  });
  it('a new tooltip with empty English still blocks', () => {
    expect(
      errors(
        validateChanges(
          [{ hash: 124, base: null, next: { ...tooltip, hash: 124, text: {} } }],
          editorData(),
        ),
      ),
    ).toEqual([expect.objectContaining({ hash: 124, lang: 'en', message: noTooltipYet })]);
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
