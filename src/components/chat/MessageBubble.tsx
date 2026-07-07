"use client";

import { memo, useState, useMemo, useEffect } from "react";
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
  Clock,
  Sparkles,
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

function linkifyTimestamps(text: string, videoId?: string): string {
  if (!videoId) return text;
  const tsRegex = /\[(\d{1,2}:\d{2}(?::\d{2})?)\](?!\()/g;
  return text.replace(tsRegex, (full, ts: string) => {
    const seconds = tsToSeconds(ts);
    if (seconds === null) return full;
    const url = `https://youtu.be/${videoId}?t=${seconds}`;
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

interface ProgressInfo {
  total: number;
  done: number;
  phase: "map" | "reduce";
}

function parseProgress(content: string): ProgressInfo | null {
  const headerMatch = content.match(
    /⏳\s*\*\*Processing\s+(\d+)\s+chunks in parallel\*\*/
  );
  if (!headerMatch) return null;
  const total = parseInt(headerMatch[1], 10);

  const chunkLines = content.matchAll(/✅\s*Chunk\s+(\d+)\/(\d+)/g);
  let done = 0;
  for (const m of chunkLines) {
    const d = parseInt(m[1], 10);
    if (d > done) done = d;
  }

  const reduceMatch = /(?:🔄\s*\*\*Merging|🎯\s*\*\*Generating)/.test(content);
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
    <div className="my-3 rounded-xl border border-sky-200/60 dark:border-sky-900/60 bg-gradient-to-br from-sky-50 to-indigo-50 dark:from-sky-950/40 dark:to-indigo-950/40 p-3">
      <div className="flex items-center justify-between text-[11px] font-semibold text-sky-700 dark:text-sky-300 mb-2">
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-1.5 w-1.5 rounded-full bg-sky-500 animate-pulse" />
          {label}
        </span>
        <span className="tabular-nums">{pct}%</span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-sky-100 dark:bg-sky-900/60">
        <div
          className="h-full rounded-full bg-gradient-to-r from-sky-400 to-indigo-500 transition-all duration-300 ease-out"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

function StreamingWaitIndicator() {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const start = Date.now();
    const id = setInterval(() => {
      setElapsed(Math.floor((Date.now() - start) / 1000));
    }, 500);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="my-2 flex items-center gap-3 text-sm text-zinc-500 dark:text-zinc-400">
      <div className="flex items-center gap-1">
        <span className="inline-block h-1.5 w-1.5 animate-bounce rounded-full bg-zinc-400 [animation-delay:-0.3s] dark:bg-zinc-500" />
        <span className="inline-block h-1.5 w-1.5 animate-bounce rounded-full bg-zinc-400 [animation-delay:-0.15s] dark:bg-zinc-500" />
        <span className="inline-block h-1.5 w-1.5 animate-bounce rounded-full bg-zinc-400 dark:bg-zinc-500" />
      </div>
      <span className="text-xs tabular-nums">
        {elapsed === 0 ? "Thinking…" : `${elapsed}s`}
      </span>
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
    <div className="relative my-3 overflow-hidden rounded-xl border border-zinc-200 dark:border-zinc-800 shadow-sm">
      <div className="flex items-center justify-between bg-zinc-50 dark:bg-zinc-900/80 px-4 py-1.5 text-xs text-zinc-600 dark:text-zinc-400 border-b border-zinc-200 dark:border-zinc-800">
        <span className="font-mono">{language || "code"}</span>
        <button
          onClick={handleCopy}
          className="flex items-center gap-1 hover:text-zinc-900 dark:hover:text-zinc-100 transition-colors"
        >
          {copied ? (
            <>
              <Check className="h-3 w-3 text-emerald-500" /> Copied
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

/**
 * Cleaner YouTube card with higher-quality thumbnail, branded chip,
 * and a "Play" overlay instead of just a YouTube logo.
 */
function YouTubeCard({ meta }: { meta: YouTubeMeta }) {
  // Use mqdefault (320×180) — sharper than hqdefault for small cards
  // and reliable on most browsers.
  const thumb = `https://img.youtube.com/vi/${meta.videoId}/mqdefault.jpg`;
  return (
    <a
      href={meta.url}
      target="_blank"
      rel="noopener noreferrer"
      className={cn(
        "group mt-2.5 flex gap-3 overflow-hidden rounded-xl",
        "border border-zinc-200/80 dark:border-zinc-700/70",
        "bg-white dark:bg-zinc-900/80 backdrop-blur-sm",
        "p-2.5 pr-3",
        "hover:border-red-300 dark:hover:border-red-700",
        "hover:shadow-md transition-all"
      )}
    >
      <div className="relative h-[60px] w-[107px] flex-shrink-0 overflow-hidden rounded-lg bg-zinc-100 dark:bg-zinc-800">
        <img
          src={thumb}
          alt="YouTube thumbnail"
          loading="lazy"
          className="h-full w-full object-cover"
          onError={(e) => {
            (e.currentTarget as HTMLImageElement).style.display = "none";
          }}
        />
        {/* Soft dark gradient + play icon overlay */}
        <div className="absolute inset-0 bg-gradient-to-t from-black/50 via-black/0 to-black/0" />
        <div className="absolute inset-0 flex items-center justify-center">
          <div className="flex h-7 w-7 items-center justify-center rounded-full bg-red-600 shadow-lg ring-2 ring-white/30 group-hover:scale-110 transition-transform">
            <Youtube className="h-3.5 w-3.5 text-white" />
          </div>
        </div>
      </div>
      <div className="flex min-w-0 flex-1 flex-col justify-center">
        <div className="flex items-center gap-1.5">
          <span className="inline-flex items-center gap-1 rounded-md bg-red-50 dark:bg-red-950/50 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-red-600 dark:text-red-400">
            <Youtube className="h-2.5 w-2.5" />
            YouTube
          </span>
          <span className="text-[11px] font-medium text-zinc-600 dark:text-zinc-400">
            Summary
          </span>
        </div>
        <p className="mt-1 truncate text-xs text-zinc-500 dark:text-zinc-400 font-mono">
          youtu.be/{meta.videoId}
        </p>
        <p className="mt-0.5 flex items-center gap-1 text-[11px] font-medium text-zinc-600 dark:text-zinc-400">
          <Clock className="h-3 w-3" />
          {formatTimeRange(meta)}
        </p>
        {meta.instructions && (
          <p className="mt-0.5 line-clamp-1 text-[11px] text-zinc-400 dark:text-zinc-500 italic">
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
    <div className="mt-2.5 space-y-2">
      {attachments.filter((a) => a.kind === "image").length > 0 && (
        <div className="flex flex-wrap gap-2">
          {attachments
            .filter((a) => a.kind === "image")
            .map((a) => (
              <div
                key={a.id}
                className="relative overflow-hidden rounded-lg border border-white/20 dark:border-zinc-700"
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
      {attachments.filter((a) => a.kind === "text").map((a) => {
        const expanded = expandedId === a.id;
        return (
          <div
            key={a.id}
            className="overflow-hidden rounded-lg border border-white/20 dark:border-zinc-700 bg-zinc-50/90 dark:bg-zinc-900/80"
          >
            <button
              onClick={() => setExpandedId(expanded ? null : a.id)}
              className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-zinc-100/80 dark:hover:bg-zinc-800/80 transition-colors"
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
      {attachments.filter((a) => a.kind === "file").map((a) => (
        <div
          key={a.id}
          className="flex items-center gap-2 rounded-lg border border-white/20 dark:border-zinc-700 bg-zinc-50/90 dark:bg-zinc-900/80 px-3 py-2"
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
    navigator.clipboard.writeText(content);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  if (isStreaming && !content.trim()) return null;

  return (
    <div className="mt-2.5 flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity duration-200">
      <button
        onClick={handleCopy}
        className={cn(
          "flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[11px] font-medium",
          "text-zinc-500 dark:text-zinc-400",
          "hover:bg-zinc-100 dark:hover:bg-zinc-800",
          "hover:text-zinc-900 dark:hover:text-zinc-100",
          "transition-colors"
        )}
        title="Copy response"
      >
        {copied ? (
          <>
            <Check className="h-3.5 w-3.5 text-emerald-500" /> Copied
          </>
        ) : (
          <>
            <Copy className="h-3.5 w-3.5" /> Copy
          </>
        )}
      </button>

      {isLatest && !isStreaming && onRegenerate && (
        <button
          onClick={onRegenerate}
          className={cn(
            "flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[11px] font-medium",
            "text-zinc-500 dark:text-zinc-400",
            "hover:bg-zinc-100 dark:hover:bg-zinc-800",
            "hover:text-zinc-900 dark:hover:text-zinc-100",
            "transition-colors"
          )}
          title="Regenerate response"
        >
          <RefreshCw className="h-3.5 w-3.5" /> Regenerate
        </button>
      )}

      {videoId && (
        <a
          href={`https://www.youtube.com/watch?v=${videoId}`}
          target="_blank"
          rel="noopener noreferrer"
          className={cn(
            "flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[11px] font-medium",
            "text-zinc-500 dark:text-zinc-400",
            "hover:bg-red-50 dark:hover:bg-red-950/40",
            "hover:text-red-600 dark:hover:text-red-400",
            "transition-colors"
          )}
          title="Open video on YouTube"
        >
          <ExternalLink className="h-3.5 w-3.5" /> Open video
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

  const processedContent = useMemo(() => {
    if (isUser) return content;
    return linkifyTimestamps(content, videoId);
  }, [content, isUser, videoId]);

  const progressInfo = useMemo(
    () => (isStreaming && !isUser ? parseProgress(content) : null),
    [content, isStreaming, isUser]
  );

  return (
    <div
      className={cn(
        "group relative w-full px-4 py-3 md:px-6",
        "bg-transparent",
        isUser ? "msg-enter-user" : "msg-enter-assistant"
      )}
    >
      <div
        className={cn(
          "mx-auto flex max-w-3xl gap-3 items-start",
          isUser ? "justify-start" : "justify-end flex-row-reverse"
        )}
      >
        {/* Avatar — refined with subtle ring and cleaner styling */}
        <div
          className={cn(
            "flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full",
            "shadow-sm ring-1 ring-black/5 dark:ring-white/10",
            isUser
              ? "bg-gradient-to-br from-indigo-500 to-violet-600 text-white"
              : "bg-gradient-to-br from-zinc-100 to-zinc-300 dark:from-zinc-700 dark:to-zinc-800 text-zinc-700 dark:text-zinc-200"
          )}
        >
          {isUser ? (
            <User className="h-4 w-4" />
          ) : (
            <Sparkles className="h-4 w-4" />
          )}
        </div>

        {/* Bubble */}
        <div
          className={cn(
            "flex min-w-0 flex-col max-w-[80%]",
            isUser
              ? "items-start rounded-2xl rounded-tl-md"
              : "items-end rounded-2xl rounded-tr-md w-full"
          )}
        >
          {/* Name label */}
          <div
            className={cn(
              "mb-1 text-xs font-semibold tracking-wide",
              isUser
                ? "text-indigo-100"
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
            <div
              className={cn(
                "whitespace-pre-wrap break-words text-[14.5px] leading-7",
                "rounded-2xl rounded-tl-md px-4 py-2.5",
                "bg-gradient-to-br from-indigo-500 to-violet-600",
                "text-white shadow-sm",
                youtubeMeta || (attachments && attachments.length > 0)
                  ? "mt-2"
                  : ""
              )}
            >
              {content}
            </div>
          ) : (
            <div
              className={cn(
                "prose prose-sm dark:prose-invert max-w-none w-full",
                "rounded-2xl rounded-tr-md px-4 py-3",
                "bg-white dark:bg-zinc-800/80 backdrop-blur-sm",
                "border border-zinc-200/70 dark:border-zinc-700/60",
                "shadow-sm",
                "text-[14.5px] leading-7",
                "text-zinc-800 dark:text-zinc-100",
                "[&>*:first-child]:mt-0 [&>*:last-child]:mb-0"
              )}
            >
              {progressInfo && <StreamingProgressBar info={progressInfo} />}

              {isStreaming &&
                !progressInfo &&
                !processedContent.trim() && <StreamingWaitIndicator />}

              <ReactMarkdown
                components={{
                  code({ className, children, ...props }) {
                    const match = /language-(\w+)/.exec(className || "");
                    const inline =
                      !className && !String(children).includes("\n");
                    if (inline) {
                      return (
                        <code
                          className="rounded bg-zinc-200/70 dark:bg-zinc-700/70 px-1.5 py-0.5 text-[0.85em] font-mono text-zinc-800 dark:text-zinc-100"
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
                  a({ href, children, ...props }) {
                    return (
                      <a
                        href={href}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-indigo-600 dark:text-indigo-400 underline underline-offset-2 hover:text-indigo-700 dark:hover:text-indigo-300 transition-colors"
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
                <span className="ml-0.5 inline-block h-4 w-2 animate-pulse bg-indigo-500 dark:bg-indigo-400 align-middle rounded-sm" />
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
