"use client";

import { useEffect, useRef, useState, useCallback } from "react";

interface UseAutoScrollOptions {
  /**
   * Dependencies that should trigger a scroll-to-bottom check when they
   * change. Typically: the messages array, the active conversation ID,
   * and the streaming state.
   */
  deps: unknown[];
  /**
   * If true, ALWAYS scroll to bottom when deps change (ignore whether the
   * user was already near the bottom). Default: false.
   *
   * Set this to true for "user sent a new message" — in that case we
   * always want to follow the new message, even if the user had scrolled
   * up to read history.
   */
  force?: boolean;
}

interface AutoScrollResult {
  /** Ref to attach to the scrollable container. */
  scrollRef: React.RefObject<HTMLDivElement | null>;
  /** True if the user has scrolled up away from the bottom. */
  isAtBottom: boolean;
  /** Call to programmatically scroll to the bottom. */
  scrollToBottom: () => void;
}

/**
 * Smart auto-scroll for chat message lists.
 *
 * Behavior:
 *   - When new content arrives (deps change), scroll to bottom ONLY IF the
 *     user was already near the bottom (within ~80px). This lets users
 *     scroll up to read earlier messages without being yanked back down on
 *     every streamed token.
 *   - When the user clicks the "scroll to bottom" button, always scroll.
 *   - Tracks `isAtBottom` so the caller can show/hide a scroll-to-bottom
 *     button when the user has scrolled up.
 *
 * Extracted from page.tsx where the previous behavior was a hard
 * `scrollTop = scrollHeight` on every conversation change — which meant
 * streaming responses always yanked the user back to the bottom even if
 * they were reading earlier history.
 */
export function useAutoScroll({
  deps,
  force = false,
}: UseAutoScrollOptions): AutoScrollResult {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [isAtBottom, setIsAtBottom] = useState(true);
  // Tracks whether the user is currently near the bottom. Updated on scroll
  // and used to decide whether to auto-scroll on the next dep change.
  const wasNearBottomRef = useRef(true);

  // Update `isAtBottom` + `wasNearBottomRef` whenever the user scrolls.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const handleScroll = () => {
      const threshold = 80; // px from bottom considered "at bottom"
      const atBottom =
        el.scrollHeight - el.scrollTop - el.clientHeight < threshold;
      setIsAtBottom(atBottom);
      wasNearBottomRef.current = atBottom;
    };
    el.addEventListener("scroll", handleScroll, { passive: true });
    // Initialize on mount.
    handleScroll();
    return () => el.removeEventListener("scroll", handleScroll);
  }, []);

  // Scroll to bottom on dep change, but only if user was near bottom
  // (or if `force` is true).
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (force || wasNearBottomRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, deps);

  const scrollToBottom = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    wasNearBottomRef.current = true;
    setIsAtBottom(true);
  }, []);

  return { scrollRef, isAtBottom, scrollToBottom };
}
