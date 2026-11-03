import { create } from 'zustand';
import { apiUrl, clearSession, getMe, type User } from '../services/api';
import { errorMessage } from '../services/http';

interface AuthState {
  user: User | null;
  loading: boolean;
  error: string | null;
  load(): Promise<void>;
  logout(): void;
}

/** Same account, same role and languages: no reason to hand out a new object (identity checks guard saves). */
export function sameUser(a: User | null, b: User | null): boolean {
  return a !== null && b !== null && JSON.stringify(a) === JSON.stringify(b);
}

let requestId = 0;
export const useAuthStore = create<AuthState>((set, get) => ({
  user: null,
  loading: Boolean(apiUrl),
  error: null,
  async load() {
    if (!apiUrl) return;
    const id = ++requestId;
    set({ loading: true, error: null });
    try {
      const user = await getMe();
      if (id === requestId)
        set({ user: sameUser(get().user, user) ? get().user : user, loading: false });
    } catch (error) {
      if (id === requestId) set({ user: null, loading: false, error: errorMessage(error) });
    }
  },
  logout() {
    try {
      clearSession();
      requestId++;
      set({ user: null, loading: false, error: null });
    } catch (error) {
      set({ error: `Cannot clear session: ${errorMessage(error)}` });
    }
  },
}));
