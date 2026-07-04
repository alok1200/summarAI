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

---
Task ID: youtube-502-fix
Agent: main
Task: Fix the 502 error during YouTube interview Q&A generation, and verify both pending tasks (conversational YouTube Q&A + auth-based routing) are working.

Work Log:
- Explored the auth setup, chat architecture, and YouTube flow via the Explore subagent
- Discovered that Task A (conversational Q&A about YouTube) was already implemented via /api/youtube-load + /api/chat (buildVideoSystemPrompt + VIDEO_OFF_TOPIC_REPLY)
- Discovered that Task B (auth-based routing) was already implemented via client-side auth gate in page.tsx (if !user return <LoginScreen />)
- Identified the real issue: 502 error from the LLM gateway (Z.ai SDK) with no retry logic
- Created /home/z/my-project/src/lib/llm.ts — shared LLM helper with withRetry() that retries on 502/503/504/520/521/522/524/network errors using exponential backoff (3 attempts, 1.2s base delay, 6s max)
- Refactored /api/youtube-interview/route.ts to use chatComplete() + streamTextResponse() from the shared lib (removed duplicated streamTextResponse and ZAI import)
- Refactored /api/youtube-summary/route.ts the same way
- Refactored /api/chat/route.ts to use chatComplete() + visionComplete() with built-in retry
- Added friendlier error messages for transient gateway errors so users see "The AI service is temporarily unavailable..." instead of "Request failed: 502"
- TypeScript compiles clean (tsc --noEmit)
- ESLint passes clean (eslint .)
- Started dev server on port 3001 and ran end-to-end tests:
  * YouTube interview with manual transcript → 200 OK, 4.5KB structured Q&A with cheat-sheet
  * /api/chat with videoContext + in-scope question → 200 OK, answer with [1:58] timestamp reference
  * /api/chat with videoContext + out-of-scope question (weather + coding contest) → 200 OK, exact "⚠️ This topic is not covered in this YouTube video..." reply
  * /api/chat with videoContext + explicit "give me interview questions" request → 200 OK, generates 4 Q&A pairs from the transcript
  * /api/auth/me without cookie → {"user":null} (triggers LoginScreen client-side)
  * /api/auth/signup → creates user, sets cookie, returns user
  * /api/auth/me with cookie → returns the logged-in user (triggers home screen client-side)
  * /api/auth/logout → destroys session, cookie cleared
- Cleaned up test user from DB
- Stopped dev server

Stage Summary:
- The 502 error was a transient LLM gateway failure with no retry — now all 3 LLM-calling routes (/api/chat, /api/youtube-summary, /api/youtube-interview) use the shared chatComplete/visionComplete helpers which auto-retry on 502/503/504/network errors with exponential backoff.
- Task A (conversational Q&A about YouTube) is fully working: in-scope questions get timestamped answers; out-of-scope questions (weather, coding contests, general knowledge, etc.) get the exact "⚠️ This topic is not covered in this YouTube video..." reply; explicit requests for interview questions get generated Q&A.
- Task B (auth-based routing) is fully working: logged-out users see ONLY the LoginScreen (with login + signup tabs), logged-in users see the home/chat screen. The auth gate is in page.tsx lines 513-523.
- Files created: /home/z/my-project/src/lib/llm.ts
- Files modified: /home/z/my-project/src/app/api/youtube-interview/route.ts, /home/z/my-project/src/app/api/youtube-summary/route.ts, /home/z/my-project/src/app/api/chat/route.ts
