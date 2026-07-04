"use client";

import { memo, useState, useMemo } from "react";
import ReactMarkdown from "react-markdown";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { oneDark } from "react-syntax-highlighter/dist/esm/styles/prism";
import {
  Check,
  Copy,
  User,
  Youtube,
  FileText,
  Image as ImageIcon,
  ChevronDown,
  ChevronRight,
  RefreshCw,
  ExternalLink,
  Download,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { Attachment, YouTubeMeta } from "@/store/chat";
import { formatFileSize } from "@/components/chat/attachments";

interface MessageBubbleProps {
  role: "user" | "assistant";
  content: string;
  isStreaming?: boolean;
  attachments?: Attachment[];
  youtubeMeta?: YouTubeMeta;
  /** Video ID for the active YouTube context — used to linkify [MM:SS] timestamps. */
  videoId?: string;
  /** Whether this is the most recent assistant message (eligible for regenerate). */
  isLatestAssistant?: boolean;
  /** Called when the user clicks the Regenerate button on this message. */
  onRegenerate?: () => void;
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

/**
 * Convert [MM:SS] or [H:MM:SS] timestamps in a string to markdown links that
 * open the YouTube video at that timestamp. The timestamp text is preserved
 * (so [3:45] becomes [3:45](https://youtu.be/VIDEO?t=225s)) — users see the
 * same label but it's now clickable.
 *
 * If no videoId is provided, returns the input unchanged.
 */
function linkifyTimestamps(text: string, videoId?: string): string {
  if (!videoId) return text;
  // Match [MM:SS] or [H:MM:SS] or [HH:MM:SS], but not already-linkified ones.
  // Avoid matching inside markdown link syntax: [...](...) — but for simplicity
  // we just check that the bracket is not immediately followed by "(".
  const tsRegex = /\[(\d{1,2}:\d{2}(?::\d{2})?)\](?!\()/g;
  return text.replace(tsRegex, (full, ts: string) => {
    const seconds = tsToSeconds(ts);
    if (seconds === null) return full;
    // Use youtu.be short link with t=Ns parameter (cleaner than watch?v=…&t=Ns)
    const url = `https://youtu.be/${videoId}?t=${seconds}`;
    // Escape the timestamp text inside the link label so it doesn't get
    // re-parsed as markdown.
    return `[${full}](${url})`;
  });
}

function tsToSeconds(ts: string): number | null {
  const parts = ts.split(":").map((p) => parseInt(p, 10));
  if (parts.some((n) => isNaN(n))) return null;
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return null;
}

/**
 * Detect "✅ Chunk X/Y summarized" / "✅ Chunk X/Y analyzed" lines in the
 * streaming content, and return a parsed progress object for the visual bar.
 *
 * Returns null when no map-reduce progress pattern is detected.
 */
interface ProgressInfo {
  /** Total chunks to process. */
  total: number;
  /** Chunks completed so far. */
  done: number;
  /** Phase: "map" (per-chunk summaries being generated) | "reduce" (merging). */
  phase: "map" | "reduce";
}

function parseProgress(content: string): ProgressInfo | null {
  // Detect the "⏳ Processing N chunks in parallel" header to get the total.
  const headerMatch = content.match(
    /⏳\s*\*\*Processing\s+(\d+)\s+chunks in parallel\*\*/
  );
  if (!headerMatch) return null;
  const total = parseInt(headerMatch[1], 10);

  // Find the latest "✅ Chunk X/Y" line — there may be several accumulated.
  const chunkLines = content.matchAll(/✅\s*Chunk\s+(\d+)\/(\d+)/g);
  let done = 0;
  for (const m of chunkLines) {
    const d = parseInt(m[1], 10);
    if (d > done) done = d;
  }

  // Reduce phase: "🔄 Merging…" or "🎯 Generating…"
  const reduceMatch =
    /(?:🔄\s*\*\*Merging|🎯\s*\*\*Generating)/.test(content);
  if (reduceMatch) {
    return { total, done: total, phase: "reduce" };
  }
  return { total, done, phase: "map" };
}

/* ------------------------------------------------------------------ */
/* Sub-components                                                      */
/* ------------------------------------------------------------------ */

function StreamingProgressBar({ info }: { info: ProgressInfo }) {
  const pct =
    info.phase === "reduce"
      ? 100
      : info.total === 0
      ? 0
      : Math.round((info.done / info.total) * 100);
  const label =
    info.phase === "reduce"
      ? `Merging ${info.total} chunk summaries into final answer…`
      : `Processing chunk ${info.done} of ${info.total}…`;
  return (
    <div className="my-3 rounded-lg border border-emerald-200 dark:border-emerald-800 bg-emerald-50/50 dark:bg-emerald-950/30 p-3">
      <div className="flex items-center justify-between text-[11px] font-medium text-emerald-700 dark:text-emerald-300 mb-1.5">
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" />
          {label}
        </span>
        <span>{pct}%</span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-emerald-100 dark:bg-emerald-900">
        <div
          className="h-full rounded-full bg-gradient-to-r from-emerald-400 to-emerald-600 transition-all duration-300 ease-out"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

function CodeBlock({ language, value }: { language: string; value: string }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = () => {
    navigator.clipboard.writeText(value);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <div className="relative my-3 overflow-hidden rounded-lg border border-zinc-700">
      <div className="flex items-center justify-between bg-zinc-800 px-4 py-1.5 text-xs text-zinc-300">
        <span>{language || "code"}</span>
        <button
          onClick={handleCopy}
          className="flex items-center gap-1 hover:text-white"
        >
          {copied ? (
            <>
              <Check className="h-3 w-3" /> Copied
            </>
          ) : (
            <>
              <Copy className="h-3 w-3" /> Copy
            </>
          )}
        </button>
      </div>
      <SyntaxHighlighter
        language={language}
        style={oneDark}
        customStyle={{
          margin: 0,
          padding: "1rem",
          background: "#0a0a0a",
          fontSize: "0.85rem",
        }}
      >
        {value}
      </SyntaxHighlighter>
    </div>
  );
}

function formatTimeRange(meta: YouTubeMeta): string {
  const fmt = (s?: number) => {
    if (s === undefined) return "—";
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = Math.floor(s % 60);
    const pad = (n: number) => n.toString().padStart(2, "0");
    return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
  };
  if (meta.startTime === undefined && meta.endTime === undefined) {
    return "Full video";
  }
  return `${fmt(meta.startTime)} → ${fmt(meta.endTime)}`;
}

function YouTubeCard({ meta }: { meta: YouTubeMeta }) {
  const thumb = `https://img.youtube.com/vi/${meta.videoId}/hqdefault.jpg`;
  return (
    <a
      href={meta.url}
      target="_blank"
      rel="noopener noreferrer"
      className="group mt-2 flex gap-3 overflow-hidden rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 p-3 hover:border-zinc-300 dark:hover:border-zinc-600 transition-colors"
    >
      <div className="relative h-16 w-28 flex-shrink-0 overflow-hidden rounded-lg bg-zinc-100 dark:bg-zinc-800">
        <img
          src={thumb}
          alt="YouTube thumbnail"
          className="h-full w-full object-cover"
          onError={(e) => {
            (e.currentTarget as HTMLImageElement).style.display = "none";
          }}
        />
        <div className="absolute inset-0 flex items-center justify-center bg-black/30">
          <Youtube className="h-6 w-6 text-red-600" />
        </div>
      </div>
      <div className="flex min-w-0 flex-1 flex-col justify-center">
        <p className="text-xs font-semibold text-zinc-700 dark:text-zinc-200">
          YouTube video summary
        </p>
        <p className="mt-0.5 truncate text-[11px] text-zinc-500 dark:text-zinc-400 font-mono">
          {meta.url}
        </p>
        <p className="mt-0.5 text-[11px] text-emerald-600 dark:text-emerald-400">
          ⏱ {formatTimeRange(meta)}
        </p>
        {meta.instructions && (
          <p className="mt-0.5 line-clamp-1 text-[11px] text-zinc-400 italic">
            “{meta.instructions}”
          </p>
        )}
      </div>
    </a>
  );
}

function AttachmentList({ attachments }: { attachments: Attachment[] }) {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  return (
    <div className="mt-2 space-y-2">
      {/* Image grid */}
      {attachments.filter((a) => a.kind === "image").length > 0 && (
        <div className="flex flex-wrap gap-2">
          {attachments
            .filter((a) => a.kind === "image")
            .map((a) => (
              <div
                key={a.id}
                className="relative overflow-hidden rounded-lg border border-zinc-200 dark:border-zinc-700"
              >
                <img
                  src={a.dataUrl}
                  alt={a.name}
                  className="h-32 w-32 object-cover"
                />
                <p className="absolute bottom-0 left-0 right-0 truncate bg-black/60 px-2 py-0.5 text-[10px] text-white">
                  {a.name}
                </p>
              </div>
            ))}
        </div>
      )}
      {/* Text-file chips */}
      {attachments.filter((a) => a.kind === "text").map((a) => {
        const expanded = expandedId === a.id;
        return (
          <div
            key={a.id}
            className="overflow-hidden rounded-lg border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-900"
          >
            <button
              onClick={() => setExpandedId(expanded ? null : a.id)}
              className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors"
            >
              <FileText className="h-4 w-4 flex-shrink-0 text-zinc-500" />
              <span className="flex-1 truncate text-xs font-medium text-zinc-700 dark:text-zinc-200">
                {a.name}
              </span>
              <span className="text-[10px] text-zinc-500">
                {formatFileSize(a.size)}
              </span>
              {expanded ? (
                <ChevronDown className="h-3 w-3 text-zinc-500" />
              ) : (
                <ChevronRight className="h-3 w-3 text-zinc-500" />
              )}
            </button>
            {expanded && a.textContent && (
              <pre className="max-h-64 overflow-auto border-t border-zinc-200 dark:border-zinc-700 bg-zinc-950 p-3 text-[11px] leading-relaxed text-zinc-300 chatgpt-scroll">
                <code>{a.textContent.slice(0, 5000)}</code>
              </pre>
            )}
          </div>
        );
      })}
      {/* Other files (unsupported on the wire but shown for record) */}
      {attachments.filter((a) => a.kind === "file").map((a) => (
        <div
          key={a.id}
          className="flex items-center gap-2 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-900 px-3 py-2"
        >
          <ImageIcon className="h-4 w-4 flex-shrink-0 text-zinc-500" />
          <span className="flex-1 truncate text-xs text-zinc-600 dark:text-zinc-300">
            {a.name}
          </span>
          <span className="text-[10px] text-zinc-500">
            {formatFileSize(a.size)}
          </span>
        </div>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Action bar (under each assistant message)                           */
/* ------------------------------------------------------------------ */

interface AssistantActionBarProps {
  content: string;
  videoId?: string;
  isLatest?: boolean;
  isStreaming?: boolean;
  onRegenerate?: () => void;
}

function AssistantActionBar({
  content,
  videoId,
  isLatest,
  isStreaming,
  onRegenerate,
}: AssistantActionBarProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    // Copy the raw markdown content (without the streaming progress lines).
    navigator.clipboard.writeText(content);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  // Don't render the bar while the very first chunk is still streaming in —
  // it would just be a row of buttons with nothing useful to act on yet.
  if (isStreaming && !content.trim()) return null;

  return (
    <div className="mt-2 flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
      <button
        onClick={handleCopy}
        className="flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-700 transition-colors"
        title="Copy response"
      >
        {copied ? (
          <>
            <Check className="h-3 w-3" /> Copied
          </>
        ) : (
          <>
            <Copy className="h-3 w-3" /> Copy
          </>
        )}
      </button>

      {isLatest && !isStreaming && onRegenerate && (
        <button
          onClick={onRegenerate}
          className="flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-700 transition-colors"
          title="Regenerate response"
        >
          <RefreshCw className="h-3 w-3" /> Regenerate
        </button>
      )}

      {videoId && (
        <a
          href={`https://www.youtube.com/watch?v=${videoId}`}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium text-zinc-500 hover:text-red-600 dark:hover:text-red-400 hover:bg-zinc-100 dark:hover:bg-zinc-700 transition-colors"
          title="Open video on YouTube"
        >
          <Youtube className="h-3 w-3" /> Open video
        </a>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Main MessageBubble                                                  */
/* ------------------------------------------------------------------ */

function MessageBubbleImpl({
  role,
  content,
  isStreaming,
  attachments,
  youtubeMeta,
  videoId,
  isLatestAssistant,
  onRegenerate,
}: MessageBubbleProps) {
  const isUser = role === "user";

  // Linkify [MM:SS] timestamps in the assistant content (only when there's a
  // video context for the link to point at).
  const processedContent = useMemo(() => {
    if (isUser) return content;
    return linkifyTimestamps(content, videoId);
  }, [content, isUser, videoId]);

  // Parse the streaming content for the long-video progress bar.
  const progressInfo = useMemo(
    () => (isStreaming && !isUser ? parseProgress(content) : null),
    [content, isStreaming, isUser]
  );

  return (
    <div
      className={cn(
        "group relative w-full px-4 py-3 md:px-8",
        // Both sides transparent at the row level — the bubble itself carries
        // the background. This avoids the "full-width band" look that made
        // the left/right split invisible before.
        "bg-transparent"
      )}
    >
      <div
        className={cn(
          "mx-auto flex max-w-3xl gap-3 items-start",
          // User: avatar+bubble packed to the LEFT.
          // AI:   bubble+avatar packed to the RIGHT (row reversed).
          isUser ? "justify-start" : "justify-end flex-row-reverse"
        )}
      >
        {/* Avatar */}
        <div
          className={cn(
            "flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full text-xs font-bold text-white shadow-sm",
            isUser
              ? "bg-gradient-to-br from-emerald-400 to-emerald-600"
              : "bg-gradient-to-br from-zinc-700 to-zinc-900 dark:from-zinc-200 dark:to-zinc-400 dark:text-zinc-900"
          )}
        >
          {isUser ? <User className="h-4 w-4" /> : "AI"}
        </div>

        {/* Bubble */}
        <div
          className={cn(
            "flex min-w-0 flex-col",
            // Cap BOTH user and AI bubbles at 75% of the row so the
            // left/right split is visually obvious. Previously the AI bubble
            // used `w-full sm:flex-1` which made it span the entire row and
            // hid the right-alignment.
            "max-w-[75%]",
            isUser
              ? "items-start rounded-2xl rounded-tl-sm bg-emerald-600 dark:bg-emerald-700 px-4 py-2.5 text-white"
              : "items-end rounded-2xl rounded-tr-sm bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 px-4 py-3 w-full"
          )}
        >
          {/* Name label */}
          <div
            className={cn(
              "mb-1 text-xs font-semibold",
              isUser
                ? "text-emerald-50"
                : "text-zinc-500 dark:text-zinc-400"
            )}
          >
            {isUser ? "You" : "Assistant"}
          </div>

          {/* YouTube meta card (user-side) */}
          {isUser && youtubeMeta && <YouTubeCard meta={youtubeMeta} />}

          {/* Attachments (user-side) */}
          {isUser && attachments && attachments.length > 0 && (
            <AttachmentList attachments={attachments} />
          )}

          {/* Main content */}
          {isUser ? (
            <div className="whitespace-pre-wrap break-words text-[15px] leading-7 text-white">
              {content}
            </div>
          ) : (
            <div className="prose prose-sm dark:prose-invert max-w-none w-full text-[15px] leading-7 text-zinc-800 dark:text-zinc-100 [&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
              {/* Visual progress bar at the top of a streaming map-reduce response */}
              {progressInfo && <StreamingProgressBar info={progressInfo} />}

              <ReactMarkdown
                components={{
                  code({ className, children, ...props }) {
                    const match = /language-(\w+)/.exec(className || "");
                    const inline =
                      !className && !String(children).includes("\n");
                    if (inline) {
                      return (
                        <code
                          className="rounded bg-zinc-200 dark:bg-zinc-800 px-1.5 py-0.5 text-[0.85em] font-mono"
                          {...props}
                        >
                          {children}
                        </code>
                      );
                    }
                    return (
                      <CodeBlock
                        language={match?.[1] ?? ""}
                        value={String(children).replace(/\n$/, "")}
                      />
                    );
                  },
                  pre({ children }) {
                    return <>{children}</>;
                  },
                  // Open all links in a new tab so the user doesn't lose their place
                  // in the conversation (especially important for timestamp links).
                  a({ href, children, ...props }) {
                    return (
                      <a
                        href={href}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-emerald-600 dark:text-emerald-400 underline underline-offset-2 hover:text-emerald-700 dark:hover:text-emerald-300"
                        {...props}
                      >
                        {children}
                      </a>
                    );
                  },
                }}
              >
                {processedContent || (isStreaming ? "…" : "")}
              </ReactMarkdown>
              {isStreaming && (
                <span className="ml-0.5 inline-block h-4 w-2 animate-pulse bg-zinc-600 dark:bg-zinc-300 align-middle" />
              )}
            </div>
          )}

          {/* Action bar — only on completed assistant messages */}
          {!isUser && (
            <AssistantActionBar
              content={content}
              videoId={videoId}
              isLatest={isLatestAssistant}
              isStreaming={isStreaming}
              onRegenerate={onRegenerate}
            />
          )}
        </div>
      </div>
    </div>
  );
}

export const MessageBubble = memo(MessageBubbleImpl);
