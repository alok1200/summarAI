"use client";

import { memo } from "react";
import ReactMarkdown from "react-markdown";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { oneDark } from "react-syntax-highlighter/dist/esm/styles/prism";
import { Check, Copy, User } from "lucide-react";
import { useState } from "react";
import { cn } from "@/lib/utils";

interface MessageBubbleProps {
  role: "user" | "assistant";
  content: string;
  isStreaming?: boolean;
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

function MessageBubbleImpl({ role, content, isStreaming }: MessageBubbleProps) {
  const isUser = role === "user";

  return (
    <div
      className={cn(
        "group w-full px-4 py-6 md:px-8",
        isUser
          ? "bg-transparent"
          : "bg-zinc-50 dark:bg-zinc-900/40"
      )}
    >
      <div className="mx-auto flex max-w-3xl gap-4">
        {/* Avatar */}
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

        {/* Content */}
        <div className="flex-1 min-w-0 overflow-hidden">
          <div className="mb-1 text-sm font-semibold text-zinc-800 dark:text-zinc-200">
            {isUser ? "You" : "Assistant"}
          </div>
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
                    const inline = !className && !String(children).includes("\n");
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
