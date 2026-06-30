"use client";

import { create } from "zustand";
import { persist } from "zustand/middleware";

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: number;
}

export interface Conversation {
  id: string;
  title: string;
  messages: ChatMessage[];
  createdAt: number;
  updatedAt: number;
}

interface ChatState {
  conversations: Conversation[];
  activeId: string | null;
  isStreaming: boolean;

  // selectors / actions
  createConversation: () => string;
  deleteConversation: (id: string) => void;
  renameConversation: (id: string, title: string) => void;
  setActive: (id: string) => void;
  appendMessage: (conversationId: string, message: ChatMessage) => void;
  updateMessage: (
    conversationId: string,
    messageId: string,
    content: string
  ) => void;
  setStreaming: (streaming: boolean) => void;
  clearAll: () => void;
}

function genId() {
  return (
    Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
  );
}

function deriveTitle(text: string) {
  const trimmed = text.trim().replace(/\s+/g, " ");
  if (!trimmed) return "New chat";
  return trimmed.length > 40 ? trimmed.slice(0, 40) + "…" : trimmed;
}

export const useChatStore = create<ChatState>()(
  persist(
    (set) => ({
      conversations: [],
      activeId: null,
      isStreaming: false,

      createConversation: () => {
        const id = genId();
        const now = Date.now();
        const convo: Conversation = {
          id,
          title: "New chat",
          messages: [],
          createdAt: now,
          updatedAt: now,
        };
        set((s) => ({
          conversations: [convo, ...s.conversations],
          activeId: id,
        }));
        return id;
      },

      deleteConversation: (id) =>
        set((s) => {
          const conversations = s.conversations.filter((c) => c.id !== id);
          const activeId =
            s.activeId === id
              ? conversations[0]?.id ?? null
              : s.activeId;
          return { conversations, activeId };
        }),

      renameConversation: (id, title) =>
        set((s) => ({
          conversations: s.conversations.map((c) =>
            c.id === id ? { ...c, title: title || "New chat" } : c
          ),
        })),

      setActive: (id) => set({ activeId: id }),

      appendMessage: (conversationId, message) =>
        set((s) => ({
          conversations: s.conversations.map((c) => {
            if (c.id !== conversationId) return c;
            const messages = [...c.messages, message];
            const title =
              c.title === "New chat" && message.role === "user"
                ? deriveTitle(message.content)
                : c.title;
            return {
              ...c,
              messages,
              title,
              updatedAt: Date.now(),
            };
          }),
        })),

      updateMessage: (conversationId, messageId, content) =>
        set((s) => ({
          conversations: s.conversations.map((c) =>
            c.id === conversationId
              ? {
                  ...c,
                  messages: c.messages.map((m) =>
                    m.id === messageId ? { ...m, content } : m
                  ),
                  updatedAt: Date.now(),
                }
              : c
          ),
        })),

      setStreaming: (streaming) => set({ isStreaming: streaming }),

      clearAll: () => set({ conversations: [], activeId: null }),
    }),
    {
      name: "chatgpt-ui-conversations",
      // Only persist conversations and activeId, not isStreaming
      partialize: (s) => ({
        conversations: s.conversations,
        activeId: s.activeId,
      }),
    }
  )
);
