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
import { cn } from "@/lib/utils";

/**
 * Detect a YouTube URL anywhere in a string and return it (with any
 * trailing URL chars). Returns null if no YouTube URL is present.
 *
 * Used by sendMessage to auto-route pasted YouTube links to the summary
 * endpoint — no panel, no settings, just paste & summarize.
 */
function detectYouTubeUrl(text: string): string | null {
  const patterns: RegExp[] = [
    /(?:youtube\.com\/watch\?v=)([A-Za-z0-9_-]{11})/,
    /(?:youtu\.be\/)([A-Za-z0-9_-]{11})/,
    /(?:youtube\.com\/embed\/)([A-Za-z0-9_-]{11})/,
    /(?:youtube\.com\/shorts\/)([A-Za-z0-9_-]{11})/,
    /(?:youtube\.com\/live\/)([A-Za-z0-9_-]{11})/,
  ];
  for (const p of patterns) {
    if (p.test(text)) {
      const fullMatch = text.match(
        /https?:\/\/[^\s]+?(?:youtube\.com\/watch\?v=[A-Za-z0-9_-]+|youtu\.be\/[A-Za-z0-9_-]+|youtube\.com\/(?:embed|shorts|live)\/[A-Za-z0-9_-]+)[^\s]*/
      );
      return fullMatch?.[0] ?? null;
    }
  }
  return null;
}

/**
 * Extract an optional language hint from a user message. Looks for the
 * pattern "in <Language>" near the end of the message, where <Language> is
 * a capitalized word (e.g. "in Hindi", "in Spanish", "in French").
 * Returns the language name, or undefined if no language is specified.
 *
 * This lets the user type "summarize this in Hindi: <URL>" and have the
 * entire response generated in Hindi — without needing a settings panel.
 */
function detectLanguage(text: string): string | undefined {
  const m = text.match(/\bin\s+([A-Z][a-zA-Z]{2,})\b/);
  if (!m) return undefined;
  const lang = m[1].trim();
  // Filter out obvious false positives (e.g. "in JavaScript", "in Python").
  const falsePositives = new Set([
    "JavaScript", "TypeScript", "Python", "Java", "React", "Vue",
    "Angular", "Node", "Rust", "Go", "Swift", "Kotlin", "Ruby",
    "PHP", "C++", "C#",
  ]);
  if (falsePositives.has(lang)) return undefined;
  return lang;
}

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
            // Replace the placeholder assistant message with a graceful,
            // honest "try again later" note. The manual-paste fallback was
            // removed from the UI — we no longer ask the user to paste the
            // transcript themselves. Instead we explain what happened and
            // suggest the two paths that actually work: retry, or try a
            // different video.
            const metaLine = errMeta?.title
              ? `**Video:** ${errMeta.title}${errMeta.author ? ` — ${errMeta.author}` : ""}\n\n`
              : "";
            updateMessage(
              convoId,
              assistantMsg.id,
              `⚠️ **We couldn't auto-fetch this video's transcript.**\n\n` +
                metaLine +
                `YouTube is rate-limiting this server right now and asking us to confirm ` +
                `we're not a bot. This is temporary and usually clears within a few minutes.\n\n` +
                `**What you can do:**\n` +
                `- **Try again in a few minutes** — most blocks clear on their own.\n` +
                `- **Try a different video** — blocks are IP- and video-specific, so another ` +
                `video usually works fine.\n\n` +
                `You can click the timestamp badge above to open the video on YouTube while you wait.`
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

      // ---------- YouTube URL auto-route ----------
      // If the user's message contains a YouTube URL, skip the chat endpoint
      // entirely and send it straight to /api/youtube-summary. This is the
      // "one page, no panel" flow: paste URL → click send → get summary.
      //
      // We also detect an optional "in <Language>" hint in the message so the
      // user can write "summarize this in Hindi: <URL>" and the entire
      // response will be in Hindi. The remaining text (minus URL + language
      // hint) becomes the `instructions` field if non-empty.
      const ytUrl = detectYouTubeUrl(text);
      if (ytUrl && attachments.length === 0) {
        const language = detectLanguage(text);
        // Strip the URL and "in <Lang>" from the message to extract any
        // remaining user instructions (e.g. "focus on the React parts").
        const remaining = text
          .replace(ytUrl, "")
          .replace(/\bin\s+[A-Z][a-zA-Z]{2,}\b/g, "")
          .replace(/^(summarize|summarise|tl;?dr|summary of|summarize this|summarize this video|summarize this for me)[:\s,]*/i, "")
          .trim();

        // Extract video ID for the meta badge on the user's message bubble.
        const vidMatch = ytUrl.match(/(?:youtube\.com\/(?:watch\?v=|embed\/|shorts\/|live\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/);
        const videoId = vidMatch?.[1] ?? "";

        const meta: YouTubeMeta = {
          url: ytUrl,
          videoId,
        };

        const userMsg: ChatMessage = {
          id: genId(),
          role: "user",
          content:
            `Summarize this YouTube video${language ? ` in ${language}` : ""}: ${ytUrl}` +
            (remaining ? `. ${remaining}` : ""),
          createdAt: Date.now(),
          youtubeMeta: meta,
        };

        const apiPayload: Record<string, unknown> = {
          url: ytUrl,
          // No startTime / endTime / transcript / instructions / language
          // unless the user explicitly provided them. Auto-fetch only —
          // the user said "don't ask me", so we just go.
          ...(remaining ? { instructions: remaining } : {}),
          ...(language ? { language } : {}),
        };

        await runStream(
          userMsg,
          "/api/youtube-summary",
          apiPayload,
          "⏳ Fetching transcript and preparing summary…",
          // Bot-blocked callback. The manual-paste panel was removed, so
          // there's no UI to reopen on a bot-block — runStream itself writes
          // the graceful "try again later" message into the assistant bubble.
          // We still pass a no-op here so runStream knows to take that branch
          // (it gates the BOT_BLOCKED message on `onBotBlocked` being truthy).
          () => {}
        );
        return;
      }

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

        {/* Chat input — always rendered. When the user pastes a YouTube URL,
            a "Summarize video →" chip appears above the input; clicking it
            sends the URL as a message, which sendMessage auto-routes to
            /api/youtube-summary. No panel, no second page, no settings. */}
        <ChatInput
          onSubmit={sendMessage}
          onStop={handleStop}
          isStreaming={isStreaming}
        />
      </div>
    </div>
  );
}

