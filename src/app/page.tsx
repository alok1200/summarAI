"use client";

import { useEffect, useRef, useState, useCallback, useMemo } from "react";
import { PanelLeftOpen, Sparkles, Loader2, Youtube } from "lucide-react";
import {
  useChatStore,
  type ChatMessage,
  type Attachment,
  type YouTubeMeta,
  type VideoContext,
} from "@/store/chat";
import { useAuth } from "@/store/auth";
import { Sidebar } from "@/components/chat/Sidebar";
import { MessageBubble } from "@/components/chat/MessageBubble";
import { ChatInput } from "@/components/chat/ChatInput";
import { EmptyState } from "@/components/chat/EmptyState";
import { LoginScreen } from "@/components/chat/LoginScreen";
import {
  YouTubeInlinePanel,
  type YouTubeSubmitPayload,
} from "@/components/chat/YouTubeInlinePanel";
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
    setVideoContext,
  } = useChatStore();

  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [hasHydrated, setHasHydrated] = useState(false);
  const [youtubeOpen, setYoutubeOpen] = useState(false);
  const [youtubeBotHint, setYoutubeBotHint] = useState<string | null>(null);
  /** Pre-filled URL for the YouTubeInlinePanel — set when the user clicks the
   * "Open YouTube dialog →" chip after pasting a YouTube link. */
  const [youtubeInitialUrl, setYoutubeInitialUrl] = useState<string | undefined>(undefined);
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
  const videoContext = activeConversation?.videoContext;

  /**
   * Compute the "active" YouTube video ID for linkifying [MM:SS] timestamps
   * in assistant messages. Preference order:
   *   1. The conversation's videoContext (ask-about-video mode)
   *   2. The most recent user message with a youtubeMeta (summary / interview mode)
   */
  const activeVideoId = useMemo<string | undefined>(() => {
    if (videoContext?.videoId) return videoContext.videoId;
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.role === "user" && m.youtubeMeta?.videoId) {
        return m.youtubeMeta.videoId;
      }
    }
    return undefined;
  }, [videoContext, messages]);

  /**
   * Regenerate the most recent assistant response: replace its content with
   * a placeholder and re-run the conversation through the same endpoint that
   * produced it the first time. We detect which endpoint by inspecting the
   * last user message — if it has youtubeMeta, dispatch based on its content
   * ("Generate N interview questions" → interview endpoint, "Summarize" →
   * summary endpoint, otherwise → /api/chat).
   */
  const handleRegenerate = useCallback(async () => {
    if (!activeConversation || isStreaming) return;
    const msgs = activeConversation.messages;
    if (msgs.length < 2) return;

    // Find the last assistant message and the user message right before it.
    let lastAssistantIdx = -1;
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].role === "assistant") {
        lastAssistantIdx = i;
        break;
      }
    }
    if (lastAssistantIdx <= 0) return;
    const lastUserMsg = msgs[lastAssistantIdx - 1];
    if (lastUserMsg.role !== "user") return;

    // Reset the assistant message content to a placeholder.
    const assistantMsgId = msgs[lastAssistantIdx].id;
    updateMessage(activeConversation.id, assistantMsgId, "⏳ Regenerating…");
    setStreaming(true);
    const controller = new AbortController();
    abortRef.current = controller;

    try {
      // Reconstruct the request — for /api/chat we send the full message
      // history up to (and including) the user message. For YouTube summary /
      // interview endpoints we don't have the original payload anymore, so we
      // just re-run /api/chat with the user's text content as the prompt.
      const priorMessages = msgs
        .slice(0, lastAssistantIdx + 1)
        .filter((m) => m.content.trim() !== "")
        .map((m) => ({
          role: m.role,
          content: m.content,
          attachments: m.attachments,
        }));

      const payload: Record<string, unknown> = { messages: priorMessages };
      if (videoContext) {
        payload.videoContext = {
          url: videoContext.url,
          videoId: videoContext.videoId,
          title: videoContext.title,
          author: videoContext.author,
          transcript: videoContext.transcript,
          chunks: videoContext.chunks,
          topicIndex: videoContext.topicIndex,
          language: videoContext.language,
        };
      }

      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      if (!res.ok || !res.body) {
        const errBody = await res.json().catch(() => ({}));
        throw new Error(errBody?.error || `Request failed: ${res.status}`);
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let acc = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        acc += decoder.decode(value, { stream: true });
        updateMessage(activeConversation.id, assistantMsgId, acc);
      }
      if (!acc.trim()) {
        updateMessage(
          activeConversation.id,
          assistantMsgId,
          "_(No response received.)_"
        );
      }
    } catch (err: unknown) {
      if ((err as Error)?.name === "AbortError") {
        // keep partial
      } else {
        const message =
          err instanceof Error ? err.message : "Something went wrong.";
        updateMessage(
          activeConversation.id,
          assistantMsgId,
          `⚠️ **Error:** ${message}`
        );
      }
    } finally {
      setStreaming(false);
      abortRef.current = null;
    }
  }, [activeConversation, isStreaming, setStreaming, updateMessage, videoContext]);

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

      // If the conversation has a video context ("ask about video" mode),
      // send it along so /api/chat can inject the transcript as the system
      // prompt and enforce the "only answer from the transcript" rule.
      const videoCtx = existing?.videoContext;

      const payload: Record<string, unknown> = {
        messages: [
          ...priorMessages,
          {
            role: "user" as const,
            content: text,
            attachments: attachments.length > 0 ? attachments : undefined,
          },
        ],
      };
      if (videoCtx) {
        payload.videoContext = {
          url: videoCtx.url,
          videoId: videoCtx.videoId,
          title: videoCtx.title,
          author: videoCtx.author,
          // For short videos: pass transcript directly.
          // For long videos: pass chunks + topicIndex instead (chat route
          // does retrieval to pick the most relevant chunks per question).
          transcript: videoCtx.transcript,
          chunks: videoCtx.chunks,
          topicIndex: videoCtx.topicIndex,
          // Persist the user's chosen language so every follow-up Q&A in
          // ask-about-video mode stays in that language.
          language: videoCtx.language,
        };
      }

      await runStream(userMsg, "/api/chat", payload);
    },
    [activeId, runStream]
  );

  const handleYouTube = useCallback(
    async (payload: YouTubeSubmitPayload) => {
      const startSec = parseTimeToSec(payload.startTime);
      const endSec = parseTimeToSec(payload.endTime);
      const isInterview = payload.mode === "interview";
      const isAsk = payload.mode === "ask";
      const isManual = !!payload.transcript;

      const meta: YouTubeMeta = {
        url: payload.url,
        videoId: payload.videoId,
        startTime: startSec,
        endTime: endSec,
        instructions: payload.instructions || undefined,
      };

      // ---------- "Ask about video" mode ----------
      // This mode is special: it doesn't stream a generated answer. Instead,
      // we fetch the transcript once via /api/youtube-load, store it as the
      // conversation's videoContext, and post a welcome message. Subsequent
      // chat messages in this conversation automatically include the
      // transcript as system context (see sendMessage above).
      if (isAsk) {
        let convoId = activeId;
        if (!convoId) {
          convoId = createConversation();
        }

        // User-side "loaded video" message
        const userMsg: ChatMessage = {
          id: genId(),
          role: "user",
          content:
            `Load this YouTube video so I can ask questions about it: ${payload.url}` +
            (startSec !== undefined || endSec !== undefined
              ? ` (from ${payload.startTime || "0:00"} to ${
                  payload.endTime || "end"
                })`
              : "") +
            (isManual ? " (using a transcript I pasted manually)" : "") +
            (payload.language
              ? ` — answer my questions in ${payload.language}`
              : ""),
          createdAt: Date.now(),
          youtubeMeta: meta,
        };
        appendMessage(convoId, userMsg);

        // Assistant placeholder while we fetch the transcript
        const assistantMsg: ChatMessage = {
          id: genId() + "a",
          role: "assistant",
          content: isManual
            ? "⏳ Loading your pasted transcript…"
            : "⏳ Fetching transcript from YouTube…",
          createdAt: Date.now(),
        };
        appendMessage(convoId, assistantMsg);
        setStreaming(true);

        try {
          const res = await fetch("/api/youtube-load", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              url: payload.url,
              startTime: payload.startTime,
              endTime: payload.endTime,
              transcript: payload.transcript,
              language: payload.language,
            }),
          });

          if (!res.ok) {
            let errMsg = `Request failed: ${res.status}`;
            let errCode: string | undefined;
            let errMeta:
              | { title?: string; author?: string; thumbnailUrl?: string }
              | undefined;
            try {
              const errBody = await res.json();
              if (errBody?.error) errMsg = errBody.error;
              errCode = errBody?.code;
              errMeta = errBody?.videoMeta;
            } catch {
              // ignore
            }
            if (errCode === "BOT_BLOCKED") {
              // Reopen dialog so the user can paste manually
              setYoutubeBotHint(errMsg);
              setYoutubeOpen(true);
              const metaLine = errMeta?.title
                ? `**Video:** ${errMeta.title}${
                    errMeta.author ? ` — ${errMeta.author}` : ""
                  }\n\n`
                : "";
              updateMessage(
                convoId,
                assistantMsg.id,
                `⚠️ **YouTube blocked the auto-fetch for this video.**\n\n` +
                  metaLine +
                  `Please switch to **"Paste transcript manually"** in the dialog and try again.`
              );
            } else {
              updateMessage(
                convoId,
                assistantMsg.id,
                `⚠️ **Error:** ${errMsg}`
              );
            }
            return;
          }

          const data = (await res.json()) as {
            title: string;
            author: string;
            url: string;
            videoId: string;
            transcript: string | null;
            chunks: any[] | null;
            topicIndex: string | null;
            segmentCount: number;
            startTime: number;
            endTime: number;
            rangeNote?: string;
            isManual: boolean;
          };

          // Store the transcript (or chunks + topicIndex for long videos) as
          // the conversation's video context so subsequent chat messages get
          // it injected automatically. Also persist the user's chosen language
          // so every follow-up Q&A in this conversation stays in that language.
          const ctx: VideoContext = {
            url: data.url,
            videoId: data.videoId,
            title: data.title,
            author: data.author,
            transcript: data.transcript ?? undefined,
            chunks: data.chunks ?? undefined,
            topicIndex: data.topicIndex ?? undefined,
            loadedAt: Date.now(),
            language: payload.language,
          };
          setVideoContext(convoId, ctx);

          // Welcome message with clear instructions
          const mins = Math.round(
            (data.endTime - data.startTime) / 60
          );
          const isLong = !!(data.chunks && data.chunks.length > 0);
          const transcriptDesc = isLong
            ? `${data.segmentCount} segments · ~${mins} min · split into ${data.chunks!.length} chunks for fast retrieval`
            : `${data.segmentCount} segments${mins > 0 ? ` · ~${mins} min` : ""}`;
          const welcomeContent =
            `✅ **Video loaded — ask me anything about it!**\n\n` +
            `**Title:** ${data.title}\n` +
            `**Channel:** ${data.author}\n` +
            `**URL:** ${data.url}\n` +
            `**Transcript:** ${transcriptDesc}${data.isManual ? " (manual paste)" : ""}\n` +
            (data.rangeNote ? `**Note:** ${data.rangeNote}\n` : "") +
            (payload.language
              ? `**Response language:** ${payload.language} — every answer in this conversation will be in ${payload.language} (timestamps, code, and tool names stay in their original form).\n`
              : "") +
            (isLong
              ? `**Long video mode:** I built a topic index in parallel and will retrieve the most relevant chunks for each question — so even a 50-hour video can be queried accurately and fast.\n`
              : "") +
            `\n---\n\n` +
            `I'll answer your questions **only** based on what's in this video's transcript. ` +
            `If you ask about something that isn't covered in the video, I'll let you know.\n\n` +
            `**Try asking:**\n` +
            `- "What is the main topic of this video?"\n` +
            `- "Summarize the key points"\n` +
            `- "What did they say about X?"\n` +
            `- "Explain the part at [MM:SS]"\n\n` +
            `Go ahead and type your question below 👇`;
          updateMessage(convoId, assistantMsg.id, welcomeContent);
        } catch (err: unknown) {
          const message =
            err instanceof Error ? err.message : "Something went wrong.";
          updateMessage(
            convoId,
            assistantMsg.id,
            `⚠️ **Error:** ${message}`
          );
        } finally {
          setStreaming(false);
        }
        return;
      }

      // ---------- Summary / Interview modes (streaming) ----------
      const langPart = payload.language
        ? ` — respond in ${payload.language}`
        : "";
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
          (payload.instructions ? `. Instructions: ${payload.instructions}` : ".") +
          langPart;
      } else {
        userMsgContent =
          `Summarize this YouTube video` +
          (startSec !== undefined || endSec !== undefined
            ? ` from ${payload.startTime || "0:00"} to ${
                payload.endTime || "end"
              }`
            : "") +
          (isManual ? " (using a transcript I pasted manually)" : "") +
          (payload.instructions ? `. Instructions: ${payload.instructions}` : ".") +
          langPart;
      }

      const userMsg: ChatMessage = {
        id: genId(),
        role: "user",
        content: userMsgContent,
        createdAt: Date.now(),
        youtubeMeta: meta,
      };

      const apiPayload: Record<string, unknown> = {
        url: payload.url,
        startTime: payload.startTime,
        endTime: payload.endTime,
        instructions: payload.instructions,
        transcript: payload.transcript,
        language: payload.language,
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
        setYoutubeBotHint(botMessage);
        setYoutubeOpen(true);
      });
    },
    [activeId, appendMessage, createConversation, runStream, setStreaming, setVideoContext, updateMessage]
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
            <span className="text-sm font-semibold text-zinc-800 dark:text-zinc-100 tracking-tight">
              Summar<span className="text-emerald-500">AI</span>
            </span>
          </div>
        </header>

        {/* Video-context banner — only shown when this conversation has a
            loaded video (i.e., the user picked "Ask about video" mode). */}
        {videoContext && (
          <div className="flex-shrink-0 border-b border-zinc-200 dark:border-zinc-800 bg-gradient-to-r from-red-50 to-amber-50 dark:from-red-950/30 dark:to-amber-950/30 px-4 py-2">
            <div className="mx-auto max-w-3xl flex items-center gap-2 text-xs">
              <Youtube className="h-3.5 w-3.5 text-red-600 dark:text-red-400 shrink-0" />
              <span className="text-zinc-700 dark:text-zinc-300 truncate">
                <span className="font-semibold">Ask-about-video mode:</span>{" "}
                <span className="text-zinc-600 dark:text-zinc-400">
                  {videoContext.title}
                </span>
              </span>
              <button
                type="button"
                onClick={() => {
                  if (activeId) setVideoContext(activeId, null);
                }}
                className="ml-auto shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200 hover:bg-white/60 dark:hover:bg-zinc-800/60 transition-colors"
                title="Exit ask-about-video mode and return to normal chat"
              >
                ✕ Exit video mode
              </button>
            </div>
          </div>
        )}

        <div ref={scrollRef} className="flex-1 overflow-y-auto chatgpt-scroll">
          {messages.length === 0 ? (
            <EmptyState onPickPrompt={(p) => sendMessage(p, [])} />
          ) : (
            <div className="pb-4">
              {messages.map((m, idx) => {
                // The latest "completed" assistant response is eligible for
                // the Regenerate button. We consider it regeneratable if:
                //   - it's an assistant message
                //   - we're not currently streaming
                //   - it's the last message, OR it's second-to-last and the
                //     last message is a user message (waiting for response)
                const isRegeneratable =
                  m.role === "assistant" &&
                  !isStreaming &&
                  (idx === messages.length - 1 ||
                    (idx === messages.length - 2 &&
                      messages[messages.length - 1].role === "user"));
                return (
                  <MessageBubble
                    key={m.id}
                    role={m.role}
                    content={m.content}
                    attachments={m.attachments}
                    youtubeMeta={m.youtubeMeta}
                    videoId={activeVideoId}
                    isStreaming={
                      isStreaming &&
                      idx === messages.length - 1 &&
                      m.role === "assistant"
                    }
                    isLatestAssistant={isRegeneratable}
                    onRegenerate={
                      isRegeneratable ? handleRegenerate : undefined
                    }
                  />
                );
              })}
            </div>
          )}
        </div>

        {/* INLINE YouTube panel — replaces ChatInput when open so the user
            fills in URL + mode + time range + instructions all on the same
            page, with no second modal. The panel renders above where the
            chat input normally lives; closing the panel brings the input
            back. */}
        {youtubeOpen ? (
          <YouTubeInlinePanel
            open={youtubeOpen}
            onClose={() => {
              setYoutubeOpen(false);
              setYoutubeInitialUrl(undefined);
            }}
            onSubmit={handleYouTube}
            botBlockedHint={youtubeBotHint}
            onClearHint={() => setYoutubeBotHint(null)}
            initialUrl={youtubeInitialUrl}
          />
        ) : (
          <ChatInput
            onSubmit={sendMessage}
            onStop={handleStop}
            onOpenYouTube={(prefilledUrl) => {
              setYoutubeInitialUrl(prefilledUrl);
              setYoutubeOpen(true);
            }}
            isStreaming={isStreaming}
          />
        )}
      </div>
    </div>
  );
}

