import { beforeEach, expect, it, vi } from 'vitest';
import {
  getPersonalSnippets,
  loadEditorSnippets,
  saveTeamSnippet,
  SnippetConflictError,
} from './snippets';
import { apiRequest } from './apiAuth';
vi.mock('./apiAuth', () => ({
  apiRequest: vi.fn(),
  failure: async () => {
    throw new Error('HTTP failure');
  },
}));
const call = vi.mocked(apiRequest);
beforeEach(() => { call.mockReset(); });
it('falls back to built-ins only for HTTP, network, or malformed custom data failures', async () => {
  for (const response of [
    new Response('{}', { status: 503 }),
    Response.json({ snippets: [{ snippet: {}, revision: null }] }),
  ]) {
    call.mockResolvedValue(response);
    const result = await loadEditorSnippets();
    expect(result.builtIn.length).toBeGreaterThan(0);
    expect(result.mine).toEqual([]);
    expect(result.team).toEqual([]);
  }
  call.mockRejectedValue(new Error('offline'));
  expect((await loadEditorSnippets()).mine).toEqual([]);
  await expect(getPersonalSnippets()).rejects.toThrow('offline');
});
it('preserves conflict information for management callers', async () => {
  call.mockResolvedValue(Response.json({ id: 'team:1', head: null }, { status: 409 }));
  await expect(saveTeamSnippet({ id: 'team:1', base: null, next: null })).rejects.toBeInstanceOf(
    SnippetConflictError,
  );
});
