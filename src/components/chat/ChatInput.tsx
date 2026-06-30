"use client";

import { useRef, useEffect, useState } from "react";
import { ArrowUp, Square, Paperclip, Youtube, X, FileText, Image as ImageIcon } from "lucide-react";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import type { Attachment } from "@/store/chat";
import {
  processFiles,
  formatFileSize,
  MAX_FILES,
} from "@/components/chat/attachments";

interface PendingAttachment {
  attachment: Attachment;
  // For preview of text-file content
  preview?: string;
}

interface ChatInputProps {
  onSubmit: (text: string, attachments: Attachment[]) => void;
  onStop?: () => void;
  onOpenYouTube?: () => void;
  isStreaming: boolean;
}

export function ChatInput({
  onSubmit,
  onStop,
  onOpenYouTube,
  isStreaming,
}: ChatInputProps) {
  const [value, setValue] = useState("");
  const [pending, setPending] = useState<PendingAttachment[]>([]);
  const [errors, setErrors] = useState<string[]>([]);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Auto-resize textarea
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = Math.min(el.scrollHeight, 200) + "px";
  }, [value]);

  const handleSubmit = () => {
    const trimmed = value.trim();
    if ((!trimmed && pending.length === 0) || isStreaming) return;
    onSubmit(trimmed, pending.map((p) => p.attachment));
    setValue("");
    setPending([]);
    setErrors([]);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      handleSubmit();
    }
  };

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    e.target.value = ""; // reset so the same file can be picked again
    if (files.length === 0) return;

    const remaining = MAX_FILES - pending.length;
    if (remaining <= 0) {
      setErrors([`You can attach at most ${MAX_FILES} files per message.`]);
      return;
    }
    const slice = files.slice(0, remaining);
    const overflow = files.length - slice.length;

    const { attachments, errors: errs } = await processFiles(slice);
    const newPending: PendingAttachment[] = attachments.map((a) => ({
      attachment: a,
      preview:
        a.kind === "text" ? a.textContent?.slice(0, 200) : undefined,
    }));

    setPending((p) => [...p, ...newPending]);
    setErrors([
      ...errs,
      ...(overflow > 0
        ? [`Only the first ${slice.length} file(s) were attached (max ${MAX_FILES}).`]
        : []),
    ]);
  };

  const removeAttachment = (id: string) => {
    setPending((p) => p.filter((x) => x.attachment.id !== id));
  };

  const hasInput = value.trim() || pending.length > 0;

  return (
    <div className="px-4 pb-4 pt-2 md:px-8">
      <div className="mx-auto max-w-3xl">
        {/* Attachment preview chips */}
        {pending.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-2">
            {pending.map(({ attachment: a, preview }) => (
              <div
                key={a.id}
                className="group relative flex items-center gap-2 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 p-2 pr-7 max-w-[240px]"
              >
                {a.kind === "image" && a.dataUrl ? (
                  <img
                    src={a.dataUrl}
                    alt={a.name}
                    className="h-10 w-10 rounded object-cover flex-shrink-0"
                  />
                ) : (
                  <div className="flex h-10 w-10 items-center justify-center rounded bg-zinc-100 dark:bg-zinc-700 flex-shrink-0">
                    <FileText className="h-4 w-4 text-zinc-500" />
                  </div>
                )}
                <div className="min-w-0 flex-1">
                  <p className="truncate text-xs font-medium text-zinc-800 dark:text-zinc-200">
                    {a.name}
                  </p>
                  <p className="text-[10px] text-zinc-500 dark:text-zinc-400">
                    {a.kind === "image" ? "Image" : "Text"} ·{" "}
                    {formatFileSize(a.size)}
                  </p>
                  {preview && (
                    <p className="mt-0.5 truncate text-[10px] text-zinc-400">
                      {preview}
                    </p>
                  )}
                </div>
                <button
                  onClick={() => removeAttachment(a.id)}
                  className="absolute right-1 top-1 rounded-full bg-zinc-200 dark:bg-zinc-700 p-0.5 hover:bg-zinc-300 dark:hover:bg-zinc-600"
                  aria-label="Remove attachment"
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            ))}
          </div>
        )}

        {errors.length > 0 && (
          <div className="mb-2 space-y-1">
            {errors.map((e, i) => (
              <p key={i} className="text-xs text-amber-600 dark:text-amber-400">
                ⚠ {e}
              </p>
            ))}
          </div>
        )}

        <div
          className={cn(
            "relative flex items-end gap-1 rounded-3xl border bg-white dark:bg-zinc-800 shadow-sm transition-colors",
            "border-zinc-200 dark:border-zinc-700",
            "focus-within:border-zinc-400 dark:focus-within:border-zinc-500"
          )}
        >
          {/* Hidden file input */}
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept="image/*,.txt,.md,.json,.csv,.tsv,.js,.jsx,.ts,.tsx,.py,.rb,.go,.rs,.java,.c,.cpp,.h,.hpp,.cs,.php,.swift,.kt,.scala,.sh,.bash,.yml,.yaml,.xml,.html,.htm,.css,.scss,.less,.sql,.graphql,.toml,.ini,.env,.log,.conf,text/*,application/json,application/xml"
            className="hidden"
            onChange={handleFileSelect}
          />

          {/* Attach button */}
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={pending.length >= MAX_FILES}
            className="ml-2 mb-2.5 flex h-9 w-9 items-center justify-center rounded-full text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            aria-label="Attach files"
            title="Attach files"
          >
            <Paperclip className="h-5 w-5" />
          </button>

          {/* YouTube button */}
          <button
            onClick={onOpenYouTube}
            disabled={isStreaming}
            className="mb-2.5 flex h-9 w-9 items-center justify-center rounded-full text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-700 hover:text-red-600 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            aria-label="Summarize YouTube video"
            title="Summarize a YouTube video"
          >
            <Youtube className="h-5 w-5" />
          </button>

          <Textarea
            ref={textareaRef}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Send a message, attach a file, or paste a YouTube URL…"
            rows={1}
            className="min-h-[52px] max-h-[200px] flex-1 resize-none border-0 bg-transparent px-2 py-3.5 text-[15px] leading-6 text-zinc-900 dark:text-zinc-100 placeholder:text-zinc-400 focus-visible:outline-none focus-visible:ring-0 focus-visible:ring-offset-0"
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
                disabled={!hasInput}
                className={cn(
                  "flex h-9 w-9 items-center justify-center rounded-full transition-colors",
                  hasInput
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
        <p className="mt-2 flex items-center justify-center gap-3 text-center text-xs text-zinc-400 dark:text-zinc-500">
          <span className="inline-flex items-center gap-1">
            <ImageIcon className="h-3 w-3" /> Images &amp; text files
          </span>
          <span className="inline-flex items-center gap-1">
            <Youtube className="h-3 w-3" /> YouTube summaries with timeline
          </span>
          <span className="hidden sm:inline">·</span>
          <span className="hidden sm:inline">AI can make mistakes.</span>
        </p>
      </div>
    </div>
  );
}
