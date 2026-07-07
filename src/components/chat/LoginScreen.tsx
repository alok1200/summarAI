"use client";

import { useState, FormEvent, useRef, useEffect, Suspense } from "react";
import {
  Sparkles,
  Loader2,
  Mail,
  Lock,
  User as UserIcon,
  Eye,
  EyeOff,
} from "lucide-react";
import { useSearchParams } from "next/navigation";
import { useAuth, type AuthUser } from "@/store/auth";
import { cn } from "@/lib/utils";

type Mode = "login" | "signup";

/**
 * Inner component that uses useSearchParams. Must be wrapped in <Suspense>
 * because useSearchParams forces dynamic rendering — Next.js requires the
 * Suspense boundary so the static shell can prerender.
 */
function LoginScreenInner() {
  const searchParams = useSearchParams();

  // Fine-grained selectors so this component only re-renders when the
  // actions themselves change (which is never, after first mount).
  const setUser = useAuth((s) => s.setUser);
  const setLoading = useAuth((s) => s.setLoading);

  const [mode, setMode] = useState<Mode>("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [showPwd, setShowPwd] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Each submit attempt gets a unique id. If the user clicks again while a
  // previous request is in flight, the older response is ignored so it
  // can't clobber newer state.
  const reqIdRef = useRef(0);

  // Display the auth_error query param if present (kept for backward
  // compatibility with any lingering Google OAuth callback redirects —
  // the Google button itself is no longer rendered).
  useEffect(() => {
    const authError = searchParams.get("auth_error");
    if (authError) {
      setError(authError);
      try {
        window.history.replaceState(
          {},
          "",
          window.location.pathname + window.location.hash
        );
      } catch {
        // ignore
      }
    }
  }, [searchParams]);

  // Check whether the "Continue with Email" (passwordless) flow is enabled
  // on this server. We fetch /api/auth/email-direct/enabled once on mount.
  // If disabled (or fetch fails), we just don't show the button — silent
  // degradation is better than a broken CTA.
  const [emailDirectEnabled, setEmailDirectEnabled] = useState(false);
  useEffect(() => {
    let cancelled = false;
    fetch("/api/auth/email-direct/enabled", { cache: "no-store" })
      .then((r) => r.json())
      .then((data: { enabled?: boolean }) => {
        if (!cancelled && data?.enabled) setEmailDirectEnabled(true);
      })
      .catch(() => {
        // Network error / endpoint missing — leave disabled.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    setError(null);
    setSubmitting(true);

    const reqId = ++reqIdRef.current;

    try {
      const endpoint = mode === "login" ? "/api/auth/login" : "/api/auth/signup";
      const payload =
        mode === "login"
          ? { email: email.trim(), password }
          : { email: email.trim(), password, name: name.trim() };

      let res: Response;
      try {
        res = await fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
          credentials: "include",
        });
      } catch {
        if (reqId !== reqIdRef.current) return;
        setError(
          "Network error — couldn't reach the server. Check your connection and try again."
        );
        return;
      }

      let data: { user?: AuthUser; error?: string } = {};
      try {
        data = await res.json();
      } catch {
        data = {};
      }

      if (reqId !== reqIdRef.current) return;

      if (!res.ok || !data.user) {
        setError(
          data?.error || `Request failed (${res.status}). Please try again.`
        );
        return;
      }

      // Login/signup succeeded. The server set the session cookie AND
      // returned the user object. Set it in the store directly so the
      // parent <Home/> component re-renders and unmounts this login
      // screen immediately.
      setUser(data.user);
      setLoading(false);
    } finally {
      if (reqId === reqIdRef.current) {
        setSubmitting(false);
      }
    }
  };

  /**
   * "Continue with Email" — passwordless one-click login/signup.
   * User just types their email (and a name on signup); we look up or
   * create the account and issue a session. No password required.
   *
   * This is convenient for prototypes / personal use. The backend route
   * only runs when ENABLE_EMAIL_DIRECT=true; otherwise this button stays
   * hidden (we check /api/auth/email-direct/enabled on mount).
   */
  const handleEmailDirect = async () => {
    if (submitting) return;
    setError(null);

    const trimmed = email.trim();
    if (!trimmed) {
      setError("Please enter your email address above first.");
      return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
      setError("Please enter a valid email address.");
      return;
    }

    setSubmitting(true);
    const reqId = ++reqIdRef.current;

    try {
      let res: Response;
      try {
        res = await fetch("/api/auth/email-direct", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            email: trimmed,
            name: mode === "signup" ? name.trim() : undefined,
          }),
          credentials: "include",
        });
      } catch {
        if (reqId !== reqIdRef.current) return;
        setError(
          "Network error — couldn't reach the server. Check your connection and try again."
        );
        return;
      }

      let data: { user?: AuthUser; error?: string } = {};
      try {
        data = await res.json();
      } catch {
        data = {};
      }

      if (reqId !== reqIdRef.current) return;

      if (!res.ok || !data.user) {
        setError(
          data?.error || `Request failed (${res.status}). Please try again.`
        );
        return;
      }

      // Success — same flow as email/password login.
      setUser(data.user);
      setLoading(false);
    } finally {
      if (reqId === reqIdRef.current) {
        setSubmitting(false);
      }
    }
  };

  const switchMode = (m: Mode) => {
    if (submitting) return;
    setMode(m);
    setError(null);
  };

  return (
    <div className="flex min-h-screen w-full items-center justify-center bg-gradient-to-br from-zinc-50 via-indigo-50/30 to-violet-50/30 dark:from-zinc-950 dark:via-indigo-950/20 dark:to-violet-950/20 px-4 py-8">
      <div className="w-full max-w-md">
        {/* Logo / brand header */}
        <div className="mb-8 text-center">
          <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-gradient-to-br from-indigo-500 via-violet-500 to-purple-600 text-white shadow-lg shadow-indigo-500/30 ring-1 ring-white/20">
            <Sparkles className="h-8 w-8" />
          </div>
          <div className="mb-1 text-2xl font-semibold tracking-tight text-zinc-800 dark:text-zinc-100">
            Summar<span className="text-indigo-500">AI</span>
          </div>
          <h1 className="text-lg font-semibold text-zinc-700 dark:text-zinc-200">
            {mode === "login" ? "Welcome back" : "Create your account"}
          </h1>
          <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
            {mode === "login"
              ? "Sign in to continue to your chats"
              : "Sign up to start chatting with AI"}
          </p>
        </div>

        {/* Card */}
        <div className="rounded-2xl border border-zinc-200/70 dark:border-zinc-800 bg-white/90 dark:bg-zinc-900/70 backdrop-blur-md p-6 shadow-xl shadow-zinc-900/5 dark:shadow-black/20 transition-shadow hover:shadow-2xl">
          {/* Mode tabs */}
          <div className="mb-5 flex rounded-xl bg-zinc-100/80 dark:bg-zinc-800/80 p-1">
            <button
              type="button"
              onClick={() => switchMode("login")}
              className={cn(
                "flex-1 rounded-lg py-2 text-sm font-medium transition-all",
                mode === "login"
                  ? "bg-white dark:bg-zinc-950 text-zinc-900 dark:text-white shadow-sm"
                  : "text-zinc-500 dark:text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-300"
              )}
            >
              Sign in
            </button>
            <button
              type="button"
              onClick={() => switchMode("signup")}
              className={cn(
                "flex-1 rounded-lg py-2 text-sm font-medium transition-all",
                mode === "signup"
                  ? "bg-white dark:bg-zinc-950 text-zinc-900 dark:text-white shadow-sm"
                  : "text-zinc-500 dark:text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-300"
              )}
            >
              Sign up
            </button>
          </div>

          {/* Continue with Email (passwordless) — only shown when enabled on server */}
          {emailDirectEnabled && (
            <button
              type="button"
              onClick={handleEmailDirect}
              disabled={submitting || !email.trim()}
              className="flex w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-br from-indigo-500 to-violet-600 py-2.5 text-sm font-medium text-white shadow-md shadow-indigo-500/25 hover:from-indigo-600 hover:to-violet-700 transition-all disabled:opacity-60 disabled:cursor-not-allowed active:scale-[0.99]"
              title="Log in or sign up using just your email address — no password required."
            >
              <Mail className="h-4 w-4" />
              {mode === "login"
                ? "Continue with Email"
                : "Sign up with Email"}
            </button>
          )}

          {/* Divider */}
          <div className="my-5 flex items-center gap-3">
            <div className="h-px flex-1 bg-zinc-200 dark:bg-zinc-800" />
            <span className="text-xs text-zinc-400 dark:text-zinc-500">
              or use a password
            </span>
            <div className="h-px flex-1 bg-zinc-200 dark:bg-zinc-800" />
          </div>

          <form onSubmit={handleSubmit} className="space-y-4">
            {mode === "signup" && (
              <div className="space-y-1.5">
                <label
                  htmlFor="name"
                  className="text-xs font-medium text-zinc-700 dark:text-zinc-300"
                >
                  Name
                </label>
                <div className="relative">
                  <UserIcon className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400" />
                  <input
                    id="name"
                    name="name"
                    type="text"
                    autoComplete="name"
                    placeholder="Your name"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    required
                    className="w-full rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-950 py-2.5 pl-9 pr-3 text-sm text-zinc-900 dark:text-zinc-100 placeholder:text-zinc-400 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 transition-shadow"
                  />
                </div>
              </div>
            )}

            <div className="space-y-1.5">
              <label
                htmlFor="email"
                className="text-xs font-medium text-zinc-700 dark:text-zinc-300"
              >
                Email
              </label>
              <div className="relative">
                <Mail className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400" />
                <input
                  id="email"
                  name="email"
                  type="email"
                  autoComplete="email"
                  placeholder="you@example.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                  className="w-full rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-950 py-2.5 pl-9 pr-3 text-sm text-zinc-900 dark:text-zinc-100 placeholder:text-zinc-400 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 transition-shadow"
                />
              </div>
            </div>

            <div className="space-y-1.5">
              <label
                htmlFor="password"
                className="text-xs font-medium text-zinc-700 dark:text-zinc-300"
              >
                Password
              </label>
              <div className="relative">
                <Lock className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400" />
                <input
                  id="password"
                  name="password"
                  type={showPwd ? "text" : "password"}
                  autoComplete={
                    mode === "login" ? "current-password" : "new-password"
                  }
                  placeholder={
                    mode === "login" ? "Your password" : "At least 6 characters"
                  }
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  minLength={mode === "signup" ? 6 : undefined}
                  className="w-full rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-950 py-2.5 pl-9 pr-9 text-sm text-zinc-900 dark:text-zinc-100 placeholder:text-zinc-400 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 transition-shadow"
                />
                <button
                  type="button"
                  onClick={() => setShowPwd((s) => !s)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300"
                  tabIndex={-1}
                  aria-label={showPwd ? "Hide password" : "Show password"}
                >
                  {showPwd ? (
                    <EyeOff className="h-4 w-4" />
                  ) : (
                    <Eye className="h-4 w-4" />
                  )}
                </button>
              </div>
            </div>

            {error && (
              <div className="rounded-xl border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950/40 px-3 py-2 text-xs text-red-700 dark:text-red-300">
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={submitting}
              className="flex w-full items-center justify-center gap-2 rounded-xl bg-zinc-900 dark:bg-zinc-100 py-2.5 text-sm font-medium text-white dark:text-zinc-900 hover:opacity-90 transition-opacity disabled:opacity-60 disabled:cursor-not-allowed shadow-md active:scale-[0.99]"
            >
              {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
              {mode === "login" ? "Sign in" : "Create account"}
            </button>
          </form>

          <p className="mt-4 text-center text-xs text-zinc-500 dark:text-zinc-400">
            {mode === "login" ? (
              <>
                Don&apos;t have an account?{" "}
                <button
                  type="button"
                  onClick={() => switchMode("signup")}
                  className="font-medium text-indigo-600 dark:text-indigo-400 hover:underline"
                >
                  Sign up
                </button>
              </>
            ) : (
              <>
                Already have an account?{" "}
                <button
                  type="button"
                  onClick={() => switchMode("login")}
                  className="font-medium text-indigo-600 dark:text-indigo-400 hover:underline"
                >
                  Sign in
                </button>
              </>
            )}
          </p>
        </div>

        <p className="mt-6 text-center text-[11px] text-zinc-400 dark:text-zinc-500">
          By continuing you agree to our Terms of Service and Privacy Policy.
        </p>
      </div>
    </div>
  );
}

/**
 * Public wrapper. <Suspense> is required by Next.js because the inner
 * component uses useSearchParams (which forces dynamic rendering).
 * The fallback shows the brand header + a spinner so the user sees
 * something immediately while the dynamic content loads.
 */
export function LoginScreen() {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-screen w-full items-center justify-center bg-gradient-to-br from-zinc-50 via-indigo-50/30 to-violet-50/30 dark:from-zinc-950 dark:via-indigo-950/20 dark:to-violet-950/20 px-4 py-8">
          <div className="w-full max-w-md text-center">
            <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-gradient-to-br from-indigo-500 via-violet-500 to-purple-600 text-white shadow-lg shadow-indigo-500/30 ring-1 ring-white/20">
              <Loader2 className="h-8 w-8 animate-spin" />
            </div>
            <p className="text-sm text-zinc-500 dark:text-zinc-400">Loading…</p>
          </div>
        </div>
      }
    >
      <LoginScreenInner />
    </Suspense>
  );
}
