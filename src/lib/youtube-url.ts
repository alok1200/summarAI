/**
 * YouTube URL + language detection helpers.
 *
 * Used by sendMessage (page.tsx) and ChatInput to auto-route pasted YouTube
 * links to the summary endpoint — no panel, no settings, just paste & go.
 *
 * Extracted into its own module so the same regexes can be shared between
 * the chat input (which shows a "Summarize video →" chip when it detects a
 * URL) and the message dispatcher (which actually routes the URL).
 */

/**
 * All YouTube URL patterns we accept. The 11-char video ID is the same
 * across all of YouTube's URL surfaces (watch, embed, shorts, live, youtu.be).
 */
const YOUTUBE_URL_PATTERNS: RegExp[] = [
  /(?:youtube\.com\/watch\?v=)([A-Za-z0-9_-]{11})/,
  /(?:youtu\.be\/)([A-Za-z0-9_-]{11})/,
  /(?:youtube\.com\/embed\/)([A-Za-z0-9_-]{11})/,
  /(?:youtube\.com\/shorts\/)([A-Za-z0-9_-]{11})/,
  /(?:youtube\.com\/live\/)([A-Za-z0-9_-]{11})/,
];

/**
 * Single regex that matches the FULL URL (including any extra query params
 * like &t=120s or &feature=share) once any of the patterns above hit.
 * Used to extract the exact URL string from a longer user message.
 *
 * `[^\s]*?` (not `+?`) is intentional: a bare youtu.be URL like
 * `https://youtu.be/ID` has ZERO chars between `//` and `youtu`, so the
 * prefix must be allowed to be empty. (For `www.youtube.com/...` the
 * non-greedy match still expands to consume `www.` first.)
 */
const YOUTUBE_FULL_URL_REGEX =
  /https?:\/\/[^\s]*?(?:youtube\.com\/watch\?v=[A-Za-z0-9_-]+|youtu\.be\/[A-Za-z0-9_-]+|youtube\.com\/(?:embed|shorts|live)\/[A-Za-z0-9_-]+)[^\s]*/;

/**
 * Detect a YouTube URL anywhere in a string and return the full URL (with
 * any trailing query params). Returns null if no YouTube URL is present.
 *
 * Example:
 *   detectYouTubeUrl("check this out https://youtu.be/dQw4w9WgXcQ cool")
 *   → "https://youtu.be/dQw4w9WgXcQ"
 */
export function detectYouTubeUrl(text: string): string | null {
  for (const p of YOUTUBE_URL_PATTERNS) {
    if (p.test(text)) {
      const fullMatch = text.match(YOUTUBE_FULL_URL_REGEX);
      return fullMatch?.[0] ?? null;
    }
  }
  return null;
}

/**
 * Extract the 11-character video ID from a YouTube URL. Returns "" if the
 * URL doesn't contain a recognizable video ID.
 *
 * Example:
 *   extractVideoId("https://youtu.be/dQw4w9WgXcQ")  → "dQw4w9WgXcQ"
 *   extractVideoId("https://example.com/foo")        → ""
 */
export function extractVideoIdFromUrl(url: string): string {
  const m = url.match(
    /(?:youtube\.com\/(?:watch\?v=|embed\/|shorts\/|live\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/
  );
  return m?.[1] ?? "";
}

/**
 * Programming-language names that should NOT be treated as a human language
 * when matching the "in <X>" hint. Without this filter, "summarize this in
 * Python: <URL>" would route to the Python-language summary instead of just
 * summarizing the video normally.
 */
const PROGRAMMING_LANGUAGES = new Set([
  "JavaScript", "TypeScript", "Python", "Java", "React", "Vue",
  "Angular", "Node", "Rust", "Go", "Swift", "Kotlin", "Ruby",
  "PHP", "C++", "C#",
]);

/**
 * Extract an optional language hint from a user message. Looks for the
 * pattern "in <Language>" near the end of the message, where <Language> is
 * a capitalized word (e.g. "in Hindi", "in Spanish", "in French").
 * Returns the language name, or undefined if no language is specified.
 *
 * This lets the user type "summarize this in Hindi: <URL>" and have the
 * entire response generated in Hindi — without needing a settings panel.
 *
 * Programming-language names (Python, JavaScript, etc.) are filtered out
 * so "summarize this in Python" doesn't get misinterpreted.
 */
export function detectLanguage(text: string): string | undefined {
  const m = text.match(/\bin\s+([A-Z][a-zA-Z]{2,})\b/);
  if (!m) return undefined;
  const lang = m[1].trim();
  if (PROGRAMMING_LANGUAGES.has(lang)) return undefined;
  return lang;
}

/**
 * Strip the YouTube URL and "in <Language>" hint from a user message,
 * leaving behind any free-form instructions the user typed (e.g. "focus on
 * the React parts"). Also strips leading "summarize this video:" prefixes.
 *
 * Returns the trimmed remainder, or "" if the message was just the URL.
 *
 * IMPORTANT: the prefix regex below lists longer alternatives FIRST.
 * JavaScript regex alternation is leftmost-match-wins (not longest-match-
 * wins like POSIX), so if `summarize` came before `summarize this video` in
 * the alternation, the shorter `summarize` would always win and leave
 * behind "this video:" — defeating the whole point of the strip.
 */
export function extractInstructions(text: string, ytUrl: string): string {
  return text
    .replace(ytUrl, "")
    .replace(/\bin\s+[A-Z][a-zA-Z]{2,}\b/g, "")
    .replace(
      /^(summarize this video|summarize this for me|summarize this|summary of|summarize|summarise|tl;?dr)[:\s,]*/i,
      ""
    )
    .trim();
}
