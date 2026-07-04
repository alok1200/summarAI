import Link from "next/link";
import { Sparkles } from "lucide-react";

export default function NotFound() {
  return (
    <div className="flex min-h-screen w-full items-center justify-center bg-zinc-50 dark:bg-zinc-950 px-4 py-8">
      <div className="w-full max-w-md text-center">
        <div className="mx-auto mb-5 flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br from-emerald-400 to-emerald-600 text-white shadow-lg">
          <Sparkles className="h-7 w-7" />
        </div>
        <h1 className="text-3xl font-semibold text-zinc-800 dark:text-zinc-100">
          404
        </h1>
        <p className="mt-2 text-sm text-zinc-500 dark:text-zinc-400">
          The page you&apos;re looking for doesn&apos;t exist or has been moved.
        </p>
        <Link
          href="/"
          className="mt-6 inline-flex items-center gap-2 rounded-lg bg-zinc-900 dark:bg-zinc-100 px-4 py-2 text-sm font-medium text-white dark:text-zinc-900 hover:opacity-90 transition-opacity"
        >
          Back to home
        </Link>
      </div>
    </div>
  );
}
