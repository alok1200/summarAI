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
        "border-t border-zinc-200 dark:border-zinc-800",
        "bg-gradient-to-b from-amber-50 to-white dark:from-amber-950/20 dark:to-zinc-950",
        "px-3 md:px-4 py-3"
      )}
    >
      <div className="mx-auto max-w-3xl">
        {/* Header row: title + close button */}
        <div className="flex items-center gap-2 mb-2">
          <ClipboardPaste className="h-4 w-4 text-amber-600 dark:text-amber-400 shrink-0" />
          <span className="text-sm font-semibold text-zinc-800 dark:text-zinc-100">
            Paste transcript manually
          </span>
          <button
            type="button"
            onClick={onCancel}
            disabled={submitting}
            aria-label="Dismiss paste-transcript panel"
            className="ml-auto rounded-md p-1 text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/40 disabled:opacity-50"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Video context line */}
        {videoMeta?.title ? (
          <div className="flex items-center gap-2 text-xs text-zinc-600 dark:text-zinc-400 mb-2">
            <Youtube className="h-3.5 w-3.5 text-red-600 dark:text-red-400 shrink-0" />
            <span className="truncate">
              {videoMeta.title}
              {videoMeta.author ? ` — ${videoMeta.author}` : ""}
            </span>
          </div>
        ) : (
          <div className="text-xs text-zinc-600 dark:text-zinc-400 mb-2 truncate">
            <span className="text-zinc-500">URL:</span>{" "}
            <a
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-emerald-600 dark:text-emerald-400 hover:underline"
            >
              {url}
            </a>
          </div>
        )}

        {/* How-to-get-transcript hint */}
        <div className="text-xs text-zinc-600 dark:text-zinc-400 mb-2 leading-relaxed">
          Open the video on YouTube → click <kbd className="rounded border border-zinc-300 dark:border-zinc-700 px-1 py-0.5 text-[10px] bg-white dark:bg-zinc-800">⋯ More</kbd> below the video → <kbd className="rounded border border-zinc-300 dark:border-zinc-700 px-1 py-0.5 text-[10px] bg-white dark:bg-zinc-800">Show transcript</kbd> → copy all the text → paste below.
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
            "w-full resize-y rounded-lg border border-zinc-300 dark:border-zinc-700",
            "bg-white dark:bg-zinc-900 px-3 py-2 text-sm text-zinc-800 dark:text-zinc-100",
            "placeholder:text-zinc-400 dark:placeholder:text-zinc-500",
            "focus:outline-none focus:ring-2 focus:ring-emerald-500/30 focus:border-emerald-400",
            "disabled:opacity-60 disabled:cursor-not-allowed",
            "font-mono text-[13px] leading-relaxed"
          )}
          autoFocus
          spellCheck={false}
        />

        {/* Action row */}
        <div className="mt-2 flex items-center gap-2">
          <button
            type="button"
            onClick={handleAutoPaste}
            disabled={submitting}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium",
              "border border-zinc-300 dark:border-zinc-700",
              "bg-white dark:bg-zinc-900 text-zinc-700 dark:text-zinc-200",
              "hover:bg-zinc-50 dark:hover:bg-zinc-800",
              "transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/40",
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
              "inline-flex items-center rounded-md px-3 py-1.5 text-xs font-medium",
              "text-zinc-600 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800",
              "transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/40",
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
              "inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-semibold",
              "bg-emerald-600 text-white hover:bg-emerald-700 active:scale-95",
              "transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/40",
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
