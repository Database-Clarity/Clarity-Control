import { expect, it } from 'vitest';
import { displayMatches } from './displayMatches';
import { matchingInputs } from './matchingInputs';
import { guidedFixture } from '../../../test/guided-fixture';
import { emptyProgress } from './reviewProgress';
import approved from './approved-guidance.v1.json';
import { guidanceSchema } from './guidanceSchema';

it('ships the pinned approval snapshot with all 118 references, independently of browser storage', () => {
  const input = guidanceSchema.parse(approved);
  expect(
    Object.values(input.categories).reduce((n, c) => n + Object.keys(c.references ?? {}).length, 0),
  ).toBe(118);
});
it('displays current high links, withholds uncertain links, and never mutates inputs', () => {
  const f = guidedFixture();
  const before = JSON.stringify([f.editor, f.source, f.document]);
  const result = displayMatches(
    f.editor,
    f.source,
    {},
    emptyProgress(),
    undefined,
    f.scope,
    f.proposals,
    f.document,
  );
  expect(result.matches.get(100)?.row.name).toBe('Sample 100');
  for (const [hash] of result.matches) {
    const d = result.decisions.find((d) => d.hash === hash)!;
    expect(d.action).toBe('link');
    expect(['high', 'out-of-scope']).toContain(d.confidence);
  }
  expect(JSON.stringify([f.editor, f.source, f.document])).toBe(before);
});
it('preserves local unresolved references and saved/draft precedence', () => {
  const f = guidedFixture();
  const local = structuredClone(f.document);
  const record = local.categories[f.categories[0].id].references![100];
  delete record.link;
  record.decision = 'skipped';
  const result = displayMatches(
    f.editor,
    f.source,
    {},
    emptyProgress(),
    local,
    f.scope,
    f.proposals,
    f.document,
  );
  expect(result.matches.has(100)).toBe(false);
  const base = f.categories[0].entries.find((e) => e.hash === 100)!.base;
  const drafts = { 100: { base, next: { ...base, compendium: f.proposals.get(100)!.link! } } };
  expect(
    displayMatches(
      f.editor,
      f.source,
      drafts,
      emptyProgress(),
      undefined,
      f.scope,
      f.proposals,
      f.document,
    ).matches.has(100),
  ).toBe(false);
});

it('reuses unchanged content after transport/commit metadata changes without bypassing local baseline gates', () => {
  const f = guidedFixture();
  const editor = {
    ...f.editor,
    bundle: { ...f.editor.bundle, sourceCommit: 'new-commit', generatedAt: '2026-11-04T00:00:00Z' },
  };
  const source = { ...f.source, fetchedAt: '2026-11-04T00:00:00Z' };
  expect(matchingInputs(editor, source)).toEqual(matchingInputs(f.editor, f.source));
  const before = displayMatches(
    f.editor,
    f.source,
    {},
    emptyProgress(),
    undefined,
    f.scope,
    f.proposals,
    f.document,
  );
  const after = displayMatches(
    editor,
    source,
    {},
    emptyProgress(),
    undefined,
    f.scope,
    f.proposals,
    f.document,
  );
  expect([...after.matches.keys()]).toEqual([...before.matches.keys()]);
  expect(after.decisions.map((d) => [d.hash, d.confidence, d.action, d.ruleId])).toEqual(
    before.decisions.map((d) => [d.hash, d.confidence, d.action, d.ruleId]),
  );
  const local = displayMatches(
    editor,
    source,
    {},
    emptyProgress(),
    f.document,
    f.scope,
    f.proposals,
    f.document,
  );
  expect(local.matches.has(100)).toBe(false);
  const changed = structuredClone(editor);
  changed.items[100].name += ' changed';
  expect(matchingInputs(changed, source)).not.toEqual(matchingInputs(editor, source));
});
