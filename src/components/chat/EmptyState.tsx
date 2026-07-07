"use client";

import {
  Sparkles,
  Code2,
  BookOpen,
  Lightbulb,
  Youtube,
  Paperclip,
  PenLine,
} from "lucide-react";
import { cn } from "@/lib/utils";

interface EmptyStateProps {
  onPickPrompt: (prompt: string) => void;
}

const SUGGESTIONS = [
  {
    icon: Lightbulb,
    title: "Brainstorm ideas",
    prompt: "Give me 5 creative product ideas for a sustainable lifestyle brand.",
    accent: "amber",
  },
  {
    icon: Code2,
    title: "Explain code",
    prompt: "Explain how React's useEffect hook works with a simple example.",
    accent: "indigo",
  },
  {
    icon: BookOpen,
    title: "Summarize a topic",
    prompt: "Summarize the key concepts of quantum computing in plain English.",
    accent: "emerald",
  },
  {
    icon: PenLine,
    title: "Write something",
    prompt: "Write a short poem about the ocean at sunset.",
    accent: "rose",
  },
];

// Accent color mapping. Each card gets a subtle tinted hover state.
const ACCENT_STYLES: Record<string, {
  iconBg: string;
  iconText: string;
  hoverBorder: string;
  hoverBg: string;
}> = {
  amber: {
    iconBg: "group-hover:bg-amber-50 dark:group-hover:bg-amber-950/40",
    iconText: "group-hover:text-amber-600 dark:group-hover:text-amber-400",
    hoverBorder: "hover:border-amber-200 dark:hover:border-amber-800/60",
    hoverBg: "",
  },
  indigo: {
    iconBg: "group-hover:bg-indigo-50 dark:group-hover:bg-indigo-950/40",
    iconText: "group-hover:text-indigo-600 dark:group-hover:text-indigo-400",
    hoverBorder: "hover:border-indigo-200 dark:hover:border-indigo-800/60",
    hoverBg: "",
  },
  emerald: {
    iconBg: "group-hover:bg-emerald-50 dark:group-hover:bg-emerald-950/40",
    iconText: "group-hover:text-emerald-600 dark:group-hover:text-emerald-400",
    hoverBorder: "hover:border-emerald-200 dark:hover:border-emerald-800/60",
    hoverBg: "",
  },
  rose: {
    iconBg: "group-hover:bg-rose-50 dark:group-hover:bg-rose-950/40",
    iconText: "group-hover:text-rose-600 dark:group-hover:text-rose-400",
    hoverBorder: "hover:border-rose-200 dark:hover:border-rose-800/60",
    hoverBg: "",
  },
};

export function EmptyState({ onPickPrompt }: EmptyStateProps) {
  return (
    <div className="flex h-full flex-col items-center justify-center px-4 py-8">
      <div className="w-full max-w-3xl">
        <div className="mb-10 text-center">
          <div className="mx-auto mb-5 flex h-16 w-16 items-center justify-center rounded-2xl bg-gradient-to-br from-indigo-500 via-violet-500 to-purple-600 text-white shadow-lg shadow-indigo-500/30 ring-1 ring-white/20">
            <Sparkles className="h-8 w-8" />
          </div>
          <div className="mb-2 text-2xl font-semibold tracking-tight text-zinc-800 dark:text-zinc-100">
            Summar<span className="text-indigo-500">AI</span>
          </div>
          <h1 className="text-3xl font-semibold tracking-tight text-zinc-800 dark:text-zinc-100">
            How can I help you today?
          </h1>
          <p className="mt-2 text-sm text-zinc-500 dark:text-zinc-400">
            Ask anything, attach files, or summarize a YouTube video — pick a
            suggestion below to begin.
          </p>
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {SUGGESTIONS.map((s) => {
            const accent = ACCENT_STYLES[s.accent];
            return (
              <button
                key={s.title}
                onClick={() => onPickPrompt(s.prompt)}
                className={cn(
                  "group flex items-start gap-3 rounded-2xl border border-zinc-200 dark:border-zinc-800",
                  "bg-white dark:bg-zinc-900/70 backdrop-blur-sm",
                  "p-4 text-left transition-all",
                  "hover:shadow-md hover:-translate-y-0.5",
                  accent.hoverBorder,
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/40"
                )}
              >
                <div
                  className={cn(
                    "flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-xl",
                    "bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-300",
                    "transition-colors",
                    accent.iconBg,
                    accent.iconText
                  )}
                >
                  <s.icon className="h-4 w-4" />
                </div>
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-zinc-800 dark:text-zinc-100">
                    {s.title}
                  </p>
                  <p className="mt-0.5 line-clamp-2 text-xs text-zinc-500 dark:text-zinc-400">
                    {s.prompt}
                  </p>
                </div>
              </button>
            );
          })}
        </div>

        {/* Feature hints */}
        <div className="mt-6 flex flex-col sm:flex-row items-stretch sm:items-center justify-center gap-3 text-xs">
          <div className="flex items-center gap-2 rounded-full border border-zinc-200 dark:border-zinc-800 bg-white/60 dark:bg-zinc-900/60 px-3.5 py-1.5 text-zinc-600 dark:text-zinc-400">
            <Paperclip className="h-3.5 w-3.5 text-indigo-500" />
            Attach images or text/code files
          </div>
          <div className="flex items-center gap-2 rounded-full border border-zinc-200 dark:border-zinc-800 bg-white/60 dark:bg-zinc-900/60 px-3.5 py-1.5 text-zinc-600 dark:text-zinc-400">
            <Youtube className="h-3.5 w-3.5 text-red-500" />
            Summarize YouTube videos with a custom timeline
          </div>
        </div>
      </div>
    </div>
  );
}
