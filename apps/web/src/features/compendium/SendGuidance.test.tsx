// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { SendGuidance } from './SendGuidance';
import { useAuthStore } from '../../stores/auth';
import { apiRequest } from '../../services/api';
vi.mock('../../services/api', () => ({
  apiRequest: vi.fn(),
  apiUrl: 'https://example.test',
  clearSession: vi.fn(),
}));
const documentValue = { version: 1 as const, scope: 'test', baseline: '', categories: {} };
const mocked = vi.mocked(apiRequest);
afterEach(() => {
  vi.clearAllMocks();
  useAuthStore.setState({ user: null });
  document.body.innerHTML = '';
});
it('sends current guidance after status and shows commit receipt', async () => {
  useAuthStore.setState({ user: { id: 1, login: 'alice', role: 'maintainer' } });
  mocked
    .mockResolvedValueOnce(Response.json({ revision: null, document: null }))
    .mockResolvedValueOnce(
      Response.json({ commit: 'a'.repeat(40), url: 'https://github.com/example/commit' }),
    );
  const element = document.createElement('div');
  document.body.append(element);
  const root = createRoot(element);
  await act(async () => {
    root.render(<SendGuidance document={documentValue} ready />);
  });
  await act(async () => {
    element.querySelector('button')!.click();
  });
  expect(JSON.parse(String(mocked.mock.calls[1][1]?.body))).toEqual({
    document: documentValue,
    revision: null,
  });
  expect(element.textContent).toContain('Guidance sent');
  expect(element.querySelector('a')?.href).toBe('https://github.com/example/commit');
  await act(async () => root.unmount());
});
it('offers export fallback when the backend is unavailable', async () => {
  useAuthStore.setState({ user: { id: 1, login: 'alice', role: 'maintainer' } });
  mocked.mockRejectedValueOnce(new Error('offline'));
  const element = document.createElement('div');
  document.body.append(element);
  const root = createRoot(element);
  await act(async () => {
    root.render(<SendGuidance document={documentValue} ready />);
  });
  expect(element.textContent).toContain('Export a backup');
  expect(element.querySelector('button')?.disabled).toBe(true);
  await act(async () => root.unmount());
});

it.each([true, false])(
  'distinguishes pending delivery from confirmed receipt or failure (%s)',
  async (success) => {
    useAuthStore.setState({ user: { id: 1, login: 'alice', role: 'maintainer' } });
    let finish!: (value: Response) => void;
    mocked
      .mockResolvedValueOnce(Response.json({ revision: null, document: null }))
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            finish = resolve;
          }),
      );
    const status = vi.fn();
    const element = document.createElement('div');
    document.body.append(element);
    const root = createRoot(element);
    await act(async () =>
      root.render(<SendGuidance document={documentValue} ready onStatus={status} />),
    );
    await act(async () => element.querySelector('button')!.click());
    expect(status).toHaveBeenLastCalledWith('Sending guidance…');
    expect(element.textContent).toContain('Sending guidance');
    expect(element.textContent).not.toContain('Guidance sent');
    expect(element.querySelector('a')).toBeNull();
    expect(element.querySelector('button')!.disabled).toBe(true);
    await act(async () =>
      finish(
        success
          ? Response.json({ commit: 'a'.repeat(40), url: 'https://github.com/example/commit' })
          : new Response('<html>private failure</html>', { status: 503 }),
      ),
    );
    expect(status).toHaveBeenLastCalledWith(
      success ? 'Guidance sent to agents' : 'Guidance delivery needs attention',
    );
    expect(element.textContent).toContain(success ? 'Guidance sent' : 'Send failed');
    if (!success) {
      expect(element.querySelector('[role="alert"]')).not.toBeNull();
      expect(element.textContent).toContain('Export a backup');
      expect(element.textContent).not.toContain('private failure');
      expect(element.querySelector('a')).toBeNull();
    }
    await act(async () => root.unmount());
  },
);
