"use client";

import { memo, useState } from "react";
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

function MessageBubbleImpl({
  role,
  content,
  isStreaming,
  attachments,
  youtubeMeta,
}: MessageBubbleProps) {
  const isUser = role === "user";

  return (
    <div
      className={cn(
        "group w-full px-4 py-6 md:px-8",
        isUser ? "bg-transparent" : "bg-zinc-50 dark:bg-zinc-900/40"
      )}
    >
      <div className="mx-auto flex max-w-3xl gap-4">
        <div
          className={cn(
            "flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full text-xs font-bold text-white",
            isUser
              ? "bg-gradient-to-br from-emerald-400 to-emerald-600"
              : "bg-gradient-to-br from-zinc-700 to-zinc-900 dark:from-zinc-200 dark:to-zinc-400 dark:text-zinc-900"
          )}
        >
          {isUser ? <User className="h-4 w-4" /> : "AI"}
        </div>

        <div className="flex-1 min-w-0 overflow-hidden">
          <div className="mb-1 text-sm font-semibold text-zinc-800 dark:text-zinc-200">
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
            <div className="whitespace-pre-wrap break-words text-[15px] leading-7 text-zinc-800 dark:text-zinc-100">
              {content}
            </div>
          ) : (
            <div className="prose prose-sm dark:prose-invert max-w-none text-[15px] leading-7 text-zinc-800 dark:text-zinc-100 [&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
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
                }}
              >
                {content || (isStreaming ? "…" : "")}
              </ReactMarkdown>
              {isStreaming && (
                <span className="ml-0.5 inline-block h-4 w-2 animate-pulse bg-zinc-600 dark:bg-zinc-300 align-middle" />
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export const MessageBubble = memo(MessageBubbleImpl);
