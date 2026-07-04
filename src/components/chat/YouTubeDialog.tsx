"use client";

import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
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
} from "lucide-react";

export type YouTubeMode = "summary" | "interview";

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
}

interface YouTubeDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (payload: YouTubeSubmitPayload) => void;
  /** When set, automatically switches to manual mode and shows this hint. */
  botBlockedHint?: string | null;
  /** Once the user dismisses the hint, the parent should clear it. */
  onClearHint?: () => void;
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

export function YouTubeDialog({
  open,
  onOpenChange,
  onSubmit,
  botBlockedHint,
  onClearHint,
}: YouTubeDialogProps) {
  const [url, setUrl] = useState("");
  const [startTime, setStartTime] = useState("");
  const [endTime, setEndTime] = useState("");
  const [instructions, setInstructions] = useState("");
  const [touched, setTouched] = useState(false);
  const [mode, setMode] = useState<YouTubeMode>("summary");
  const [fetchMode, setFetchMode] = useState<"auto" | "manual">("auto");
  const [transcript, setTranscript] = useState("");

  // Interview-mode options
  const [difficulty, setDifficulty] =
    useState<InterviewOptions["difficulty"]>("intermediate");
  const [questionCount, setQuestionCount] = useState<number>(15);
  const [interviewType, setInterviewType] =
    useState<InterviewOptions["interviewType"]>("technical");
  const [targetRole, setTargetRole] = useState<string>("");

  // Remember the last-submitted values so that, when the dialog auto-reopens
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
    };
    setLastPayload(payload);
    onSubmit(payload);
    // Reset
    setUrl("");
    setStartTime("");
    setEndTime("");
    setInstructions("");
    setTranscript("");
    setTouched(false);
    setFetchMode("auto");
    onClearHint?.();
    onOpenChange(false);
  };

  const handleClose = (open: boolean) => {
    if (!open) {
      onClearHint?.();
    }
    onOpenChange(open);
  };

  const submitButtonLabel =
    effectiveFetchMode === "manual"
      ? mode === "interview"
        ? "Generate Q&A from pasted transcript"
        : "Summarize pasted transcript"
      : mode === "interview"
      ? "Generate Interview Q&A"
      : "Summarize";

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Youtube className="h-5 w-5 text-red-600" />
            {mode === "interview"
              ? "Interview Q&A from a YouTube video"
              : "Summarize a YouTube video"}
          </DialogTitle>
          <DialogDescription>
            Paste a YouTube URL and optionally pick a time range. We&apos;ll
            fetch the transcript and{" "}
            {mode === "interview"
              ? "generate interview-style questions and answers from it."
              : "summarize the selected part for you."}
          </DialogDescription>
        </DialogHeader>

        {showHint && (
          <div className="flex gap-2 rounded-lg border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-950/40 px-3 py-2.5 text-xs text-amber-800 dark:text-amber-200">
            <AlertCircle className="h-4 w-4 flex-shrink-0 mt-0.5" />
            <div className="flex-1">
              <p className="font-medium mb-0.5">
                YouTube blocked the auto-fetch for this video.
              </p>
              <p className="mb-2">{botBlockedHint}</p>
              <p className="mb-2">
                We&apos;ve switched to <strong>Manual mode</strong>. Use the
                button below to open the video on YouTube, then click the
                &quot;… More&quot; button below the video and choose
                <strong> Show transcript</strong>. Copy the transcript text
                and paste it into the box below.
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

        {/* Mode selector: Summary vs Interview Q&A */}
        <div className="flex gap-1 rounded-lg bg-zinc-100 dark:bg-zinc-800 p-1">
          <button
            type="button"
            onClick={() => setMode("summary")}
            className={`flex-1 rounded-md py-1.5 text-xs font-medium transition-colors ${
              mode === "summary"
                ? "bg-white dark:bg-zinc-950 text-zinc-900 dark:text-white shadow-sm"
                : "text-zinc-500 dark:text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-300"
            }`}
          >
            <Youtube className="inline h-3.5 w-3.5 mr-1" />
            Summary
          </button>
          <button
            type="button"
            onClick={() => setMode("interview")}
            className={`flex-1 rounded-md py-1.5 text-xs font-medium transition-colors ${
              mode === "interview"
                ? "bg-white dark:bg-zinc-950 text-zinc-900 dark:text-white shadow-sm"
                : "text-zinc-500 dark:text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-300"
            }`}
          >
            <GraduationCap className="inline h-3.5 w-3.5 mr-1" />
            Interview Q&amp;A
          </button>
        </div>

        <div className="space-y-4 py-2">
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
              <p className="text-xs text-emerald-600 dark:text-emerald-400">
                ✓ Detected video ID: <code className="font-mono">{videoId}</code>
              </p>
            )}
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
                rows={8}
                className="resize-y font-mono text-xs"
              />
              <p className="text-[11px] text-zinc-500">
                Tip: On YouTube, click &quot;… More&quot; below the video, then
                &quot;Show transcript&quot;. Copy the text from the panel that
                opens, then paste it here.
              </p>
              {transcript.trim() &&
                !/^\[?\d{1,2}:\d{2}(?::\d{2})?\]?/m.test(transcript) &&
                (startTime.trim() || endTime.trim()) && (
                  <p className="text-[11px] text-amber-600 dark:text-amber-400">
                    Your pasted transcript doesn&apos;t have timestamps, so the
                    start/end times will be ignored — we&apos;ll use the
                    whole paste instead.
                  </p>
                )}
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="yt-start">Start time (optional)</Label>
              <Input
                id="yt-start"
                placeholder="0:00"
                value={startTime}
                onChange={(e) => setStartTime(e.target.value)}
              />
              <p className="text-[11px] text-zinc-500">Format: MM:SS or HH:MM:SS</p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="yt-end">End time (optional)</Label>
              <Input
                id="yt-end"
                placeholder="e.g. 5:30"
                value={endTime}
                onChange={(e) => setEndTime(e.target.value)}
              />
              <p className="text-[11px] text-zinc-500">Leave empty for full video</p>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="yt-instructions">Custom instructions (optional)</Label>
            <Textarea
              id="yt-instructions"
              placeholder={
                mode === "interview"
                  ? "e.g. Focus on React hooks and skip the intro. Include system design questions."
                  : "e.g. Focus on the main arguments and skip the intro"
              }
              value={instructions}
              onChange={(e) => setInstructions(e.target.value)}
              rows={3}
              className="resize-none"
            />
          </div>
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => handleClose(false)}
          >
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={!canSubmit}>
            {submitButtonLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
