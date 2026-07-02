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
      // ignore network errors during logout
    }
    set({ user: null, loading: false });
  },
}));
