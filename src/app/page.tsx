"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { PanelLeftOpen, Sparkles } from "lucide-react";
import { useChatStore, type ChatMessage } from "@/store/chat";
import { Sidebar } from "@/components/chat/Sidebar";
import { MessageBubble } from "@/components/chat/MessageBubble";
import { ChatInput } from "@/components/chat/ChatInput";
import { EmptyState } from "@/components/chat/EmptyState";
import { cn } from "@/lib/utils";

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
  const scrollRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Wait for zustand-persist to rehydrate from localStorage
  useEffect(() => {
    setHasHydrated(true);
  }, []);

  // Create an initial conversation on first load if none exists.
  // Only depend on hasHydrated — we want this to run exactly once after rehydration.
  useEffect(() => {
    if (!hasHydrated) return;
    const state = useChatStore.getState();
    if (state.conversations.length === 0) {
      state.createConversation();
    } else if (!state.activeId) {
      state.setActive(state.conversations[0].id);
    }
  }, [hasHydrated]);

  // Auto-scroll to bottom when messages change
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [conversations, activeId]);

  const activeConversation = conversations.find((c) => c.id === activeId);
  const messages = activeConversation?.messages ?? [];

  const sendMessage = useCallback(
    async (text: string) => {
      if (!text.trim()) return;

      // Get the current active conversation id, creating one if needed
      let convoId = activeId;
      if (!convoId) {
        convoId = createConversation();
      }

      const userMsg: ChatMessage = {
        id:
          Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        role: "user",
        content: text,
        createdAt: Date.now(),
      };
      appendMessage(convoId, userMsg);

      const assistantMsg: ChatMessage = {
        id:
          Date.now().toString(36) + Math.random().toString(36).slice(2, 6) +
          "a",
        role: "assistant",
        content: "",
        createdAt: Date.now(),
      };
      appendMessage(convoId, assistantMsg);

      setStreaming(true);
      const controller = new AbortController();
      abortRef.current = controller;

      try {
        // Build message history for the API (exclude the empty assistant placeholder)
        const history = useChatStore
          .getState()
          .conversations.find((c) => c.id === convoId)
          ?.messages.filter((m) => m.content !== "")
          .map((m) => ({ role: m.role, content: m.content })) ?? [];

        const res = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ messages: history }),
          signal: controller.signal,
        });

        if (!res.ok || !res.body) {
          throw new Error(`Request failed: ${res.status}`);
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let acc = "";
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          acc += decoder.decode(value, { stream: true });
          updateMessage(convoId, assistantMsg.id, acc);
        }
      } catch (err: unknown) {
        if ((err as Error)?.name === "AbortError") {
          // User stopped generation — keep whatever has accumulated.
        } else {
          const message =
            err instanceof Error ? err.message : "Something went wrong.";
          updateMessage(
            convoId,
            assistantMsg.id,
            `⚠️ ${message}`
          );
        }
      } finally {
        setStreaming(false);
        abortRef.current = null;
      }
    },
    [
      activeId,
      appendMessage,
      createConversation,
      setStreaming,
      updateMessage,
    ]
  );

  const handleStop = () => {
    abortRef.current?.abort();
    abortRef.current = null;
    setStreaming(false);
  };

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
        {/* Top bar */}
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

        {/* Message list / empty state */}
        <div ref={scrollRef} className="flex-1 overflow-y-auto chatgpt-scroll">
          {messages.length === 0 ? (
            <EmptyState onPickPrompt={(p) => sendMessage(p)} />
          ) : (
            <div className="pb-4">
              {messages.map((m, idx) => (
                <MessageBubble
                  key={m.id}
                  role={m.role}
                  content={m.content}
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

        {/* Input */}
        <ChatInput
          onSubmit={sendMessage}
          onStop={handleStop}
          isStreaming={isStreaming}
        />
      </div>
    </div>
  );
}
