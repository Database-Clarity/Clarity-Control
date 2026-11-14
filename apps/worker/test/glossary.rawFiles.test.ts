import { afterEach, expect, it, vi } from 'vitest';
import { GitHub } from '../src/github.js';
import { Fixture, makePrivateKey } from './fixture.js';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
it('preserves existing object commit bytes while optional raw files are committed as-is', async () => {
  const fixture = new Fixture(await makePrivateKey());
  const github = new GitHub(fixture.env);
  const result = vi.spyOn(github, 'result');
  const raw = '{ "v": 1, "terms": {} }\r\n';
  await github.commit(
    fixture.dataHead,
    { 'object.json': { value: 'unchanged', nested: { n: 2 } } },
    'Test content',
    { id: 1, login: 'alice' },
    { rawFiles: { 'raw.json': raw } },
  );
  const tree = result.mock.calls.find(([path]) => path === '/git/trees')?.[2] as {
    tree: { path: string; content: string }[];
  };
  expect(tree.tree.map(({ path, content }) => ({ path, content }))).toEqual([
    {
      path: 'object.json',
      content: '{\n  "value": "unchanged",\n  "nested": {\n    "n": 2\n  }\n}\n',
    },
    { path: 'raw.json', content: raw },
  ]);
  const ordinary = await github.file('object.json', fixture.dataHead);
  expect(ordinary).toEqual({
    sha: expect.any(String),
    value: { value: 'unchanged', nested: { n: 2 } },
  });
  const sized = await github.file('object.json', fixture.dataHead, true);
  expect(sized).toEqual({
    ...ordinary,
    // Fixture serves compact JSON on reads, independently of the tree's pretty commit bytes.
    size: 38,
  });
});
