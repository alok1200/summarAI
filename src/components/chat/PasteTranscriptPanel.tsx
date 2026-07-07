"use client";

import { useState, useCallback } from "react";
import { Loader2, ClipboardPaste, X, Youtube, ArrowRight } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * "Paste transcript manually" fallback panel.
 *
 * Shown when /api/youtube-summary returns BOT_BLOCKED, which means YouTube
 * rate-limited this server's IP and none of the 4 in-process transcript
 * strategies could get through. Pasting the transcript text bypasses the
 * block entirely because the summary endpoint can skip the fetch step and
 * work directly off the pasted text.
 *
 * How the user reaches this panel:
 *   1. They paste a YouTube URL in the chat input.
 *   2. sendMessage() routes to /api/youtube-summary.
 *   3. The server tries 4 strategies, all get 429 / "Sign in to confirm
 *      you're not a bot".
 *   4. The server returns BOT_BLOCKED with whatever video metadata it
 *      managed to fetch (title / channel / thumbnail).
 *   5. useStreamHandler writes a "rate-limited" message into the assistant
 *      bubble AND calls onBotBlocked(message, meta) so page.tsx can set
 *      botBlockedVideo state, which renders this panel above the chat input.
 *
 * When the user submits the pasted transcript, page.tsx re-calls
 * /api/youtube-summary with the same URL + the `transcript` body param.
 * The summary route already handles that case (it parses the pasted text
 * via parseUserTranscript and skips the auto-fetch path entirely).
 */
export interface PasteTranscriptPanelProps {
  /** The YouTube URL we couldn't auto-fetch. Re-sent with the pasted
   *  transcript so the summary route can still attach video metadata. */
  url: string;
  /** Optional: video title/channel/thumbnail if the server managed to
   *  fetch oEmbed before the block kicked in. */
  videoMeta?: {
    title?: string;
    author?: string;
    thumbnailUrl?: string;
  };
  /** Optional: language hint the user originally typed (e.g. "Hindi"). */
  language?: string;
  /** Optional: free-form instructions the user originally typed. */
  instructions?: string;
  /** Called when the user clicks "Summarize pasted transcript". The parent
   *  re-dispatches to /api/youtube-summary with the same URL + transcript. */
  onSubmit: (transcript: string) => void;
  /** Called when the user clicks "Cancel" or closes the panel. */
  onCancel: () => void;
}

