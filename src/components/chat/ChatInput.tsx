"use client";

import { useRef, useEffect, useState } from "react";
import { ArrowUp, Square } from "lucide-react";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

interface ChatInputProps {
  onSubmit: (text: string) => void;
  onStop?: () => void;
  isStreaming: boolean;
}

export function ChatInput({ onSubmit, onStop, isStreaming }: ChatInputProps) {
  const [value, setValue] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Auto-resize textarea
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = Math.min(el.scrollHeight, 200) + "px";
  }, [value]);

  const handleSubmit = () => {
    const trimmed = value.trim();
    if (!trimmed || isStreaming) return;
    onSubmit(trimmed);
    setValue("");
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      handleSubmit();
    }
  };

  return (
    <div className="px-4 pb-4 pt-2 md:px-8">
      <div className="mx-auto max-w-3xl">
        <div
          className={cn(
            "relative flex items-end gap-2 rounded-3xl border bg-white dark:bg-zinc-800 shadow-sm transition-colors",
            "border-zinc-200 dark:border-zinc-700",
            "focus-within:border-zinc-400 dark:focus-within:border-zinc-500"
          )}
        >
          <Textarea
            ref={textareaRef}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Send a message…"
            rows={1}
            className="min-h-[52px] max-h-[200px] flex-1 resize-none border-0 bg-transparent px-5 py-3.5 text-[15px] leading-6 text-zinc-900 dark:text-zinc-100 placeholder:text-zinc-400 focus-visible:outline-none focus-visible:ring-0 focus-visible:ring-offset-0"
          />
          <div className="p-2.5">
            {isStreaming ? (
              <button
                onClick={onStop}
                className="flex h-9 w-9 items-center justify-center rounded-full bg-zinc-900 dark:bg-zinc-100 text-white dark:text-zinc-900 hover:opacity-80 transition-opacity"
                aria-label="Stop"
              >
                <Square className="h-4 w-4 fill-current" />
              </button>
            ) : (
              <button
                onClick={handleSubmit}
                disabled={!value.trim()}
                className={cn(
                  "flex h-9 w-9 items-center justify-center rounded-full transition-colors",
                  value.trim()
                    ? "bg-zinc-900 dark:bg-zinc-100 text-white dark:text-zinc-900 hover:opacity-80"
                    : "bg-zinc-200 dark:bg-zinc-700 text-zinc-400 dark:text-zinc-500 cursor-not-allowed"
                )}
                aria-label="Send"
              >
                <ArrowUp className="h-5 w-5" />
              </button>
            )}
          </div>
        </div>
        <p className="mt-2 text-center text-xs text-zinc-400 dark:text-zinc-500">
          AI can make mistakes. Check important info.
        </p>
      </div>
    </div>
  );
}
