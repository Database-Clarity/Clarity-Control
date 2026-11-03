import { create } from 'zustand';
import { apiUrl, clearSession, getMe, type User } from '../services/api';
import { errorMessage } from '../services/http';
import { sessionToken } from '../services/session';

interface AuthState {
  user: User | null;
  /** The session token `user` was loaded with; a save must still be using it. */
  token: string | null;
  loading: boolean;
  error: string | null;
  load(): Promise<void>;
  logout(): void;
}

/** Same account, same role and languages: no reason to hand out a new object (identity checks guard saves). */
export function sameUser(a: User | null, b: User | null): boolean {
  return a !== null && b !== null && JSON.stringify(a) === JSON.stringify(b);
}

function readToken(): string | null {
  try {
    return sessionToken();
  } catch {
    return null;
  }
}

let requestId = 0;
export const useAuthStore = create<AuthState>((set, get) => ({
  user: null,
  token: null,
  loading: Boolean(apiUrl),
  error: null,
  async load() {
    if (!apiUrl) return;
    const id = ++requestId;
    set({ loading: true, error: null });
    const token = readToken();
    try {
      const user = await getMe();
      if (id === requestId)
        set({
          user: sameUser(get().user, user) ? get().user : user,
          token: user ? token : null,
          loading: false,
        });
    } catch (error) {
      if (id === requestId)
        set({ user: null, token: null, loading: false, error: errorMessage(error) });
    }
  },
  logout() {
    try {
      clearSession();
      requestId++;
      set({ user: null, token: null, loading: false, error: null });
    } catch (error) {
      set({ error: `Cannot clear session: ${errorMessage(error)}` });
    }
  },
}));