export function PasteTranscriptPanel({
  url,
  videoMeta,
  language,
  instructions,
  onSubmit,
  onCancel,
}: PasteTranscriptPanelProps) {
  const [text, setText] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = useCallback(() => {
    const trimmed = text.trim();
    if (!trimmed || submitting) return;
    setSubmitting(true);
    onSubmit(trimmed);
  }, [text, submitting, onSubmit]);

  // Try to read the clipboard automatically when the panel mounts, since
  // the user has likely just copied the transcript from YouTube. Best-effort
  // — if the browser blocks it (permissions / no user gesture), the user
  // can still Ctrl+V manually.
  const handleAutoPaste = useCallback(async () => {
    try {
      const clip = await navigator.clipboard.readText();
      if (clip && clip.trim().length > 20) {
        setText(clip);
      }
    } catch {
      // Clipboard read requires a user gesture in most browsers; ignore.
    }
  }, []);

  // Auto-attempt once on mount (will silently fail without a user gesture,
  // which is fine — the user just clicks the "Paste from clipboard" button).
  // Skipping the effect-based auto-paste to avoid an SSR/CSR mismatch warning
  // — the button below is sufficient and doesn't require permissions.

  return (
    <div
      className={cn(
        "border-t border-amber-200/60 dark:border-amber-900/40",
        "bg-gradient-to-b from-amber-50/80 via-orange-50/40 to-white dark:from-amber-950/30 dark:via-orange-950/15 dark:to-zinc-950",
        "px-3 md:px-4 py-4 shadow-[0_-4px_12px_rgba(0,0,0,0.04)]"
      )}
    >
      <div className="mx-auto max-w-3xl">
        {/* Header row: title + close button */}
        <div className="flex items-center gap-2.5 mb-3">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-amber-500/15 dark:bg-amber-500/20 shadow-sm">
            <ClipboardPaste className="h-4 w-4 text-amber-600 dark:text-amber-400" />
          </div>
          <div className="flex flex-col">
            <span className="text-sm font-semibold text-zinc-800 dark:text-zinc-100 leading-tight">
              Paste transcript manually
            </span>
            <span className="text-[11px] text-amber-700/80 dark:text-amber-400/80">
              Bypasses YouTube&apos;s rate limit
            </span>
          </div>
          <button
            type="button"
            onClick={onCancel}
            disabled={submitting}
            aria-label="Dismiss paste-transcript panel"
            className="ml-auto rounded-md p-1.5 text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500/40 disabled:opacity-50"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Video context line */}
        {videoMeta?.title ? (
          <div className="flex items-center gap-2 text-xs text-zinc-600 dark:text-zinc-400 mb-3 rounded-lg bg-white/60 dark:bg-zinc-900/60 px-3 py-2 border border-zinc-200/70 dark:border-zinc-800">
            <Youtube className="h-3.5 w-3.5 text-red-600 dark:text-red-400 shrink-0" />
            <span className="truncate">
              {videoMeta.title}
              {videoMeta.author ? (
                <span className="text-zinc-500 dark:text-zinc-500"> — {videoMeta.author}</span>
              ) : null}
            </span>
          </div>
        ) : (
          <div className="text-xs text-zinc-600 dark:text-zinc-400 mb-3 truncate">
            <span className="text-zinc-500">URL:</span>{" "}
            <a
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-indigo-600 dark:text-indigo-400 hover:underline"
            >
              {url}
            </a>
          </div>
        )}

        {/* How-to-get-transcript hint */}
        <div className="text-[11px] text-zinc-600 dark:text-zinc-400 mb-3 leading-relaxed rounded-lg bg-amber-50/50 dark:bg-amber-950/20 px-3 py-2 border border-amber-100 dark:border-amber-900/40">
          <span className="font-semibold text-amber-700 dark:text-amber-400">How to get the transcript:</span>{" "}
          Open the video on YouTube → click{" "}
          <kbd className="rounded border border-zinc-300 dark:border-zinc-700 px-1 py-0.5 text-[10px] bg-white dark:bg-zinc-800 font-mono">⋯ More</kbd>{" "}
          below the video →{" "}
          <kbd className="rounded border border-zinc-300 dark:border-zinc-700 px-1 py-0.5 text-[10px] bg-white dark:bg-zinc-800 font-mono">Show transcript</kbd>{" "}
          → copy all the text → paste below.
        </div>

        {/* Textarea */}
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          disabled={submitting}
          placeholder={
            "Paste the YouTube transcript here.\n\n" +
            "Accepts any format:\n" +
            "  [3:25] First line\n  [3:42] Second line\n  …\n" +
            "or plain text (one sentence per line)."
          }
          rows={6}
          className={cn(
            "w-full resize-y rounded-xl border border-zinc-300 dark:border-zinc-700/70",
            "bg-white dark:bg-zinc-900/60 backdrop-blur-sm px-3.5 py-2.5 text-sm text-zinc-800 dark:text-zinc-100",
            "placeholder:text-zinc-400 dark:placeholder:text-zinc-500",
            "focus:outline-none focus:ring-2 focus:ring-amber-500/30 focus:border-amber-400",
            "disabled:opacity-60 disabled:cursor-not-allowed",
            "font-mono text-[13px] leading-relaxed shadow-inner"
          )}
          autoFocus
          spellCheck={false}
        />

        {/* Action row */}
        <div className="mt-3 flex items-center gap-2">
          <button
            type="button"
            onClick={handleAutoPaste}
            disabled={submitting}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium",
              "border border-zinc-300 dark:border-zinc-700",
              "bg-white dark:bg-zinc-900/60 text-zinc-700 dark:text-zinc-200",
              "hover:bg-zinc-50 dark:hover:bg-zinc-800",
              "transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500/40",
              "disabled:opacity-50 disabled:cursor-not-allowed"
            )}
          >
            <ClipboardPaste className="h-3.5 w-3.5" />
            Paste from clipboard
          </button>
          <div className="flex-1" />
          <button
            type="button"
            onClick={onCancel}
            disabled={submitting}
            className={cn(
              "inline-flex items-center rounded-lg px-3 py-1.5 text-xs font-medium",
              "text-zinc-600 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800",
              "transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500/40",
              "disabled:opacity-50"
            )}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={!text.trim() || submitting}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-lg px-3.5 py-1.5 text-xs font-semibold",
              "bg-gradient-to-br from-amber-500 to-orange-600 text-white shadow-sm",
              "hover:from-amber-600 hover:to-orange-700 active:scale-95",
              "transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500/40",
              "disabled:opacity-50 disabled:cursor-not-allowed disabled:active:scale-100"
            )}
          >
            {submitting ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Submitting…
              </>
            ) : (
              <>
                Summarize pasted transcript
                <ArrowRight className="h-3.5 w-3.5" />
              </>
            )}
          </button>
        </div>
        {/* Hidden inputs just to make their presence visible to assistive tech */}
        {language && (
          <input type="hidden" value={language} aria-hidden readOnly />
        )}
        {instructions && (
          <input type="hidden" value={instructions} aria-hidden readOnly />
        )}
      </div>
    </div>
  );
}
