// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { TermForm } from './TermForm';
import { saveGlossary } from '../../stores/glossary';
vi.mock('../../stores/glossary', async (original) => ({
  ...(await original<typeof import('../../stores/glossary')>()),
  saveGlossary: vi.fn(),
}));

it('never retries earlier values after the current form fails validation', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.mocked(saveGlossary).mockRejectedValue(new Error('Offline'));
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  try {
    act(() =>
      root.render(
        <TermForm
          lang="de"
          entry={{
            en: 'Jolt',
            term: 'Original term',
            updatedAt: '2026-11-14T00:00:00Z',
            updatedBy: 'alice',
          }}
          onClose={() => {}}
        />,
      ),
    );
    const submit = async () =>
      act(async () => {
        host
          .querySelector('form')!
          .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      });
    await submit();
    expect(saveGlossary).toHaveBeenCalledTimes(1);
    const input = host.querySelectorAll('input')[1];
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '   ');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await submit();
    await submit();
    expect(input.value).toBe('   ');
    expect(saveGlossary).toHaveBeenCalledTimes(1);
  } finally {
    act(() => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
    vi.resetAllMocks();
  }
});
