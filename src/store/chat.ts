"use client";

import { create } from "zustand";
import { persist } from "zustand/middleware";

export type AttachmentKind = "image" | "text" | "file";

export interface Attachment {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  kind: AttachmentKind;
  /** For images: data URL (base64). For text: undefined. */
  dataUrl?: string;
  /** For text files: extracted text content. */
  textContent?: string;
}

export interface YouTubeMeta {
  url: string;
  videoId: string;
  startTime?: number; // seconds
  endTime?: number; // seconds
  instructions?: string;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: number;
  attachments?: Attachment[];
  youtubeMeta?: YouTubeMeta;
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
            let title = c.title;
            if (c.title === "New chat" && message.role === "user") {
              if (message.youtubeMeta) {
                title = `▶ ${message.youtubeMeta.url}`;
              } else if (message.attachments?.length) {
                const first = message.attachments[0];
                title =
                  message.content.trim() ||
                  `📎 ${first.name}${
                    message.attachments.length > 1
                      ? ` +${message.attachments.length - 1}`
                      : ""
                  }`;
              } else {
                title = deriveTitle(message.content);
              }
            }
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
      partialize: (s) => ({
        conversations: s.conversations,
        activeId: s.activeId,
      }),
    }
  )
);
