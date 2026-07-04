"use client";

import { create } from "zustand";

export interface AuthUser {
  id: string;
  email: string;
  name: string;
}

interface AuthState {
  user: AuthUser | null;
  loading: boolean; // true until /api/auth/me resolves
  setUser: (user: AuthUser | null) => void;
  setLoading: (loading: boolean) => void;
  fetchMe: () => Promise<AuthUser | null>;
  logout: () => Promise<void>;
}

/**
 * Auth store backed by Zustand. The session cookie (chatgpt_session) is the
 * source of truth on the server side; this store just mirrors it on the client.
 *
 * Flow:
 *   1. On app mount, `fetchMe()` is called to check whether a valid session
 *      cookie exists. If so, `user` is populated and `loading` becomes false.
 *   2. On successful login/signup, the LoginScreen calls `setUser()` directly
 *      with the user object returned from the POST response — no second
 *      round-trip to /api/auth/me is needed, and the UI transitions instantly.
 *   3. On logout, the cookie is cleared server-side and `user` is set to null.
 */
export const useAuth = create<AuthState>((set) => ({
  user: null,
  loading: true,
  setUser: (user) => set({ user, loading: false }),
  setLoading: (loading) => set({ loading }),
  fetchMe: async () => {
    try {
      const res = await fetch("/api/auth/me", {
        cache: "no-store",
        credentials: "include",
      });
      if (!res.ok) {
        set({ user: null, loading: false });
        return null;
      }
      const data = (await res.json()) as { user?: AuthUser };
      const user = data.user ?? null;
      set({ user, loading: false });
      return user;
    } catch {
      // Network error — don't permanently log the user out, because the
      // server might just be briefly unreachable. Set loading=false so the
      // UI doesn't hang, but keep user as null so they see the login screen
      // and can retry.
      set({ user: null, loading: false });
      return null;
    }
  },
  logout: async () => {
    try {
      await fetch("/api/auth/logout", {
        method: "POST",
        credentials: "include",
      });
    } catch {
      // ignore network errors during logout — the cookie will eventually
      // expire on its own, and we still clear the client-side state below.
    }
    set({ user: null, loading: false });
  },
}));