function parseTimeToSec(s: string): number | undefined {
  // Local display-only parser. Mirrors the backend `parseTimeString` rule:
  // a bare number means MINUTES (so "5" = 5 min = 300s), not seconds.
  // The backend re-parses the raw string anyway, so this only affects what
  // we store in `meta.startTime` for display in the chat bubble.
  const trimmed = s.trim();
  if (!trimmed) return undefined;

  // Honor explicit unit suffixes (5m, 90s, 1h, 1h30m, 2h15m30s).
  if (/[hms]/i.test(trimmed) && /^[\d\s.:hms]+$/i.test(trimmed)) {
    const h = trimmed.match(/(\d+)\s*h/i);
    const m = trimmed.match(/(\d+)\s*m/i);
    const sec = trimmed.match(/(\d+)\s*s/i);
    if (h || m || sec) {
      let total = 0;
      if (h) total += parseInt(h[1], 10) * 3600;
      if (m) total += parseInt(m[1], 10) * 60;
      if (sec) total += parseInt(sec[1], 10);
      return total;
    }
  }

  const parts = trimmed.split(":").map((p) => parseInt(p, 10));
  if (parts.some((n) => isNaN(n))) return undefined;
  if (parts.length === 1) return parts[0] * 60; // bare number = minutes
  if (parts.length === 2) return parts[0] * 60 + parts[1]; // M:SS
  if (parts.length === 3)
    return parts[0] * 3600 + parts[1] * 60 + parts[2]; // H:MM:SS
  return undefined;
}
