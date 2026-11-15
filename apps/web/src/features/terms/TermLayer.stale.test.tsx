// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { TermMatch } from './match';
import type { TermList } from './termList';

// A stable list and a worker whose replies the test releases by hand, oldest first or last.
const list: TermList = {
  id: 'de:1',
  lang: 'de',
  terms: [{ en: 'Voltshot', kind: 'name', official: ['Voltschuss'] }],
};
const replies: ((matches: TermMatch[]) => void)[] = [];
vi.mock('./useTermList', () => ({ useTermList: () => list }));
vi.mock('../editor/diagnosticWorker', () => ({
  requestTermMatches: () => new Promise<TermMatch[]>((resolve) => replies.push(resolve)),
}));
const { TermLayer } = await import('./TermLayer');

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  replies.length = 0;
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('requestAnimationFrame', (run: FrameRequestCallback) =>
    setTimeout(() => run(0), 0),
  );
  vi.stubGlobal('cancelAnimationFrame', (id: number) => clearTimeout(id));
  Range.prototype.getClientRects = function () {
    return [
      { left: 0, right: 10, top: 0, bottom: 10, width: 10, height: 10 },
    ] as unknown as DOMRectList;
  };
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

const render = (text: string) =>
  act(async () =>
    root.render(
      <TermLayer lang="de" hash={7} enabled canInsert>
        <p>{text}</p>
      </TermLayer>,
    ),
  );
const settle = () => act(async () => void (await new Promise((done) => setTimeout(done, 5))));
const marks = () => host.querySelector('[data-term-marks]')?.getAttribute('data-term-marks');

// Code review 2026-11-14: React rewrites the same Text node in place, so an older reply's offsets
// would point past shorter text (IndexSizeError) or at another word of the same length.
it.each([
  ['shorter', 'Short'],
  ['same length', 'Applies Kinetics'],
])('drops a match reply for English that changed in place (%s)', async (_case, next) => {
  await render('Applies Voltshot');
  const before = host.querySelector('p')!.firstChild;
  expect(replies).toHaveLength(1);
  await render(next);
  expect(host.querySelector('p')!.firstChild).toBe(before);
  await settle();
  expect(replies).toHaveLength(2);
  await act(async () => replies[0]!([{ from: 8, to: 16, entry: 0 }]));
  expect(marks()).toBeUndefined();
  await act(async () => replies[1]!([]));
  expect(marks()).toBe('0');
});
