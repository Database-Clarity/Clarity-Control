import { afterAll, expect, it, vi } from 'vitest';
import type { MarkupGlobals } from '@clarity/core';
import type { RenderedDiffReply, RenderedDiffRequest } from './renderedDiff.worker';

const globals: MarkupGlobals = { variables: '', titles: '' };
const replies: RenderedDiffReply[] = [];
const waiters: (() => void)[] = [];
const scope = {
  onmessage: undefined as ((event: { data: RenderedDiffRequest }) => void) | undefined,
  postMessage(reply: RenderedDiffReply) {
    replies.push(reply);
    waiters.splice(0).forEach((wake) => wake());
  },
};
vi.stubGlobal('self', scope);
await import('./renderedDiff.worker');
afterAll(() => vi.unstubAllGlobals());

const send = (data: RenderedDiffRequest) => scope.onmessage!({ data });
const until = (done: () => boolean) =>
  new Promise<void>((resolve) => {
    const check = () => (done() ? resolve() : waiters.push(check));
    check();
  });
const of = (id: number) => replies.filter((reply) => reply.id === id);
// Hidden comment edits: every one is a source part the check must account for.
const comments = (count: number, word: string) =>
  Array.from({ length: count }, (_, i) => `// ${word} ${i}\nSame ${i}`).join('\n');
const covered = (reply?: RenderedDiffReply) =>
  reply?.sourceAnalysis?.markers.reduce((total, marker) => total + marker.hunks, 0);

it('posts the diff first, then a complete check of every part', async () => {
  send({ id: 1, before: comments(90, 'old'), after: comments(90, 'new'), globals });
  await until(() => of(1).length === 2);
  const [diff, check] = of(1);
  expect(diff.result?.after.length).toBeGreaterThan(0);
  expect(diff.sourceAnalysis).toBeUndefined();
  expect(covered(check)).toBe(90);
  expect(Object.keys(check.sourceAnalysis!)).toEqual(['markers']);
});

it('drops a cancelled check, running or queued, and serves the next request', async () => {
  // Long enough to need several slices, so the first call yields mid-check.
  send({ id: 2, before: comments(400, 'old'), after: comments(400, 'new'), globals });
  send({ id: 3, before: 'Queued old', after: 'Queued new', globals });
  expect(of(2).map((reply) => Object.keys(reply))).toEqual([['id', 'result']]);
  send({ cancel: 2 });
  send({ cancel: 3 });
  send({ id: 4, before: comments(5, 'old'), after: comments(5, 'new'), globals });
  await until(() => of(4).length === 2);
  expect(covered(of(4)[1])).toBe(5);
  expect(of(2)).toHaveLength(1);
  expect(of(3)).toHaveLength(0);
});
