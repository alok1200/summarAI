"use client";

import { useEffect, useState, useCallback, useMemo } from "react";
import { PanelLeftOpen, Sparkles, Loader2, Youtube, ChevronDown } from "lucide-react";
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
import { PasteTranscriptPanel } from "@/components/chat/PasteTranscriptPanel";
import { cn } from "@/lib/utils";
import {
  detectYouTubeUrl,
  detectLanguage,
  extractVideoIdFromUrl,
  extractInstructions,
} from "@/lib/youtube-url";
import { useStreamHandler, genId, type BotBlockedMeta } from "@/hooks/chat/useStreamHandler";
import { useRegenerate } from "@/hooks/chat/useRegenerate";
import { useAutoScroll } from "@/hooks/chat/useAutoScroll";

/**
 * State held when the server returns BOT_BLOCKED. The PasteTranscriptPanel
 * uses this to re-call /api/youtube-summary with the same URL + the pasted
 * transcript text, bypassing the IP block entirely.
 */
interface BotBlockedState {
  url: string;
  videoId: string;
  videoMeta?: BotBlockedMeta;
  instructions?: string;
  language?: string;
}

export default function Home() {
  const {
    conversations,
    activeId,
    isStreaming,
    createConversation,
    setActive,
    appendMessage,
    setVideoContext,
  } = useChatStore();

  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [hasHydrated, setHasHydrated] = useState(false);
  /**
   * Set when /api/youtube-summary returns BOT_BLOCKED. While set, the
   * PasteTranscriptPanel is shown above the chat input so the user can
   * paste the transcript text manually and bypass the IP block. Cleared
   * when the user submits the paste (re-dispatches to /api/youtube-summary
   * with the transcript param) or clicks Cancel.
   */
  const [botBlockedVideo, setBotBlockedVideo] = useState<BotBlockedState | null>(null);
  const { user, loading: authLoading, fetchMe } = useAuth();

  // ─── Effects ───────────────────────────────────────────────────────────
  // Verify the session cookie ONCE on the initial app load. After a
  // successful login, setUser() is called from the LoginScreen with the
  // user object returned by the POST response — at that point authLoading
  // is already false, so this effect skips the redundant (and potentially
  // failing) re-fetch that was previously kicking users back to the
  // login screen.
  useEffect(() => {
    if (authLoading) fetchMe();
    // Intentionally empty deps — we only want this to run on the very first
    // mount, not on every authLoading/fetchMe change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => setHasHydrated(true), []);

  // Create initial conversation if none exists after store hydration.
  useEffect(() => {
    if (!hasHydrated) return;
    const state = useChatStore.getState();
    if (state.conversations.length === 0) {
      state.createConversation();
    } else if (!state.activeId) {
      state.setActive(state.conversations[0].id);
    }
  }, [hasHydrated]);

  // ─── Streaming + regenerate hooks ──────────────────────────────────────
  const { runStream, stop } = useStreamHandler();
  const activeConversation = conversations.find((c) => c.id === activeId);
  const messages = activeConversation?.messages ?? [];
  const videoContext = activeConversation?.videoContext;

  const handleRegenerate = useRegenerate({
    activeConversationId: activeId ?? null,
    isStreaming,
    videoContext,
  });

  /**
   * Called when the user pastes a transcript into the PasteTranscriptPanel
   * and clicks "Summarize pasted transcript". Re-dispatches to
   * /api/youtube-summary with the same URL + the pasted transcript —
   * bypassing the YouTube IP block entirely because the summary route
   * skips the auto-fetch step when `transcript` is provided in the body.
   */
  const handlePasteTranscriptSubmit = useCallback(
    async (transcript: string) => {
      if (!botBlockedVideo) return;
      const { url, videoId, videoMeta, instructions, language } = botBlockedVideo;

      const userMsg: ChatMessage = {
        id: genId(),
        role: "user",
        content: `📋 Pasted transcript for ${url}${
          videoMeta?.title ? ` — ${videoMeta.title}` : ""
        } (${transcript.length} chars)`,
        createdAt: Date.now(),
        youtubeMeta: { url, videoId },
      };

      const apiPayload: Record<string, unknown> = {
        url,
        transcript,
        ...(instructions ? { instructions } : {}),
        ...(language ? { language } : {}),
      };

      // Clear the bot-blocked state so the panel disappears — we're
      // re-dispatching now, so showing both the panel and a new in-flight
      // assistant bubble would be confusing.
      setBotBlockedVideo(null);

      await runStream({
        userMessage: userMsg,
        endpoint: "/api/youtube-summary",
        payload: apiPayload,
        assistantPrefix: "⏳ Summarizing your pasted transcript…",
      });
    },
    [botBlockedVideo, runStream]
  );

  /**
   * Dismiss the PasteTranscriptPanel without re-dispatching. The user
   * already has the "rate-limited, try again later" message in the
   * assistant bubble; dismissing the panel just hides the paste UI.
   */
  const handlePasteTranscriptCancel = useCallback(() => {
    setBotBlockedVideo(null);
  }, []);

  // ─── Auto-scroll behavior ──────────────────────────────────────────────
  // Auto-scroll on new messages or new streamed chunks, but ONLY if the
  // user was already at the bottom. If they've scrolled up to read history,
  // we leave them in place — they can click the scroll-to-bottom button to
  // jump back down when ready.
  const { scrollRef, isAtBottom, scrollToBottom } = useAutoScroll({
    deps: [conversations, activeId],
  });

  // ─── Derived: active video ID for [MM:SS] linkification ────────────────
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

  // ─── Send-message dispatcher ───────────────────────────────────────────
  /**
   * Send a message. If the text contains a YouTube URL, auto-route to
   * /api/youtube-summary (no panel, no settings). Otherwise, send to
   * /api/chat with the full conversation history.
   *
   * This is the SINGLE entry point for all user-initiated messages —
   * typed text, suggested-prompt clicks, and the "Summarize video →" chip
   * all funnel through here.
   */
  const sendMessage = useCallback(
    async (text: string, attachments: Attachment[]) => {
      if (!text.trim() && attachments.length === 0) return;

      // ---------- YouTube URL auto-route ----------
      const ytUrl = detectYouTubeUrl(text);
      if (ytUrl && attachments.length === 0) {
        const language = detectLanguage(text);
        const remaining = extractInstructions(text, ytUrl);
        const videoId = extractVideoIdFromUrl(ytUrl);

        const meta: YouTubeMeta = { url: ytUrl, videoId };
        const userMsg: ChatMessage = {
          id: genId(),
          role: "user",
          content:
            `Summarize this YouTube video${
              language ? ` in ${language}` : ""
            }: ${ytUrl}` + (remaining ? `. ${remaining}` : ""),
          createdAt: Date.now(),
          youtubeMeta: meta,
        };

        const apiPayload: Record<string, unknown> = {
          url: ytUrl,
          // No startTime / endTime / transcript / instructions / language
          // unless the user explicitly provided them. Auto-fetch only.
          ...(remaining ? { instructions: remaining } : {}),
          ...(language ? { language } : {}),
        };

        await runStream({
          userMessage: userMsg,
          endpoint: "/api/youtube-summary",
          payload: apiPayload,
          assistantPrefix: "⏳ Fetching transcript and preparing summary…",
          // When YouTube rate-limits this server's IP, set the bot-blocked
          // state so the PasteTranscriptPanel appears below the chat input.
          // The user can then paste the transcript text manually and we'll
          // re-dispatch to /api/youtube-summary with the `transcript` param
          // — bypassing the IP block entirely.
          onBotBlocked: (_msg, meta) => {
            setBotBlockedVideo({
              url: ytUrl,
              videoId,
              videoMeta: meta,
              instructions: remaining || undefined,
              language: language || undefined,
            });
          },
        });
        return;
      }

      // ---------- Regular chat ----------
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

      await runStream({
        userMessage: userMsg,
        endpoint: "/api/chat",
        payload,
      });
    },
    [activeId, runStream]
  );

  // ─── Auth gate ─────────────────────────────────────────────────────────
  if (authLoading) {
    return (
      <div className="flex h-screen w-full items-center justify-center bg-white dark:bg-zinc-950">
        <Loader2 className="h-8 w-8 animate-spin text-zinc-400" />
      </div>
    );
  }
  if (!user) return <LoginScreen />;

  // ─── Render ────────────────────────────────────────────────────────────
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
          <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" />
          <div
            className="absolute left-0 top-0 h-full w-72 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <Sidebar onClose={() => setSidebarOpen(false)} />
          </div>
        </div>
      )}

      {/* Main area */}
      <div className="flex flex-1 flex-col min-w-0 relative">
        <header className="flex h-14 flex-shrink-0 items-center gap-2 border-b border-zinc-200 dark:border-zinc-800 px-3 md:px-4 bg-white/80 dark:bg-zinc-950/80 backdrop-blur-sm">
          {!sidebarOpen && (
            <button
              onClick={() => setSidebarOpen(true)}
              className="p-2 rounded-lg hover:bg-zinc-100 dark:hover:bg-zinc-900 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/40"
              aria-label="Open sidebar"
            >
              <PanelLeftOpen className="h-5 w-5 text-zinc-600 dark:text-zinc-300" />
            </button>
          )}
          <div className="flex items-center gap-2">
            <div className="flex h-6 w-6 items-center justify-center rounded-md bg-gradient-to-br from-emerald-400 to-emerald-600 shadow-sm">
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
                className="ml-auto shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200 hover:bg-white/60 dark:hover:bg-zinc-800/60 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/40"
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

        {/* Scroll-to-bottom button — appears when the user has scrolled up.
            Clicking it smooth-scrolls back to the latest message. */}
        <button
          type="button"
          onClick={scrollToBottom}
          aria-label="Scroll to latest message"
          className="scroll-bottom-btn absolute bottom-32 left-1/2 -translate-x-1/2 z-10 flex h-9 w-9 items-center justify-center rounded-full border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 shadow-md hover:shadow-lg hover:bg-zinc-50 dark:hover:bg-zinc-700 text-zinc-600 dark:text-zinc-300 transition-shadow"
          data-hidden={isAtBottom}
        >
          <ChevronDown className="h-4 w-4" />
        </button>

        {/* Bot-blocked fallback: paste-transcript panel. Shown when the
            server returned BOT_BLOCKED for a YouTube URL — lets the user
            paste the transcript text manually and bypass the IP block. */}
        {botBlockedVideo && (
          <PasteTranscriptPanel
            url={botBlockedVideo.url}
            videoMeta={botBlockedVideo.videoMeta}
            language={botBlockedVideo.language}
            instructions={botBlockedVideo.instructions}
            onSubmit={handlePasteTranscriptSubmit}
            onCancel={handlePasteTranscriptCancel}
          />
        )}

        {/* Chat input — always rendered. When the user pastes a YouTube URL,
            a "Summarize video →" chip appears above the input; clicking it
            sends the URL as a message, which sendMessage auto-routes to
            /api/youtube-summary. No panel, no second page, no settings. */}
        <ChatInput
          onSubmit={sendMessage}
          onStop={stop}
          isStreaming={isStreaming}
        />
      </div>
    </div>
  );
}
