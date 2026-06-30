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
import { Youtube, Loader2 } from "lucide-react";

export interface YouTubeSubmitPayload {
  url: string;
  startTime: string;
  endTime: string;
  instructions: string;
  videoId: string;
}

interface YouTubeDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (payload: YouTubeSubmitPayload) => void;
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
}: YouTubeDialogProps) {
  const [url, setUrl] = useState("");
  const [startTime, setStartTime] = useState("");
  const [endTime, setEndTime] = useState("");
  const [instructions, setInstructions] = useState("");
  const [touched, setTouched] = useState(false);

  const videoId = extractVideoId(url);
  const urlError = touched && url && !videoId ? "Enter a valid YouTube URL" : "";

  const canSubmit = !!videoId;

  const handleSubmit = () => {
    setTouched(true);
    if (!videoId) return;
    onSubmit({
      url: url.trim(),
      startTime: startTime.trim(),
      endTime: endTime.trim(),
      instructions: instructions.trim(),
      videoId,
    });
    // Reset
    setUrl("");
    setStartTime("");
    setEndTime("");
    setInstructions("");
    setTouched(false);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Youtube className="h-5 w-5 text-red-600" />
            Summarize a YouTube video
          </DialogTitle>
          <DialogDescription>
            Paste a YouTube URL and optionally pick a time range. We&apos;ll
            fetch the transcript and summarize the selected part for you.
          </DialogDescription>
        </DialogHeader>

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
              placeholder="e.g. Focus on the main arguments and skip the intro"
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
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={!canSubmit}>
            <Loader2 className="mr-2 h-4 w-4 hidden" />
            Summarize
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
