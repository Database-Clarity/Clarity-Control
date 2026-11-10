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
  describe('a sibling change in the same batch', () => {
    const exporter = (body: string) => `export foo (\n${body}\n)`;
    const data = () => {
      const donor = { ...tooltip, hash: 124, text: { en: entry(exporter('Shared')) } };
      const user123 = { ...tooltip, text: { en: entry('import foo from 124') } };
      const state = editorData();
      state.bundle.tooltips[124] = donor;
      state.bundle.tooltips[123] = user123;
      return { state, donor, user123 };
    };
    it('that removes an import the unchanged text uses blocks the save', async () => {
      const { state, donor, user123 } = data();
      expect(errors(validateChanges([{ hash: 123, base: user123, next: user123 }], state))).toEqual(
        [],
      );
      const changes = [
        { hash: 123, base: user123, next: { ...user123, associated: [30] } },
        { hash: 124, base: donor, next: { ...donor, text: { en: entry('No export now') } } },
      ];
      expect(errors(validateChanges(changes, state))).toEqual([
        expect.objectContaining({
          hash: 123,
          lang: 'en',
          message: 'Unresolved import "foo" from 124.',
        }),
      ]);
      await expect(prepareChanges(changes, user, state)).rejects.toThrow('Validation');
    });
    it('that keeps the import working does not block', () => {
      const { state, donor, user123 } = data();
      const changes = [
        { hash: 123, base: user123, next: { ...user123, associated: [30] } },
        { hash: 124, base: donor, next: { ...donor, text: { en: entry(exporter('Changed')) } } },
      ];
      expect(errors(validateChanges(changes, state))).toEqual([]);
    });
    it('is not hidden by an older error with the same message', () => {
      const newline = String.fromCharCode(10);
      const { state, donor } = data();
      const hidden = (body: string) => entry(['export hidden foo (', body, ')'].join(newline));
      const sharing = { ...donor, text: { en: hidden('Shared') } };
      const dependent = {
        ...tooltip,
        text: { en: entry(['import bad from 999', 'import foo from 124'].join(newline)) },
      };
      state.bundle.tooltips[124] = sharing;
      state.bundle.tooltips[123] = dependent;
      const changes = [
        { hash: 123, base: dependent, next: { ...dependent, associated: [30] } },
        {
          hash: 124,
          base: sharing,
          next: { ...sharing, text: { en: hidden('import bad from 999') } },
        },
      ];
      expect(errors(validateChanges(changes, state)).map((issue) => issue.hash)).toEqual([123]);
    });
    it('is not hidden when the batch repairs one broken import and breaks another', () => {
      const newline = String.fromCharCode(10);
      const lines = (...parts: string[]) => parts.join(newline);
      const hidden = (name: string, body: string) =>
        entry(lines(`export hidden ${name} (`, body, ')'));
      const { state } = data();
      const foo = { ...tooltip, hash: 124, text: { en: hidden('foo', 'import bad from 999') } };
      const bar = { ...tooltip, hash: 125, text: { en: hidden('bar', 'Shared') } };
      const dependent = {
        ...tooltip,
        text: { en: entry(lines('import foo from 124', 'import bar from 125')) },
      };
      state.bundle.tooltips[123] = dependent;
      state.bundle.tooltips[124] = foo;
      state.bundle.tooltips[125] = bar;
      const changes = [
        { hash: 123, base: dependent, next: { ...dependent, associated: [30] } },
        { hash: 124, base: foo, next: { ...foo, text: { en: hidden('foo', 'Shared') } } },
        {
          hash: 125,
          base: bar,
          next: { ...bar, text: { en: hidden('bar', 'import bad from 999') } },
        },
      ];
      expect(errors(validateChanges(changes, state)).map((issue) => issue.hash)).toContain(123);
    });
    it('does not turn an error that already existed into a blocker', () => {
      const { state, donor } = data();
      const broken = { ...tooltip, text: { en: entry('import gone from 124') } };
      state.bundle.tooltips[123] = broken;
      const changes = [
        { hash: 123, base: broken, next: { ...broken, associated: [30] } },
        { hash: 124, base: donor, next: { ...donor, text: { en: entry('Other text') } } },
      ];
      const issues = validateChanges(changes, state);
      expect(errors(issues)).toEqual([]);
      expect(issues).toContainEqual(
        expect.objectContaining({ hash: 123, lang: 'en', severity: 'warning' }),
      );
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
