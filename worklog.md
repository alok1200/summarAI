# Project Worklog

This file tracks all changes made to the Next.js chat app.

---
Task ID: 0
Agent: main
Task: Add "Interview Q&A Generator" feature — takes any YouTube link and produces interview-style questions and answers based on the video's content.

Work Log:
- Reviewed existing architecture: /api/youtube-summary endpoint + YouTubeDialog UI
- Identified reusable multi-strategy transcript fetcher (InnerTube ANDROID/WEB + watch page scrape + youtube-transcript lib + youtubei.js)
- Plan: extract shared lib, add new /api/youtube-interview endpoint, add mode selector to dialog

Stage Summary:
- About to extract shared transcript-fetching lib and create new interview Q&A endpoint

---
Task ID: 1
Agent: main
Task: Implement Interview Q&A Generator feature end-to-end

Work Log:
- Created /src/lib/youtube-transcript.ts — extracted shared transcript-fetching logic (4-strategy fallback: InnerTube ANDROID, watch-page scrape, youtube-transcript lib, youtubei.js)
- Refactored /src/app/api/youtube-summary/route.ts to import from shared lib — reduced from 870 lines to ~230 lines, regression-tested and still works (11s, 1.6KB summary)
- Created /src/app/api/youtube-interview/route.ts — new endpoint that takes url/difficulty/questionCount/interviewType/targetRole and streams Markdown Q&A
- Updated /src/components/chat/YouTubeDialog.tsx — added "Summary | Interview Q&A" mode toggle at top; when Interview is selected, shows difficulty/type/count/role controls
- Updated /src/app/page.tsx — handleYouTube now branches on payload.mode, dispatches to /api/youtube-summary or /api/youtube-interview, builds different placeholder + user message text
- Updated /src/components/chat/ChatInput.tsx — tooltip and help text now mention "interview Q&A"

Stage Summary:
- All endpoints tested:
  * Summary regression: HTTP 200, 11s, 1.6KB output
  * Interview (default 15 intermediate technical): HTTP 200, 110s, 16.5KB output
  * Interview (10 advanced behavioral, PM role): HTTP 200, 69s, 11.8KB output
  * Interview (manual paste, 8 technical, Senior React Developer): HTTP 200, 43s, 6.3KB output
- TypeScript: 0 errors. ESLint: 0 errors. Dev server compiles cleanly.
- UI loads at HTTP 200 with no errors.

---
Task ID: 2
Agent: main
Task: Add "Ask about video" mode — interactive Q&A where the user asks any question about a loaded YouTube video; off-topic questions get rejected. Also verify auth gating (login → home, logout → login/signup).

Work Log:
- Added VideoContext interface + setVideoContext() action to chat store (src/store/chat.ts) so each conversation can carry its own loaded video transcript
- Created /api/youtube-load endpoint that returns transcript + metadata as JSON (used by the new mode to pre-load context)
- Updated /api/chat/route.ts to accept `videoContext` in the payload and inject a strict system prompt that:
  * Tells the model to ONLY answer from the transcript
  * Forces a fixed rejection message ("⚠️ This topic is not covered in this YouTube video...") for off-topic questions
  * Tells the model not to use general knowledge to fill gaps
- Added third mode "Ask about video" to YouTubeDialog (now 3-button toggle: Summary | Interview Q&A | Ask about video)
- Updated page.tsx handleYouTube to handle the new "ask" mode:
  * Calls /api/youtube-load to fetch transcript once
  * Stores result in conversation.videoContext via setVideoContext()
  * Posts a welcome message with video metadata + suggested questions
  * Same bot-block fallback as other modes (auto-reopens dialog with manual-paste option)
- Updated sendMessage to include videoContext in the /api/chat payload so subsequent chat messages automatically get the strict prompt
- Added a video-context banner above the chat area showing the loaded video's title and an "Exit video mode" button
- Verified auth gating: login → home screen, logout → LoginScreen. Already working correctly via the existing `if (!user) return <LoginScreen />` guard. Server-side /api/auth/me returns {user: null} after logout.

Stage Summary:
- All 4 end-to-end tests pass:
  1. On-topic question → answered from transcript with [MM:SS] timestamp reference (2.5s)
  2. Off-topic coding contest question → rejected with exact "topic not covered" message (2.0s)
  3. Off-topic geography question → rejected with same message (2.0s)
  4. No video context → normal chat works (regression check passed)
- Video load completes in <1s; chat responses in 2-3s thanks to the strict prompt keeping answers concise
- TypeScript: 0 errors. ESLint: 0 errors.
