import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  getAccountPublishes: vi.fn(),
  getPublishOutcome: vi.fn(),
  acknowledgePublish: vi.fn(async () => undefined),
}));
const session = vi.hoisted(() => ({ token: 'token-a' as string | null }));
vi.mock('../../services/publisher/api', () => api);
vi.mock('../../services/publisher/flag', () => ({ publisherEnabled: () => true }));
vi.mock('../../services/api', () => ({ apiUrl: 'https://api.invalid' }));
vi.mock('../../services/session', () => ({ sessionToken: () => session.token }));

const { useAuthStore } = await import('../../stores/auth');
const { attentionTarget, attentionText, usePublishAttention } = await import('./publishAttention');

const entry = (opId: string, held = 1) => ({
  opId,
  createdAt: '2026-11-26T12:00:00.000Z',
  rows: 7,
  globals: 0,
  status: 'done' as const,
  held,
});
const signIn = (id: number, token: string, role = 'editor') => {
  session.token = token;
  useAuthStore.setState({
    user: { id, login: `user${id}`, role } as never,
    token,
    loading: false,
  });
};

beforeEach(() => {
  usePublishAttention.setState({ key: null, entries: [], readAt: 0 });
  api.getPublishOutcome.mockResolvedValue({
    held: [{ hash: 10, reason: 'Saved text changed after review.' }],
    globals: [],
  });
});
afterEach(() => vi.clearAllMocks());

it('names what an editor publish held, and points Review at the first held row', async () => {
  signIn(1, 'token-a');
  api.getAccountPublishes.mockResolvedValue({ entries: [entry('A')], acknowledged: [] });
  await usePublishAttention.getState().load();
  const { entries } = usePublishAttention.getState();
  expect(attentionText(entries)).toBe(
    'Publish needs attention: 1 of 7 changes were held back. Not published: Tooltip 10 (Saved text changed after review). The rest is live.',
  );
  expect(attentionTarget(entries)).toBe('/review?hash=10');
});

it('keeps counts only for an account without publish rights', async () => {
  signIn(1, 'token-a', 'trial');
  api.getAccountPublishes.mockResolvedValue({ entries: [entry('A')], acknowledged: [] });
  await usePublishAttention.getState().load();
  expect(api.getPublishOutcome).not.toHaveBeenCalled();
  expect(attentionText(usePublishAttention.getState().entries)).toBe(
    'Publish needs attention: 1 of 7 changes were held back. The rest is live.',
  );
});

it('never shows an answer read for another account or while the sign-in changes', async () => {
  signIn(1, 'token-a');
  let answer!: (value: unknown) => void;
  api.getAccountPublishes.mockReturnValue(new Promise((resolve) => (answer = resolve)));
  const read = usePublishAttention.getState().load();
  // Account B signs in while A's read is in flight: A's answer is dropped.
  signIn(2, 'token-b');
  answer({ entries: [entry('A')], acknowledged: [] });
  await read;
  expect(usePublishAttention.getState().entries).toEqual([]);
  // While the next sign-in loads, nothing is read or shown.
  useAuthStore.setState({ loading: true });
  usePublishAttention.setState({ entries: [entry('B')] });
  await usePublishAttention.getState().load();
  expect(usePublishAttention.getState().entries).toEqual([]);
  expect(api.getAccountPublishes).toHaveBeenCalledTimes(1);
});

it('drops editor details that arrive after the same account lost its role', async () => {
  signIn(1, 'token-a');
  let answer!: (value: unknown) => void;
  api.getAccountPublishes.mockResolvedValue({ entries: [entry('A')], acknowledged: [] });
  api.getPublishOutcome.mockReturnValue(new Promise((resolve) => (answer = resolve)));
  const editorRead = usePublishAttention.getState().load();
  await vi.waitFor(() => expect(api.getPublishOutcome).toHaveBeenCalledWith('A'));
  useAuthStore.setState({ loading: true });
  await usePublishAttention.getState().load();
  signIn(1, 'token-a', 'trial');
  await usePublishAttention.getState().load();
  answer({ held: [{ hash: 10, reason: 'Saved text changed after review.' }], globals: [] });
  await editorRead;
  expect(usePublishAttention.getState().entries[0]?.notLive).toBeUndefined();
  expect(attentionText(usePublishAttention.getState().entries)).not.toContain('Tooltip 10');
});

it('acknowledges what it showed when dismissed, and hides acknowledged publishes', async () => {
  signIn(1, 'token-a');
  api.getAccountPublishes.mockResolvedValue({
    entries: [entry('A'), entry('B'), entry('C', 0)],
    acknowledged: ['B'],
  });
  await usePublishAttention.getState().load();
  expect(usePublishAttention.getState().entries.map(({ opId }) => opId)).toEqual(['A']);
  usePublishAttention.getState().dismiss();
  expect(api.acknowledgePublish).toHaveBeenCalledWith('A');
  expect(usePublishAttention.getState().entries).toEqual([]);
});
