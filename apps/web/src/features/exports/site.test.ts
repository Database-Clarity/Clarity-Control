// Notices as build-site writes them (P2): compile notices cut `message` to 300 characters and
// carry the engine's notice whole as `detail`.
import { describe, expect, it } from 'vitest';
import { isFailure, noticeSchema, noticeText } from './site';

describe('build notices', () => {
  it('reads compile notices from detail, even when the message is cut', () => {
    const hashes = Array.from({ length: 200 }, (_, n) => 1_000_000 + n);
    const detail = { kind: 'uncategorised', hashes };
    const notice = noticeSchema.parse({
      project: 'p1',
      file: 'f1',
      path: 'p1/v1/f1.json',
      kind: 'compile',
      message: JSON.stringify(detail).slice(0, 300),
      detail,
    });
    expect(noticeText(notice)).toBe('200 tooltips have no item category and are left out');
    expect(isFailure(notice)).toBe(false);
  });

  it('shows plain compile messages and other kinds as written', () => {
    const plain = noticeSchema.parse({
      project: 'p1',
      kind: 'compile',
      message: 'Categories the pinned catalog lacks: x',
    });
    expect(noticeText(plain)).toBe('Categories the pinned catalog lacks: x');
    const failed = noticeSchema.parse({
      path: 'p1/v1/f1.json',
      kind: 'build-failed',
      message: 'x',
    });
    expect(noticeText(failed)).toBe('x');
    expect(isFailure(failed)).toBe(true);
  });
});
