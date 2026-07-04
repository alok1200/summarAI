"use client";

import { useCallback, useRef } from "react";
import {
  useChatStore,
  type ChatMessage,
} from "@/store/chat";

/**
 * Generate a short, sortable, unique-enough ID for a chat message.
 *
 * Format: <base36 timestamp><random 6 chars>
 * Example: "lk7f3x" + "a1b2c3" → "lk7f3xa1b2c3"
 *
 * Not cryptographically unique, but collisions are vanishingly unlikely
 * within a single user's session — and the worst case is just a React key
 * warning, not data loss.
 */
export function genId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

interface StreamOptions {
  /** User message to append before the assistant placeholder. */
  userMessage: ChatMessage;
  /** Endpoint to POST to (e.g. "/api/chat" or "/api/youtube-summary"). */
  endpoint: string;
  /** JSON-serializable request body. */
  payload: unknown;
  /** Initial text to put in the assistant bubble (e.g. "⏳ Fetching…"). */
  assistantPrefix?: string;
  /** Called when the server returns { code: "BOT_BLOCKED" } instead of
   *  writing an error into the bubble. Lets the caller decide how to surface
   *  bot-blocked errors (e.g. show a custom message or UI). */
  onBotBlocked?: (message: string) => void;
}

/**
 * Core streaming hook used by both the regular chat flow and the YouTube
 * auto-route flow.
 *
 * What it does, in order:
 *   1. Appends the user message + an empty assistant placeholder to the
 *      active conversation.
 *   2. POSTs `payload` to `endpoint` with an AbortController so the user
 *      can stop the stream mid-flight.
 *   3. Reads the response body as a stream, decoding chunks and updating
 *      the assistant placeholder in real time.
 *   4. On error: writes a "⚠️ Error: …" message into the bubble (unless
 *      the error was an abort, in which case it keeps whatever we had).
 *   5. On BOT_BLOCKED: writes the graceful "try again later" message
 *      into the bubble (instead of the raw error).
 *
 * Extracted from page.tsx so the streaming logic is testable in isolation
 * and reusable by future endpoints (e.g. /api/youtube-interview).
 */
export function useStreamHandler() {
  const {
    activeId,
    createConversation,
    appendMessage,
    updateMessage,
    setStreaming,
  } = useChatStore();

  const abortRef = useRef<AbortController | null>(null);

  const runStream = useCallback(
    async ({
      userMessage,
      endpoint,
      payload,
      assistantPrefix,
      onBotBlocked,
    }: StreamOptions) => {
      // Ensure there's an active conversation to append to.
      let convoId = activeId;
      if (!convoId) {
        convoId = createConversation();
      }

      // Append the user's message + a placeholder assistant bubble.
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
          // Try to parse a structured error from the JSON body. The YouTube
          // endpoints return { error, code, videoMeta } on failure; the chat
          // endpoint just returns { error }.
          let errMsg = `Request failed: ${res.status}`;
          let errCode: string | undefined;
          let errMeta: {
            title?: string;
            author?: string;
            thumbnailUrl?: string;
          } | undefined;
          try {
            const errBody = await res.json();
            if (errBody?.error) errMsg = errBody.error;
            errCode = errBody?.code;
            errMeta = errBody?.videoMeta;
          } catch {
            // Body wasn't JSON — fall through to the generic error below.
          }

          if (errCode === "BOT_BLOCKED" && onBotBlocked) {
            onBotBlocked(errMsg);
            // Graceful "try again later" message. The manual-paste fallback
            // was removed from the UI; this is the honest, self-contained
            // explanation the user sees instead.
            const metaLine = errMeta?.title
              ? `**Video:** ${errMeta.title}${
                  errMeta.author ? ` — ${errMeta.author}` : ""
                }\n\n`
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

        // Stream the response into the assistant bubble.
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
          // User clicked Stop — keep whatever partial content we have.
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

  /** Abort the in-flight stream (if any). Called when user clicks Stop. */
  const stop = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setStreaming(false);
  }, [setStreaming]);

  return { runStream, stop, abortRef };
}
