"use client";

import { useState, useEffect } from "react";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Youtube,
  ClipboardPaste,
  AlertCircle,
  GraduationCap,
  MessageCircleQuestion,
  Loader2,
  X,
  Sparkles,
} from "lucide-react";

/**
 * Lightweight video preview card shown inside the panel as soon as the user
 * pastes a valid URL. Fetches title + author + thumbnail from our own
 * /api/youtube-meta endpoint (which proxies YouTube's public oEmbed API).
 *
 * This gives the user visual confirmation that we picked up the right video
 * BEFORE they click Submit — avoiding wasted time on the wrong link.
 */
function VideoPreview({ videoId }: { videoId: string }) {
  // Start in the "loading" state. Because the parent renders this component
  // with `key={videoId}`, a new videoId causes React to remount this
  // component fresh — so the initial state is always "loading" for each new
  // video, without needing a synchronous setState inside useEffect.
  const [state, setState] = useState<
    | { kind: "loading" }
    | { kind: "ok"; title: string; author: string; thumbnailUrl: string }
    | { kind: "error"; message: string }
  >({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;

    async function fetchMeta() {
      try {
        const res = await fetch(`/api/youtube-meta?videoId=${videoId}`);
        const data = await res.json();
        if (cancelled) return;
        if (!res.ok || !data.ok) {
          setState({
            kind: "error",
            message:
              data?.error ?? "Couldn't fetch metadata for this video.",
          });
          return;
        }
        setState({
          kind: "ok",
          title: data.title,
          author: data.author,
          thumbnailUrl: data.thumbnailUrl,
        });
      } catch (e) {
        if (cancelled) return;
        setState({
          kind: "error",
          message: "Network error while fetching video metadata.",
        });
      }
    }

    fetchMeta();
    return () => {
      cancelled = true;
    };
  }, [videoId]);

  if (state.kind === "loading") {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-900 px-3 py-2 text-xs text-zinc-500">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        Fetching video info…
      </div>
    );
  }

  if (state.kind === "error") {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/30 px-3 py-2 text-[11px] text-amber-700 dark:text-amber-300">
        <AlertCircle className="h-3.5 w-3.5 flex-shrink-0" />
        {state.message} You can still proceed — we&apos;ll fetch the transcript
        when you click Submit.
      </div>
    );
  }

  return (
    <a
      href={`https://www.youtube.com/watch?v=${videoId}`}
      target="_blank"
      rel="noopener noreferrer"
      className="group flex gap-3 overflow-hidden rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 p-2 hover:border-zinc-300 dark:hover:border-zinc-600 transition-colors"
    >
      <div className="relative h-14 w-24 flex-shrink-0 overflow-hidden rounded bg-zinc-100 dark:bg-zinc-800">
        <img
          src={state.thumbnailUrl}
          alt={state.title}
          className="h-full w-full object-cover"
          onError={(e) => {
            (e.currentTarget as HTMLImageElement).style.display = "none";
          }}
        />
        <div className="absolute inset-0 flex items-center justify-center bg-black/30 group-hover:bg-black/40 transition-colors">
          <Youtube className="h-5 w-5 text-white" />
        </div>
      </div>
      <div className="flex min-w-0 flex-1 flex-col justify-center">
        <p className="line-clamp-2 text-xs font-semibold text-zinc-800 dark:text-zinc-100 leading-snug">
          {state.title}
        </p>
        <p className="mt-0.5 truncate text-[11px] text-zinc-500 dark:text-zinc-400">
          {state.author}
        </p>
      </div>
    </a>
  );
}

export type YouTubeMode = "summary" | "interview" | "ask";

export interface InterviewOptions {
  difficulty: "beginner" | "intermediate" | "advanced" | "mixed";
  questionCount: number;
  interviewType: "technical" | "behavioral" | "mixed";
  targetRole?: string;
}

