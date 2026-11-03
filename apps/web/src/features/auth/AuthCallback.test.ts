import { describe, expect, it, vi } from 'vitest';
import { completeCallback } from './AuthCallback';

function dependencies(overrides: { setSession?: (token: string) => void; pending?: boolean } = {}) {
  return {
    consumePendingSignIn: vi.fn(() => overrides.pending ?? true),
    setSession: vi.fn(overrides.setSession ?? (() => undefined)),
    takeReturnPath: vi.fn(() => '/t/12345?lang=de'),
  };
}

describe('completeCallback', () => {
  it('stores the session and returns to the remembered route', () => {
    const deps = dependencies();
    const outcome = completeCallback(new URLSearchParams('session=token'), deps);
    expect(deps.setSession).toHaveBeenCalledWith('token');
    expect(outcome).toEqual({ kind: 'signed-in', to: '/t/12345?lang=de' });
    expect(JSON.stringify(outcome)).not.toContain('token');
  });
  it('keeps the error behaviour and leaves the remembered route alone', () => {
    const deps = dependencies();
    expect(completeCallback(new URLSearchParams('error=denied'), deps)).toEqual({
      kind: 'error',
      message: 'denied',
    });
    expect(completeCallback(new URLSearchParams(''), deps)).toMatchObject({ kind: 'error' });
    expect(deps.setSession).not.toHaveBeenCalled();
    expect(deps.takeReturnPath).not.toHaveBeenCalled();
  });
  it('reports a storage failure without consuming the remembered route', () => {
    const deps = dependencies({
      setSession: () => {
        throw new Error('quota');
      },
    });
    const outcome = completeCallback(new URLSearchParams('session=token'), deps);
    expect(outcome).toMatchObject({ kind: 'error' });
    expect(deps.takeReturnPath).not.toHaveBeenCalled();
  });
  it('ignores a forged callback link that this browser did not start', () => {
    const deps = dependencies({ pending: false });
    const outcome = completeCallback(new URLSearchParams('session=attacker-token'), deps);
    expect(outcome).toMatchObject({ kind: 'error' });
    expect(deps.setSession).not.toHaveBeenCalled();
    expect(deps.takeReturnPath).not.toHaveBeenCalled();
  });
});
