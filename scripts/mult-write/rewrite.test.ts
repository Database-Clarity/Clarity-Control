import { describe, expect, test } from 'vitest';
import { blobContent, planRewrite, type Row } from './rewrite';

const stamp = { at: '2026-11-11T22:42:23.000Z', by: 'StardustD2' };
const text =
  'Grants the following:\n• 40 Reload Speed\n• 0.95x Reload Duration Multiplier\n• 0.9x Draw Time Multiplier';
const tooltip = (hash: number, body = text, extra: Record<string, unknown> = {}) => ({
  associated: [],
  hash,
  legacy: { inLiveDatabase: true, lastUpload: 1, uploadToLive: false, uploadedBy: 'Stardust' },
  text: { en: { text: body, updatedAt: '2024-06-04T19:01:39.281Z', updatedBy: 'Stardust' } },
  ...extra,
});
const files = (entries: Record<string, unknown>) => {
  const bytes: Record<string, string> = {};
  for (const [path, value] of Object.entries(entries)) bytes[path] = blobContent(value);
  return (path: string) => bytes[path];
};
const row = (line: number, before: string, after: string, hash = 220689851): Row => ({
  id: `${hash}:${line}`,
  authoredFile: `tooltips/${hash}.json`,
  sourceLine: line,
  before,
  after,
});
const reload = row(
  3,
  '• 0.95x Reload Duration Multiplier',
  '• 5% decreased Reload Animation Duration',
);
const draw = row(4, '• 0.9x Draw Time Multiplier', '• 10% decreased Draw Time');

describe('planRewrite', () => {
  test('replaces exactly the listed lines and stamps only the English save metadata', () => {
    const read = files({ 'tooltips/220689851.json': tooltip(220689851) });
    const plan = planRewrite([reload, draw], read, stamp);
    expect(plan.dropped).toEqual([]);
    expect(plan.changes).toHaveLength(1);
    const [change] = plan.changes;
    const after = JSON.parse(change!.after);
    expect(after).toEqual({
      ...tooltip(220689851),
      text: {
        en: {
          text: 'Grants the following:\n• 40 Reload Speed\n• 5% decreased Reload Animation Duration\n• 10% decreased Draw Time',
          updatedAt: stamp.at,
          updatedBy: stamp.by,
        },
      },
    });
    // Stored key order and layout are kept: only the three English JSON lines differ.
    expect(Object.keys(after)).toEqual(['associated', 'hash', 'legacy', 'text']);
    expect(change!.jsonLines).toHaveLength(3);
    expect(change!.lines).toEqual([3, 4]);
    expect(change!.fields).toEqual(['text.en.text', 'text.en.updatedAt', 'text.en.updatedBy']);
  });

  test('drops a drifted row, keeps its siblings, and never guesses', () => {
    const drifted = text.replace('0.9x Draw Time Multiplier', '0.85x Draw Time Multiplier');
    const read = files({ 'tooltips/220689851.json': tooltip(220689851, drifted) });
    const plan = planRewrite([reload, draw], read, stamp);
    expect(plan.dropped).toEqual([
      {
        id: draw.id,
        authoredFile: draw.authoredFile,
        sourceLine: 4,
        reason: 'line differs',
        found: '• 0.85x Draw Time Multiplier',
      },
    ]);
    expect(plan.changes[0]!.lines).toEqual([3]);
    expect(JSON.parse(plan.changes[0]!.after).text.en.text).toContain(
      '• 0.85x Draw Time Multiplier',
    );
  });

  test('a moved line drifts even when its text still exists elsewhere', () => {
    const moved = text.split('\n');
    moved.splice(2, 0, 'New line');
    const read = files({ 'tooltips/220689851.json': tooltip(220689851, moved.join('\n')) });
    const plan = planRewrite([reload], read, stamp);
    expect(plan.changes).toEqual([]);
    expect(plan.dropped.map((entry) => entry.reason)).toEqual(['line differs']);
  });

  test('missing files and lines are dropped', () => {
    const read = files({ 'tooltips/220689851.json': tooltip(220689851, 'One line') });
    const plan = planRewrite([reload, row(1, 'x', 'y', 5)], read, stamp);
    expect(plan.dropped.map((entry) => entry.reason).sort()).toEqual([
      'file missing',
      'line missing',
    ]);
  });

  test('refuses non-canonical bytes, translations, extra English fields, and reserved tooltips', () => {
    const path = 'tooltips/220689851.json';
    const crlf = (p: string) =>
      p === path ? blobContent(tooltip(220689851)).replace(/\n/g, '\r\n') : undefined;
    expect(() => planRewrite([reload], crlf, stamp)).toThrow(/not canonical/);
    const french = tooltip(220689851);
    (french.text as Record<string, unknown>).fr = {
      text: 'x',
      updatedAt: stamp.at,
      updatedBy: 'a',
    };
    expect(() => planRewrite([reload], files({ [path]: french }), stamp)).toThrow(/languages/);
    const extra = tooltip(220689851);
    (extra.text.en as Record<string, unknown>).note = 1;
    expect(() => planRewrite([reload], files({ [path]: extra }), stamp)).toThrow();
    expect(() => planRewrite([row(1, 'a', 'b', 2)], files({}), stamp)).toThrow(/reserved/);
  });

  test('refuses malformed rows and stamps', () => {
    const read = files({ 'tooltips/220689851.json': tooltip(220689851) });
    expect(() => planRewrite([reload, reload], read, stamp)).toThrow(/duplicate/);
    expect(() => planRewrite([{ ...reload, after: reload.before }], read, stamp)).toThrow(
      /no change/,
    );
    expect(() => planRewrite([{ ...reload, after: 'a\nb' }], read, stamp)).toThrow(
      /one non-empty line/,
    );
    expect(() => planRewrite([{ ...reload, id: '1:3' }], read, stamp)).toThrow(/id mismatch/);
    expect(() => planRewrite([{ ...reload, extra: 1 } as Row], read, stamp)).toThrow(
      /unexpected fields/,
    );
    expect(() => planRewrite([reload], read, { ...stamp, at: '2026-11-11' })).toThrow(/--at/);
    expect(() => planRewrite([], read, stamp)).toThrow(/No rows/);
  });

  test('refuses an edit that changes parser diagnostics', () => {
    const read = files({ 'tooltips/220689851.json': tooltip(220689851) });
    const broken = { ...reload, after: '• 5% decreased <link Reload Animation Duration' };
    expect(() => planRewrite([broken], read, stamp)).toThrow(/diagnostics|validation/);
  });

  test('keeps a tooltip whose metadata already matches the stamp author', () => {
    const own = tooltip(220689851);
    own.text.en.updatedBy = 'StardustD2';
    const plan = planRewrite([reload], files({ 'tooltips/220689851.json': own }), stamp);
    expect(plan.changes[0]!.fields).toEqual(['text.en.text', 'text.en.updatedAt']);
    expect(plan.changes[0]!.jsonLines).toHaveLength(2);
  });
});