export interface YouTubeSubmitPayload {
  url: string;
  startTime: string;
  endTime: string;
  instructions: string;
  videoId: string;
  /** When set, the request should bypass fetching and use this transcript instead. */
  transcript?: string;
  /** Which mode the user picked — drives the endpoint on the parent. */
  mode: YouTubeMode;
  /** When mode === "interview", these options are sent along. */
  interviewOptions?: InterviewOptions;
  /**
   * Optional: language for the AI response (e.g. "Hindi", "Spanish",
   * "Japanese", "French"). When empty, the AI uses its default (English).
   * Honored across summary, interview Q&A, ask-about-video, and chat.
   */
  language?: string;
}

interface YouTubeInlinePanelProps {
  open: boolean;
  onClose: () => void;
  onSubmit: (payload: YouTubeSubmitPayload) => void;
  /** When set, automatically switches to manual mode and shows this hint. */
  botBlockedHint?: string | null;
  /** Once the user dismisses the hint, the parent should clear it. */
  onClearHint?: () => void;
  /** Optional pre-filled URL (e.g. when the user pasted a YouTube link in the
   * main chat input and clicked the "Open YouTube panel" chip). */
  initialUrl?: string;
}

function extractVideoId(url: string): string | null {
  const patterns: RegExp[] = [
    /(?:youtube\.com\/watch\?v=)([A-Za-z0-9_-]{11})/,
    /(?:youtu\.be\/)([A-Za-z0-9_-]{11})/,
    /(?:youtube\.com\/embed\/)([A-Za-z0-9_-]{11})/,
    /(?:youtube\.com\/shorts\/)([A-Za-z0-9_-]{11})/,
    /(?:youtube\.com\/live\/)([A-Za-z0-9_-]{11})/,
  ];
  for (const p of patterns) {
    const m = url.match(p);
    if (m) return m[1];
  }
  if (/^[A-Za-z0-9_-]{11}$/.test(url.trim())) return url.trim();
  return null;
}

/**
 * INLINE YouTube configuration panel — replaces the old modal dialog.
 *
 * Renders ABOVE the chat input in the same column, on the same page. User
 * fills in URL + mode + time range + instructions + (optional) interview
 * settings all in one place; there is NO second modal/page.
 *
 * The panel is intentionally tall but compact: every field is visible at
 * once, no tabs/wizards. The parent component decides whether to render
 * the ChatInput or this panel (they swap), so the user never sees both
 * at the same time.
 */
