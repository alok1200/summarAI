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
 * Inline Google "G" logo — multicolor, official SVG path.
 * Kept inline (not imported) so we don't add a dependency just for one icon.
 */
function GoogleGLogo({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="#4285F4"
        d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
      />
      <path
        fill="#34A853"
        d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
      />
      <path
        fill="#FBBC05"
        d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
      />
      <path
        fill="#EA4335"
        d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
      />
    </svg>
  );
}

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

  // Display the auth_error query param if present (set by the Google OAuth
  // callback when something goes wrong). We show it once on mount and then
  // clear the URL so it doesn't linger across reloads.
  useEffect(() => {
    const authError = searchParams.get("auth_error");
    if (authError) {
      setError(authError);
      // Strip the query param so the error doesn't persist across reloads
      // or get accidentally shared/bookmarked with the URL.
      try {
        window.history.replaceState(
          {},
          "",
          window.location.pathname + window.location.hash
        );
      } catch {
        // ignore — if replaceState fails (e.g. very old browser), the
        // error is still shown; it just may persist in the URL.
      }
    }
  }, [searchParams]);

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
      //
      // IMPORTANT: Do NOT call fetchMe() here, not even as a "safety net".
      // The previous session deliberately removed the fetchMe verification
      // because it was racing with cookie persistence and producing false
      // "cookie wasn't accepted" errors that kicked the user back to the
      // login screen. The POST response already contains the user object
      // and the Set-Cookie header is processed synchronously by the browser
      // before this line runs, so the session is fully established.
      setUser(data.user);
      setLoading(false);

      // The parent will unmount this screen now. No need to reset
      // submitting — the component is going away.
    } finally {
      if (reqId === reqIdRef.current) {
        setSubmitting(false);
      }
    }
  };

  /**
   * Google Sign-In: just navigate to /api/auth/google. The server generates
   * the state cookie and 302-redirects to Google's consent screen. After
   * consent, Google redirects back to /api/auth/google/callback, which
   * sets the session cookie and 302-redirects to /.
   *
   * We use a full-page navigation (window.location.href) rather than
   * fetch() because (a) we need the browser to follow the 302 chain
   * through Google and back, and (b) Google's consent screen needs to be
   * a top-level navigation (it can't be iframed or fetched).
   *
   * This is a client-side check — we don't fetch /api/auth/me to detect
   * configuration. Instead, we assume Google OAuth is enabled if the env
   * vars are set on the server. If they aren't, the user will see a 503
   * JSON error after clicking. To avoid that, we expose a runtime flag
   * via a meta tag set by the server. For simplicity in this iteration,
   * we always show the button — operators who don't want it should leave
   * the GOOGLE_* env vars unset, which makes the GET handler return 503
   * with a clear message.
   *
   * Better approach for a future iteration: expose /api/auth/google/enabled
   * (a tiny GET that returns {enabled: boolean}) and hide the button
   * client-side. Out of scope for this task.
   */
  const handleGoogleSignIn = () => {
    if (submitting) return;
    setError(null);
    setSubmitting(true);
    // Full-page navigation — the browser follows the redirect chain.
    window.location.href = "/api/auth/google";
  };

  const switchMode = (m: Mode) => {
    if (submitting) return;
    setMode(m);
    setError(null);
  };

  return (
    <div className="flex min-h-screen w-full items-center justify-center bg-zinc-50 dark:bg-zinc-950 px-4 py-8">
      <div className="w-full max-w-md">
        {/* Logo / brand header */}
        <div className="mb-8 text-center">
          <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br from-emerald-400 to-emerald-600 text-white shadow-lg">
            <Sparkles className="h-7 w-7" />
          </div>
          <div className="mb-1 text-2xl font-semibold tracking-tight text-zinc-800 dark:text-zinc-100">
            Summar<span className="text-emerald-500">AI</span>
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
        <div className="rounded-2xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-6 shadow-sm transition-shadow hover:shadow-md">
          {/* Mode tabs */}
          <div className="mb-5 flex rounded-lg bg-zinc-100 dark:bg-zinc-800 p-1">
            <button
              type="button"
              onClick={() => switchMode("login")}
              className={cn(
                "flex-1 rounded-md py-1.5 text-sm font-medium transition-colors",
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
                "flex-1 rounded-md py-1.5 text-sm font-medium transition-colors",
                mode === "signup"
                  ? "bg-white dark:bg-zinc-950 text-zinc-900 dark:text-white shadow-sm"
                  : "text-zinc-500 dark:text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-300"
              )}
            >
              Sign up
            </button>
          </div>

          {/* Google Sign-In button */}
          <button
            type="button"
            onClick={handleGoogleSignIn}
            disabled={submitting}
            className="flex w-full items-center justify-center gap-3 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-950 py-2.5 text-sm font-medium text-zinc-700 dark:text-zinc-200 hover:bg-zinc-50 dark:hover:bg-zinc-800 transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
          >
            <GoogleGLogo className="h-5 w-5" />
            {mode === "login" ? "Sign in with Google" : "Sign up with Google"}
          </button>

          {/* Divider */}
          <div className="my-5 flex items-center gap-3">
            <div className="h-px flex-1 bg-zinc-200 dark:bg-zinc-800" />
            <span className="text-xs text-zinc-400 dark:text-zinc-500">
              or continue with email
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
                    className="w-full rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-950 py-2.5 pl-9 pr-3 text-sm text-zinc-900 dark:text-zinc-100 placeholder:text-zinc-400 focus:border-emerald-500 focus:outline-none focus:ring-2 focus:ring-emerald-500/20"
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
                  className="w-full rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-950 py-2.5 pl-9 pr-3 text-sm text-zinc-900 dark:text-zinc-100 placeholder:text-zinc-400 focus:border-emerald-500 focus:outline-none focus:ring-2 focus:ring-emerald-500/20"
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
                  className="w-full rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-950 py-2.5 pl-9 pr-9 text-sm text-zinc-900 dark:text-zinc-100 placeholder:text-zinc-400 focus:border-emerald-500 focus:outline-none focus:ring-2 focus:ring-emerald-500/20"
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
              <div className="rounded-lg border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950/40 px-3 py-2 text-xs text-red-700 dark:text-red-300">
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={submitting}
              className="flex w-full items-center justify-center gap-2 rounded-lg bg-zinc-900 dark:bg-zinc-100 py-2.5 text-sm font-medium text-white dark:text-zinc-900 hover:opacity-90 transition-opacity disabled:opacity-60 disabled:cursor-not-allowed"
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
                  className="font-medium text-emerald-600 dark:text-emerald-400 hover:underline"
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
                  className="font-medium text-emerald-600 dark:text-emerald-400 hover:underline"
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
        <div className="flex min-h-screen w-full items-center justify-center bg-zinc-50 dark:bg-zinc-950 px-4 py-8">
          <div className="w-full max-w-md text-center">
            <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br from-emerald-400 to-emerald-600 text-white shadow-lg">
              <Loader2 className="h-7 w-7 animate-spin" />
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
