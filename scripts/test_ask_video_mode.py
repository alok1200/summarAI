#!/usr/bin/env python3
"""End-to-end test of the 'Ask about video' mode.

Tests two scenarios:
1. On-topic question: "What is the main topic of this video?" — should answer.
2. Off-topic question: "Tell me about the 2024 Olympics coding contest." — should reply with the off-topic rejection message.

Sends the same videoContext payload that the React client sends in production.
"""
import json
import subprocess
import sys

# Load the video context saved by the previous step
with open("/tmp/vc.json") as f:
    vc = json.load(f)

# Read the auth cookie
cookie_arg = "-b /tmp/c3.txt"

def chat(question: str, video_context: dict | None) -> str:
    payload = {
        "messages": [{"role": "user", "content": question}],
    }
    if video_context:
        payload["videoContext"] = video_context
    body = json.dumps(payload)
    cmd = [
        "curl", "-s", "-b", "/tmp/c3.txt",
        "-X", "POST", "http://localhost:3000/api/chat",
        "-H", "Content-Type: application/json",
        "-d", body,
        "--max-time", "60",
        "-w", "\n---HTTP %{http_code} (%{time_total}s)---",
    ]
    result = subprocess.run(cmd, capture_output=True, text=True)
    return result.stdout

print("=" * 70)
print("TEST 1: On-topic question (should be answered from transcript)")
print("=" * 70)
q1 = "What is the main message or theme of this video? Answer in one sentence."
resp1 = chat(q1, vc)
print(resp1[:1500])
print()

print("=" * 70)
print("TEST 2: Off-topic question (should be rejected)")
print("=" * 70)
q2 = "Tell me how to solve a dynamic programming problem for an upcoming coding contest."
resp2 = chat(q2, vc)
print(resp2[:1500])
print()

print("=" * 70)
print("TEST 3: Off-topic question 2 (different domain)")
print("=" * 70)
q3 = "What's the capital of France?"
resp3 = chat(q3, vc)
print(resp3[:1500])
print()

print("=" * 70)
print("TEST 4: No video context — normal chat (should answer normally)")
print("=" * 70)
q4 = "What's the capital of France?"
resp4 = chat(q4, None)
print(resp4[:1500])
