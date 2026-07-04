"use client";

import { useEffect } from "react";
import { Sparkles, RotateCcw } from "lucide-react";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Log to console for debugging — in production you'd want to send this
    // to an error tracking service like Sentry.
    console.error("[app-error]", error);
  }, [error]);

  return (
    <div className="flex min-h-screen w-full items-center justify-center bg-zinc-50 dark:bg-zinc-950 px-4 py-8">
      <div className="w-full max-w-md text-center">
        <div className="mx-auto mb-5 flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br from-amber-400 to-red-500 text-white shadow-lg">
          <Sparkles className="h-7 w-7" />
        </div>
        <h1 className="text-2xl font-semibold text-zinc-800 dark:text-zinc-100">
          Something went wrong
        </h1>
        <p className="mt-2 text-sm text-zinc-500 dark:text-zinc-400">
          An unexpected error occurred while rendering this page. You can try
          again — your conversation history is preserved.
        </p>
        {error?.message && (
          <pre className="mt-4 overflow-auto rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-3 text-left text-xs text-zinc-600 dark:text-zinc-400 max-h-32">
            {error.message}
          </pre>
        )}
        <button
          onClick={reset}
          className="mt-6 inline-flex items-center gap-2 rounded-lg bg-zinc-900 dark:bg-zinc-100 px-4 py-2 text-sm font-medium text-white dark:text-zinc-900 hover:opacity-90 transition-opacity"
        >
          <RotateCcw className="h-4 w-4" />
          Try again
        </button>
      </div>
    </div>
  );
}
