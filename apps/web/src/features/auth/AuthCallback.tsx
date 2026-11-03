import { useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { consumePendingSignIn, setSession } from '../../services/api';
import { errorMessage } from '../../services/http';
import { takeReturnPath } from '../../services/returnPath';
import { useAuthStore } from '../../stores/auth';

export type CallbackOutcome =
  { kind: 'error'; message: string } | { kind: 'signed-in'; to: string };

/** Store the session from the callback query and choose where to send the user next. */
export function completeCallback(
  parameters: URLSearchParams,
  dependencies: {
    setSession: (token: string) => void;
    takeReturnPath: () => string;
    consumePendingSignIn: () => boolean;
  } = { setSession, takeReturnPath, consumePendingSignIn },
): CallbackOutcome {
  // Login CSRF guard: only a sign-in this tab started may deliver a session. Rejected callbacks
  // never touch existing sessions or the remembered route.
  if (!dependencies.consumePendingSignIn())
    return {
      kind: 'error',
      message: 'Sign-in was not started in this tab, so the login link was ignored. Sign in again.',
    };
  const session = parameters.get('session');
  if (!session)
    return {
      kind: 'error',
      message: parameters.get('error') ?? 'Login callback contains no session. Sign in again.',
    };
  try {
    dependencies.setSession(session);
  } catch (reason) {
    return { kind: 'error', message: `Cannot retain login session: ${errorMessage(reason)}` };
  }
  return { kind: 'signed-in', to: dependencies.takeReturnPath() };
}

export function AuthCallback() {
  const { search } = useLocation();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const load = useAuthStore((state) => state.load);
  const consumed = useRef(false);
  useEffect(() => {
    if (consumed.current) return;
    consumed.current = true;
    const parameters = new URLSearchParams(search);
    // Remove the token from the visible URL and browser history before rendering data.
    navigate('/auth/callback', { replace: true });
    const outcome = completeCallback(parameters);
    if (outcome.kind === 'error') {
      setError(outcome.message);
      return;
    }
    void load();
    navigate(outcome.to, { replace: true });
  }, [search, navigate, load]);
  return error ? (
    <p role="alert">
      {error} <Link to="/">Return to editor</Link>
    </p>
  ) : (
    <p role="status">Completing GitHub login...</p>
  );
}
