"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { PanelLeftOpen, Sparkles, Loader2 } from "lucide-react";
import {
  useChatStore,
  type ChatMessage,
  type Attachment,
  type YouTubeMeta,
} from "@/store/chat";
import { useAuth } from "@/store/auth";
import { Sidebar } from "@/components/chat/Sidebar";
import { MessageBubble } from "@/components/chat/MessageBubble";
import { ChatInput } from "@/components/chat/ChatInput";
import { EmptyState } from "@/components/chat/EmptyState";
import { LoginScreen } from "@/components/chat/LoginScreen";
import {
  YouTubeDialog,
  type YouTubeSubmitPayload,
} from "@/components/chat/YouTubeDialog";
import { cn } from "@/lib/utils";

function genId() {
  return (
    Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
  );
}

export default function Home() {
  const {
    conversations,
    activeId,
    isStreaming,
    createConversation,
    setActive,
    appendMessage,
    updateMessage,
    setStreaming,
  } = useChatStore();

  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [hasHydrated, setHasHydrated] = useState(false);
  const [youtubeOpen, setYoutubeOpen] = useState(false);
  const [youtubeBotHint, setYoutubeBotHint] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  const { user, loading: authLoading, fetchMe } = useAuth();

  // Verify the session cookie ONCE on the initial app load. After a
  // successful login, setUser() is called from the LoginScreen with the
  // user object returned by the POST response — at that point authLoading
  // is already false, so this effect skips the redundant (and potentially
  // failing) re-fetch that was previously kicking users back to the
  // login screen.
  useEffect(() => {
    if (authLoading) {
      fetchMe();
    }
    // Intentionally empty deps — we only want this to run on the very first
    // mount, not on every authLoading/fetchMe change.
  }, []);

  useEffect(() => {
    setHasHydrated(true);
  }, []);

  useEffect(() => {
    if (!hasHydrated) return;
    const state = useChatStore.getState();
    if (state.conversations.length === 0) {
      state.createConversation();
    } else if (!state.activeId) {
      state.setActive(state.conversations[0].id);
    }
  }, [hasHydrated]);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [conversations, activeId]);

  const activeConversation = conversations.find((c) => c.id === activeId);
  const messages = activeConversation?.messages ?? [];

  /**
   * Core streaming helper: appends a user message + empty assistant message,
   * then POSTs to `endpoint` with `payload`, streaming the response into the
   * assistant placeholder.
   *
   * If the server responds with `{ code: "BOT_BLOCKED" }`, this helper calls
   * `onBotBlocked` instead of writing an error into the message bubble.
   */
  const runStream = useCallback(
    async (
      userMessage: ChatMessage,
      endpoint: string,
      payload: unknown,
      assistantPrefix?: string,
      onBotBlocked?: (message: string) => void
    ) => {
      let convoId = activeId;
      if (!convoId) {
        convoId = createConversation();
      }

      appendMessage(convoId, userMessage);

      const assistantMsg: ChatMessage = {
        id: genId() + "a",
        role: "assistant",
        content: assistantPrefix ?? "",
        createdAt: Date.now(),
      };
      appendMessage(convoId, assistantMsg);

      setStreaming(true);
      const controller = new AbortController();
      abortRef.current = controller;

      try {
        const res = await fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
          signal: controller.signal,
        });

        if (!res.ok) {
          let errMsg = `Request failed: ${res.status}`;
          let errCode: string | undefined;
          let errMeta: { title?: string; author?: string; thumbnailUrl?: string } | undefined;
          try {
            const errBody = await res.json();
            if (errBody?.error) errMsg = errBody.error;
            errCode = errBody?.code;
            errMeta = errBody?.videoMeta;
          } catch {
            // ignore parse error
          }
          if (errCode === "BOT_BLOCKED" && onBotBlocked) {
            onBotBlocked(errMsg);
            // Replace the placeholder assistant message with a helpful note
            // that includes the video title (when available) so the user has
            // confirmation that this is the right video.
            const metaLine = errMeta?.title
              ? `**Video:** ${errMeta.title}${errMeta.author ? ` — ${errMeta.author}` : ""}\n\n`
              : "";
            updateMessage(
              convoId,
              assistantMsg.id,
              `⚠️ **YouTube blocked the auto-fetch for this video.**\n\n` +
                metaLine +
                `YouTube is asking us to sign in to confirm we're not a bot — ` +
                `this happens on videos with stricter bot protection (music videos, ` +
                `TED talks, livestreams, etc.).\n\n` +
                `**How to still get your summary:**\n` +
                `1. Click the **"Open video on YouTube"** button in the dialog (or open the video yourself)\n` +
                `2. Below the video, click **"… More"** → **"Show transcript"**\n` +
                `3. Copy the transcript text from the panel that opens\n` +
                `4. Paste it into the **"Paste transcript manually"** box in the dialog\n` +
                `5. Click **Summarize** — you'll get your summary in seconds`
            );
          } else {
            throw new Error(errMsg);
          }
          return;
        }
        if (!res.body) throw new Error("No response body");

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let acc = assistantPrefix ?? "";
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          acc += decoder.decode(value, { stream: true });
          updateMessage(convoId, assistantMsg.id, acc);
        }
        if (!acc.trim()) {
          updateMessage(
            convoId,
            assistantMsg.id,
            "_(No response received.)_"
          );
        }
      } catch (err: unknown) {
        if ((err as Error)?.name === "AbortError") {
          // keep whatever we have so far
        } else {
          const message =
            err instanceof Error ? err.message : "Something went wrong.";
          updateMessage(
            convoId,
            assistantMsg.id,
            `⚠️ **Error:** ${message}`
          );
        }
      } finally {
        setStreaming(false);
        abortRef.current = null;
      }
    },
    [activeId, appendMessage, createConversation, setStreaming, updateMessage]
  );

  const sendMessage = useCallback(
    async (text: string, attachments: Attachment[]) => {
      if (!text.trim() && attachments.length === 0) return;

      const userMsg: ChatMessage = {
        id: genId(),
        role: "user",
        content: text,
        createdAt: Date.now(),
        attachments: attachments.length > 0 ? attachments : undefined,
      };

      // Build the payload from current conversation history + new user message.
      const state = useChatStore.getState();
      const convoId = activeId ?? state.conversations[0]?.id;
      const existing = state.conversations.find((c) => c.id === convoId);
      const priorMessages = (existing?.messages ?? [])
        .filter((m) => m.content.trim() !== "")
        .map((m) => ({
          role: m.role,
          content: m.content,
          attachments: m.attachments,
        }));

      const payload = {
        messages: [
          ...priorMessages,
          {
            role: "user" as const,
            content: text,
            attachments: attachments.length > 0 ? attachments : undefined,
          },
        ],
      };

      await runStream(userMsg, "/api/chat", payload);
    },
    [activeId, runStream]
  );

  const handleYouTube = useCallback(
    async (payload: YouTubeSubmitPayload) => {
      const startSec = parseTimeToSec(payload.startTime);
      const endSec = parseTimeToSec(payload.endTime);
      const isInterview = payload.mode === "interview";
      const isManual = !!payload.transcript;

      const meta: YouTubeMeta = {
        url: payload.url,
        videoId: payload.videoId,
        startTime: startSec,
        endTime: endSec,
        instructions: payload.instructions || undefined,
      };

      // Build a human-readable summary of what the user asked for.
      let userMsgContent: string;
      if (isInterview) {
        const opts = payload.interviewOptions;
        const rolePart = opts?.targetRole ? ` for a ${opts.targetRole} role` : "";
        const countPart = opts ? `${opts.questionCount}` : "15";
        const typePart = opts?.interviewType ? ` ${opts.interviewType}` : "";
        const diffPart = opts?.difficulty ? ` at ${opts.difficulty} difficulty` : "";
        userMsgContent =
          `Generate ${countPart}${typePart} interview questions and answers${rolePart}${diffPart} from this YouTube video` +
          (startSec !== undefined || endSec !== undefined
            ? ` from ${payload.startTime || "0:00"} to ${
                payload.endTime || "end"
              }`
            : "") +
          (isManual ? " (using a transcript I pasted manually)" : "") +
          (payload.instructions ? `. Instructions: ${payload.instructions}` : ".");
      } else {
        userMsgContent =
          `Summarize this YouTube video` +
          (startSec !== undefined || endSec !== undefined
            ? ` from ${payload.startTime || "0:00"} to ${
                payload.endTime || "end"
              }`
            : "") +
          (isManual ? " (using a transcript I pasted manually)" : "") +
          (payload.instructions ? `. Instructions: ${payload.instructions}` : ".");
      }

      const userMsg: ChatMessage = {
        id: genId(),
        role: "user",
        content: userMsgContent,
        createdAt: Date.now(),
        youtubeMeta: meta,
      };

      // Build the API payload — shared fields + mode-specific fields.
      const apiPayload: Record<string, unknown> = {
        url: payload.url,
        startTime: payload.startTime,
        endTime: payload.endTime,
        instructions: payload.instructions,
        transcript: payload.transcript,
      };
      if (isInterview && payload.interviewOptions) {
        apiPayload.difficulty = payload.interviewOptions.difficulty;
        apiPayload.questionCount = payload.interviewOptions.questionCount;
        apiPayload.interviewType = payload.interviewOptions.interviewType;
        apiPayload.targetRole = payload.interviewOptions.targetRole;
      }

      const endpoint = isInterview
        ? "/api/youtube-interview"
        : "/api/youtube-summary";

      const placeholder = isManual
        ? isInterview
          ? "⏳ Generating interview Q&A from your pasted transcript…"
          : "⏳ Summarizing your pasted transcript…"
        : isInterview
        ? "⏳ Fetching transcript and generating interview Q&A…"
        : "⏳ Fetching transcript and preparing summary…";

      await runStream(userMsg, endpoint, apiPayload, placeholder, (botMessage) => {
        // Auto-reopen the dialog with the bot-blocked hint so the user can
        // paste the transcript manually.
        setYoutubeBotHint(botMessage);
        setYoutubeOpen(true);
      });
    },
    [runStream]
  );

  const handleStop = () => {
    abortRef.current?.abort();
    abortRef.current = null;
    setStreaming(false);
  };

  // Auth gate: show loading spinner while checking session, show login screen if not authed
  if (authLoading) {
    return (
      <div className="flex h-screen w-full items-center justify-center bg-white dark:bg-zinc-950">
        <Loader2 className="h-8 w-8 animate-spin text-zinc-400" />
      </div>
    );
  }
  if (!user) {
    return <LoginScreen />;
  }

  return (
    <div className="flex h-screen w-full overflow-hidden bg-white dark:bg-zinc-950">
      {/* Desktop sidebar */}
      <div
        className={cn(
          "hidden md:flex flex-shrink-0 transition-all duration-200",
          sidebarOpen ? "w-72" : "w-0"
        )}
        style={{ overflow: "hidden" }}
      >
        <div className="w-72 h-full">
          <Sidebar onClose={() => setSidebarOpen(false)} />
        </div>
      </div>

      {/* Mobile sidebar drawer */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 z-40 md:hidden"
          onClick={() => setSidebarOpen(false)}
        >
          <div className="absolute inset-0 bg-black/40" />
          <div
            className="absolute left-0 top-0 h-full w-72 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <Sidebar onClose={() => setSidebarOpen(false)} />
          </div>
        </div>
      )}

      {/* Main area */}
      <div className="flex flex-1 flex-col min-w-0">
        <header className="flex h-14 flex-shrink-0 items-center gap-2 border-b border-zinc-200 dark:border-zinc-800 px-3 md:px-4">
          {!sidebarOpen && (
            <button
              onClick={() => setSidebarOpen(true)}
              className="p-2 rounded-lg hover:bg-zinc-100 dark:hover:bg-zinc-900 transition-colors"
              aria-label="Open sidebar"
            >
              <PanelLeftOpen className="h-5 w-5 text-zinc-600 dark:text-zinc-300" />
            </button>
          )}
          <div className="flex items-center gap-2">
            <div className="flex h-6 w-6 items-center justify-center rounded-md bg-gradient-to-br from-emerald-400 to-emerald-600">
              <Sparkles className="h-3.5 w-3.5 text-white" />
            </div>
            <span className="text-sm font-semibold text-zinc-800 dark:text-zinc-100">
              ChatGPT
            </span>
            <span className="rounded-md bg-zinc-100 dark:bg-zinc-800 px-1.5 py-0.5 text-[10px] font-medium text-zinc-500 dark:text-zinc-400">
              Z.ai
            </span>
          </div>
        </header>

        <div ref={scrollRef} className="flex-1 overflow-y-auto chatgpt-scroll">
          {messages.length === 0 ? (
            <EmptyState onPickPrompt={(p) => sendMessage(p, [])} />
          ) : (
            <div className="pb-4">
              {messages.map((m, idx) => (
                <MessageBubble
                  key={m.id}
                  role={m.role}
                  content={m.content}
                  attachments={m.attachments}
                  youtubeMeta={m.youtubeMeta}
                  isStreaming={
                    isStreaming &&
                    idx === messages.length - 1 &&
                    m.role === "assistant"
                  }
                />
              ))}
            </div>
          )}
        </div>

        <ChatInput
          onSubmit={sendMessage}
          onStop={handleStop}
          onOpenYouTube={() => setYoutubeOpen(true)}
          isStreaming={isStreaming}
        />
      </div>

      <YouTubeDialog
        open={youtubeOpen}
        onOpenChange={setYoutubeOpen}
        onSubmit={handleYouTube}
        botBlockedHint={youtubeBotHint}
        onClearHint={() => setYoutubeBotHint(null)}
      />
    </div>
  );
}

function parseTimeToSec(s: string): number | undefined {
  const trimmed = s.trim();
  if (!trimmed) return undefined;
  const parts = trimmed.split(":").map((p) => parseInt(p, 10));
  if (parts.some((n) => isNaN(n))) return undefined;
  if (parts.length === 1) return parts[0];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return undefined;
}