export function YouTubeInlinePanel({
  open,
  onClose,
  onSubmit,
  botBlockedHint,
  onClearHint,
  initialUrl,
}: YouTubeInlinePanelProps) {
  const [url, setUrl] = useState("");
  const [startTime, setStartTime] = useState("");
  const [endTime, setEndTime] = useState("");
  const [instructions, setInstructions] = useState("");
  const [language, setLanguage] = useState("");
  const [touched, setTouched] = useState(false);
  const [mode, setMode] = useState<YouTubeMode>("summary");
  const [fetchMode, setFetchMode] = useState<"auto" | "manual">("auto");
  const [transcript, setTranscript] = useState("");

  // When `initialUrl` is set (e.g. user clicked "Open YouTube panel →" from
  // the URL detection chip in the main chat input), pre-fill the URL field
  // when the panel opens.
  const [prevInitialUrl, setPrevInitialUrl] = useState<string | undefined>(
    initialUrl
  );
  if (initialUrl !== prevInitialUrl) {
    setPrevInitialUrl(initialUrl);
    if (initialUrl && open) {
      setUrl(initialUrl);
    }
  }

  // Interview-mode options
  const [difficulty, setDifficulty] =
    useState<InterviewOptions["difficulty"]>("intermediate");
  const [questionCount, setQuestionCount] = useState<number>(15);
  const [interviewType, setInterviewType] =
    useState<InterviewOptions["interviewType"]>("technical");
  const [targetRole, setTargetRole] = useState<string>("");

  // Remember the last-submitted values so that, when the panel auto-reopens
  // after a bot block, we can repopulate the URL/instructions/time range
  // instead of forcing the user to type them again.
  const [lastPayload, setLastPayload] = useState<YouTubeSubmitPayload | null>(
    null
  );
  const [prevHint, setPrevHint] = useState<string | null | undefined>(
    botBlockedHint
  );

  if (botBlockedHint !== prevHint) {
    setPrevHint(botBlockedHint);
    if (botBlockedHint && lastPayload) {
      setUrl(lastPayload.url);
      setStartTime(lastPayload.startTime);
      setEndTime(lastPayload.endTime);
      setInstructions(lastPayload.instructions);
      setLanguage(lastPayload.language ?? "");
      setMode(lastPayload.mode);
      if (lastPayload.interviewOptions) {
        setDifficulty(lastPayload.interviewOptions.difficulty);
        setQuestionCount(lastPayload.interviewOptions.questionCount);
        setInterviewType(lastPayload.interviewOptions.interviewType);
        setTargetRole(lastPayload.interviewOptions.targetRole ?? "");
      }
      setFetchMode("manual");
      setTranscript("");
    }
  }

  const videoId = extractVideoId(url);
  const urlError = touched && url && !videoId ? "Enter a valid YouTube URL" : "";

  const showHint = !!botBlockedHint;
  const effectiveFetchMode = showHint ? "manual" : fetchMode;

  const canSubmit =
    !!videoId &&
    (effectiveFetchMode === "auto" || transcript.trim().length > 0);

  const handleSubmit = () => {
    setTouched(true);
    if (!videoId) return;
    if (effectiveFetchMode === "manual" && !transcript.trim()) return;
    const payload: YouTubeSubmitPayload = {
      url: url.trim(),
      startTime: startTime.trim(),
      endTime: endTime.trim(),
      instructions: instructions.trim(),
      videoId,
      transcript:
        effectiveFetchMode === "manual" ? transcript.trim() : undefined,
      mode,
      interviewOptions:
        mode === "interview"
          ? {
              difficulty,
              questionCount,
              interviewType,
              targetRole: targetRole.trim() || undefined,
            }
          : undefined,
      language: language.trim() || undefined,
    };
    setLastPayload(payload);
    onSubmit(payload);
    // Reset
    setUrl("");
    setStartTime("");
    setEndTime("");
    setInstructions("");
    setLanguage("");
    setTranscript("");
    setTouched(false);
    setFetchMode("auto");
    onClearHint?.();
    onClose();
  };

  const handleClose = () => {
    onClearHint?.();
    onClose();
  };

  // Title / description / submit label depend on mode
  const titleText =
    mode === "interview"
      ? "Interview Q&A from a YouTube video"
      : mode === "ask"
      ? "Ask questions about a YouTube video"
      : "Summarize a YouTube video";

  const descriptionText =
    mode === "interview"
      ? "Paste a YouTube URL and optionally pick a time range. We'll fetch the transcript and generate interview-style questions and answers from it."
      : mode === "ask"
      ? "Paste a YouTube URL. We'll load the transcript into this conversation so you can ask any question about the video. If you ask about something not in the video, the assistant will tell you so."
      : "Paste a YouTube URL and optionally pick a time range. We'll fetch the transcript and summarize the selected part for you.";

  const submitButtonLabel =
    effectiveFetchMode === "manual"
      ? mode === "interview"
        ? "Generate Q&A from pasted transcript"
        : mode === "ask"
        ? "Load pasted transcript for Q&A"
        : "Summarize pasted transcript"
      : mode === "interview"
      ? "Generate Interview Q&A"
      : mode === "ask"
      ? "Load video for Q&A"
      : "Summarize";

  if (!open) return null;

  return (
    <div className="px-4 pb-2 pt-2 md:px-8">
      <div className="mx-auto max-w-3xl">
        <div className="rounded-2xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 shadow-sm overflow-hidden">
          {/* Header bar */}
          <div className="flex items-center justify-between border-b border-zinc-200 dark:border-zinc-800 bg-gradient-to-r from-red-50 to-amber-50 dark:from-red-950/30 dark:to-amber-950/30 px-4 py-3">
            <div className="flex items-center gap-2 min-w-0">
              <div className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-md bg-red-600 text-white">
                <Youtube className="h-4 w-4" />
              </div>
              <div className="min-w-0">
                <p className="text-sm font-semibold text-zinc-800 dark:text-zinc-100 truncate flex items-center gap-1.5">
                  {titleText}
                </p>
                <p className="text-[11px] text-zinc-500 dark:text-zinc-400 truncate">
                  {descriptionText}
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={handleClose}
              className="flex-shrink-0 ml-2 rounded-full p-1.5 text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200 hover:bg-white/60 dark:hover:bg-zinc-800/60 transition-colors"
              aria-label="Close YouTube panel"
              title="Close — back to chat"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          {/* Scrollable body */}
          <div className="max-h-[calc(100vh-220px)] overflow-y-auto px-4 py-3 space-y-4">
            {showHint && (
              <div className="flex gap-2 rounded-lg border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-950/40 px-3 py-2.5 text-xs text-amber-800 dark:text-amber-200">
                <AlertCircle className="h-4 w-4 flex-shrink-0 mt-0.5" />
                <div className="flex-1">
                  <p className="font-medium mb-0.5">
                    YouTube blocked the auto-fetch for this video.
                  </p>
                  <p className="mb-2">{botBlockedHint}</p>
                  <p className="mb-2">
                    We&apos;ve switched to <strong>Manual mode</strong>. Use
                    the button below to open the video on YouTube, then click
                    the &quot;… More&quot; button below the video and choose
                    <strong> Show transcript</strong>. Copy the transcript
                    text and paste it into the box below.
                  </p>
                  {videoId && (
                    <a
                      href={`https://www.youtube.com/watch?v=${videoId}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1.5 rounded-md bg-amber-600 hover:bg-amber-700 text-white px-2.5 py-1 text-[11px] font-medium transition-colors"
                    >
                      <Youtube className="h-3 w-3" />
                      Open video on YouTube
                    </a>
                  )}
                </div>
              </div>
            )}

            {/* Mode selector: Summary | Interview Q&A | Ask about video */}
            <div className="flex gap-1 rounded-lg bg-zinc-100 dark:bg-zinc-800 p-1">
              <button
                type="button"
                onClick={() => setMode("summary")}
                className={`flex-1 rounded-md py-1.5 text-[11px] font-medium transition-colors ${
                  mode === "summary"
                    ? "bg-white dark:bg-zinc-950 text-zinc-900 dark:text-white shadow-sm"
                    : "text-zinc-500 dark:text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-300"
                }`}
              >
                <Youtube className="inline h-3 w-3 mr-0.5" />
                Summary
              </button>
              <button
                type="button"
                onClick={() => setMode("interview")}
                className={`flex-1 rounded-md py-1.5 text-[11px] font-medium transition-colors ${
                  mode === "interview"
                    ? "bg-white dark:bg-zinc-950 text-zinc-900 dark:text-white shadow-sm"
                    : "text-zinc-500 dark:text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-300"
                }`}
              >
                <GraduationCap className="inline h-3 w-3 mr-0.5" />
                Interview Q&amp;A
              </button>
              <button
                type="button"
                onClick={() => setMode("ask")}
                className={`flex-1 rounded-md py-1.5 text-[11px] font-medium transition-colors ${
                  mode === "ask"
                    ? "bg-white dark:bg-zinc-950 text-zinc-900 dark:text-white shadow-sm"
                    : "text-zinc-500 dark:text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-300"
                }`}
              >
                <MessageCircleQuestion className="inline h-3 w-3 mr-0.5" />
                Ask about video
              </button>
            </div>

            {/* URL input + preview */}
            <div className="space-y-1.5">
              <Label htmlFor="yt-url">YouTube URL *</Label>
              <Input
                id="yt-url"
                autoFocus
                placeholder="https://www.youtube.com/watch?v=…"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                onBlur={() => setTouched(true)}
              />
              {urlError && (
                <p className="text-xs text-red-500">{urlError}</p>
              )}
              {videoId && (
                <>
                  <p className="text-xs text-emerald-600 dark:text-emerald-400">
                    ✓ Detected video ID:{" "}
                    <code className="font-mono">{videoId}</code>
                  </p>
                  <VideoPreview key={videoId} videoId={videoId} />
                </>
              )}
            </div>

            {/* Response language (optional). Empty = default English. */}
            <div className="space-y-1.5">
              <Label htmlFor="yt-language">
                Response language (optional)
              </Label>
              <Input
                id="yt-language"
                placeholder="e.g. Hindi, Spanish, Japanese, French (empty = English)"
                value={language}
                onChange={(e) => setLanguage(e.target.value)}
              />
              <p className="text-[11px] text-zinc-500">
                Leave empty for the default (English). If you type a language,
                the entire summary / Q&amp;A / chat answer will be written in
                that language. Timestamps, code, and tool names stay in their
                original form.
              </p>
            </div>

            {/* Interview-mode options */}
            {mode === "interview" && (
              <div className="space-y-3 rounded-lg border border-zinc-200 dark:border-zinc-700 p-3 bg-zinc-50/50 dark:bg-zinc-900/30">
                <p className="text-xs font-semibold text-zinc-700 dark:text-zinc-300 uppercase tracking-wide">
                  Interview settings
                </p>

                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <Label htmlFor="yt-difficulty" className="text-xs">
                      Difficulty
                    </Label>
                    <Select
                      value={difficulty}
                      onValueChange={(v) =>
                        setDifficulty(v as InterviewOptions["difficulty"])
                      }
                    >
                      <SelectTrigger id="yt-difficulty" className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="beginner">Beginner</SelectItem>
                        <SelectItem value="intermediate">Intermediate</SelectItem>
                        <SelectItem value="advanced">Advanced</SelectItem>
                        <SelectItem value="mixed">Mixed (all levels)</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="space-y-1.5">
                    <Label htmlFor="yt-type" className="text-xs">
                      Interview type
                    </Label>
                    <Select
                      value={interviewType}
                      onValueChange={(v) =>
                        setInterviewType(v as InterviewOptions["interviewType"])
                      }
                    >
                      <SelectTrigger id="yt-type" className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="technical">Technical</SelectItem>
                        <SelectItem value="behavioral">Behavioral</SelectItem>
                        <SelectItem value="mixed">Mixed</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <Label htmlFor="yt-count" className="text-xs">
                      Number of questions
                    </Label>
                    <Select
                      value={String(questionCount)}
                      onValueChange={(v) => setQuestionCount(parseInt(v, 10))}
                    >
                      <SelectTrigger id="yt-count" className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {[5, 10, 15, 20, 25, 30].map((n) => (
                          <SelectItem key={n} value={String(n)}>
                            {n} questions
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="space-y-1.5">
                    <Label htmlFor="yt-role" className="text-xs">
                      Target role (optional)
                    </Label>
                    <Input
                      id="yt-role"
                      placeholder="e.g. Senior React Developer"
                      value={targetRole}
                      onChange={(e) => setTargetRole(e.target.value)}
                    />
                  </div>
                </div>
              </div>
            )}

            {/* Fetch mode switcher */}
            <div className="flex gap-1 rounded-lg bg-zinc-100 dark:bg-zinc-800 p-1">
              <button
                type="button"
                onClick={() => setFetchMode("auto")}
                disabled={showHint}
                className={`flex-1 rounded-md py-1.5 text-xs font-medium transition-colors ${
                  effectiveFetchMode === "auto"
                    ? "bg-white dark:bg-zinc-950 text-zinc-900 dark:text-white shadow-sm"
                    : "text-zinc-500 dark:text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-300"
                } ${showHint ? "cursor-not-allowed opacity-50" : ""}`}
              >
                Auto-fetch transcript
              </button>
              <button
                type="button"
                onClick={() => setFetchMode("manual")}
                className={`flex-1 rounded-md py-1.5 text-xs font-medium transition-colors ${
                  effectiveFetchMode === "manual"
                    ? "bg-white dark:bg-zinc-950 text-zinc-900 dark:text-white shadow-sm"
                    : "text-zinc-500 dark:text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-300"
                }`}
              >
                Paste transcript manually
              </button>
            </div>

            {effectiveFetchMode === "manual" && (
              <div className="space-y-1.5">
                <Label htmlFor="yt-transcript" className="flex items-center gap-1.5">
                  <ClipboardPaste className="h-3.5 w-3.5" />
                  Transcript text *
                </Label>
                <Textarea
                  id="yt-transcript"
                  placeholder={
                    "Paste the transcript here.\n" +
                    "Timestamps are optional — both of these work:\n" +
                    "  0:15 First line of the transcript\n" +
                    "  [0:30] Second line of the transcript\n" +
                    "Or just paste plain text, one sentence per line."
                  }
                  value={transcript}
                  onChange={(e) => setTranscript(e.target.value)}
                  rows={6}
                  className="resize-y font-mono text-xs"
                />
                <p className="text-[11px] text-zinc-500">
                  Tip: On YouTube, click &quot;… More&quot; below the video,
                  then &quot;Show transcript&quot;. Copy the text from the
                  panel that opens, then paste it here.
                </p>
                {transcript.trim() &&
                  !/^\[?\d{1,2}:\d{2}(?::\d{2})?\]?/m.test(transcript) &&
                  (startTime.trim() || endTime.trim()) && (
                    <p className="text-[11px] text-amber-600 dark:text-amber-400">
                      Your pasted transcript doesn&apos;t have timestamps, so
                      the start/end times will be ignored — we&apos;ll use the
                      whole paste instead.
                    </p>
                  )}
              </div>
            )}

            {/* Time range */}
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="yt-start">Start time (optional)</Label>
                <Input
                  id="yt-start"
                  placeholder="0:00"
                  value={startTime}
                  onChange={(e) => setStartTime(e.target.value)}
                />
                <p className="text-[11px] text-zinc-500">
                  Minutes, not seconds. <code>5</code> = 5&nbsp;min. Also
                  accepts <code>5:30</code>, <code>1:25:30</code>,{" "}
                  <code>90s</code>, <code>1h30m</code>.
                </p>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="yt-end">End time (optional)</Label>
                <Input
                  id="yt-end"
                  placeholder="e.g. 5:30"
                  value={endTime}
                  onChange={(e) => setEndTime(e.target.value)}
                />
                <p className="text-[11px] text-zinc-500">
                  A bare number is minutes. Leave empty for full video.
                </p>
              </div>
            </div>

            {/* Custom instructions */}
            <div className="space-y-1.5">
              <Label htmlFor="yt-instructions">
                Custom instructions (optional)
              </Label>
              <Textarea
                id="yt-instructions"
                placeholder={
                  mode === "interview"
                    ? "e.g. Focus on React hooks and skip the intro. Include system design questions."
                    : mode === "ask"
                    ? "e.g. Treat the transcript as the only source of truth — if I ask about something not in the video, tell me."
                    : "e.g. Focus on the main arguments and skip the intro"
                }
                value={instructions}
                onChange={(e) => setInstructions(e.target.value)}
                rows={2}
                className="resize-none"
              />
            </div>
          </div>

          {/* Footer with action buttons */}
          <div className="flex items-center justify-between gap-2 border-t border-zinc-200 dark:border-zinc-800 bg-zinc-50/50 dark:bg-zinc-900/50 px-4 py-3">
            <p className="hidden sm:block text-[11px] text-zinc-500 dark:text-zinc-400">
              <Sparkles className="inline h-3 w-3 mr-1 text-emerald-500" />
              All fields except URL are optional
            </p>
            <div className="flex items-center gap-2 ml-auto">
              <Button variant="outline" onClick={handleClose}>
                Cancel
              </Button>
              <Button onClick={handleSubmit} disabled={!canSubmit}>
                <Youtube className="h-4 w-4 mr-1.5" />
                {submitButtonLabel}
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
