"use client";

import {
  Sparkles,
  Code2,
  BookOpen,
  Lightbulb,
  Youtube,
  Paperclip,
} from "lucide-react";

interface EmptyStateProps {
  onPickPrompt: (prompt: string) => void;
}

const SUGGESTIONS = [
  {
    icon: Lightbulb,
    title: "Brainstorm ideas",
    prompt: "Give me 5 creative product ideas for a sustainable lifestyle brand.",
  },
  {
    icon: Code2,
    title: "Explain code",
    prompt: "Explain how React's useEffect hook works with a simple example.",
  },
  {
    icon: BookOpen,
    title: "Summarize a topic",
    prompt: "Summarize the key concepts of quantum computing in plain English.",
  },
  {
    icon: Sparkles,
    title: "Write something",
    prompt: "Write a short poem about the ocean at sunset.",
  },
];

export function EmptyState({ onPickPrompt }: EmptyStateProps) {
  return (
    <div className="flex h-full flex-col items-center justify-center px-4 py-8">
      <div className="w-full max-w-3xl">
        <div className="mb-10 text-center">
          <div className="mx-auto mb-5 flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br from-emerald-400 to-emerald-600 text-white shadow-lg">
            <Sparkles className="h-7 w-7" />
          </div>
          <h1 className="text-3xl font-semibold text-zinc-800 dark:text-zinc-100">
            How can I help you today?
          </h1>
          <p className="mt-2 text-sm text-zinc-500 dark:text-zinc-400">
            Ask anything, attach files, or summarize a YouTube video — pick a
            suggestion below to begin.
          </p>
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {SUGGESTIONS.map((s) => (
            <button
              key={s.title}
              onClick={() => onPickPrompt(s.prompt)}
              className="group flex items-start gap-3 rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-4 text-left transition-all hover:border-zinc-300 dark:hover:border-zinc-700 hover:shadow-sm"
            >
              <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-300 group-hover:bg-emerald-50 dark:group-hover:bg-emerald-950 group-hover:text-emerald-600 dark:group-hover:text-emerald-400 transition-colors">
                <s.icon className="h-4 w-4" />
              </div>
              <div className="min-w-0">
                <p className="text-sm font-medium text-zinc-800 dark:text-zinc-200">
                  {s.title}
                </p>
                <p className="mt-0.5 line-clamp-2 text-xs text-zinc-500 dark:text-zinc-400">
                  {s.prompt}
                </p>
              </div>
            </button>
          ))}
        </div>

        {/* Feature hints */}
        <div className="mt-6 flex flex-col sm:flex-row items-stretch sm:items-center justify-center gap-3 text-xs">
          <div className="flex items-center gap-2 rounded-full border border-zinc-200 dark:border-zinc-800 px-3 py-1.5 text-zinc-600 dark:text-zinc-400">
            <Paperclip className="h-3.5 w-3.5 text-emerald-500" />
            Attach images or text/code files
          </div>
          <div className="flex items-center gap-2 rounded-full border border-zinc-200 dark:border-zinc-800 px-3 py-1.5 text-zinc-600 dark:text-zinc-400">
            <Youtube className="h-3.5 w-3.5 text-red-500" />
            Summarize YouTube videos with a custom timeline
          </div>
        </div>
      </div>
    </div>
  );
}
