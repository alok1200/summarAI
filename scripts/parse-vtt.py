#!/usr/bin/env python3
"""Parse the Hindi VTT captions, clean them, and prepare for summarization."""
import json, re, sys

with open("/tmp/captions.vtt") as f:
    vtt = f.read()

# Split into blocks
blocks = vtt.split("\n\n")
segments = []
for block in blocks:
    lines = block.strip().split("\n")
    if len(lines) < 2:
        continue
    ts_line = None
    text_lines = []
    for line in lines:
        if "-->" in line:
            ts_line = line
        elif ts_line:
            text_lines.append(line)
    if not (ts_line and text_lines):
        continue
    m = re.match(r'(\d+):(\d+):([\d.]+)\s*-->\s*(\d+):(\d+):([\d.]+)', ts_line)
    if not m:
        continue
    h1, m1, s1, h2, m2, s2 = m.groups()
    start = int(h1)*3600 + int(m1)*60 + float(s1)
    end = int(h2)*3600 + int(m2)*60 + float(s2)
    # Clean text — remove VTT timing tags like <00:00:00.760><c>
    text = " ".join(text_lines)
    text = re.sub(r'<[^>]+>', '', text)
    text = re.sub(r'\s+', ' ', text).strip()
    if not text:
        continue
    segments.append({"start": start, "end": end, "text": text})

# Filter out duplicate/empty segments (VTT has redundant "rollback" lines)
# Look at the pattern: each "real" segment is followed by a duplicate, then the next one starts
cleaned = []
last_text = None
for s in segments:
    # Skip if it's just a fragment of the previous (the VTT format shows partial words too)
    if s["text"] == last_text:
        continue
    cleaned.append(s)
    last_text = s["text"]

# Merge consecutive segments with same starting text (VTT incremental reveal)
# Each segment seems to be: "full text so far\nnew words"
# Take only the longest text per time block
merged = []
i = 0
while i < len(cleaned):
    s = cleaned[i]
    # Look ahead for segments that contain this text as a prefix
    j = i + 1
    while j < len(cleaned) and j < i + 4:
        next_s = cleaned[j]
        # If next text starts with this text or this text is a prefix of next
        if next_s["text"].startswith(s["text"]) or s["text"].startswith(next_s["text"]):
            if len(next_s["text"]) > len(s["text"]):
                s = next_s
            j += 1
        else:
            break
    merged.append(s)
    i = j

print(f"Original: {len(segments)} segments")
print(f"After dedup: {len(cleaned)}")
print(f"After merge: {len(merged)}")
print(f"Total chars: {sum(len(s['text']) for s in merged)}")
print(f"Duration: {merged[-1]['end']:.0f}s = {merged[-1]['end']/60:.1f}min")

# Save merged transcript
with open("/tmp/yt-transcript.json", "w") as f:
    json.dump(merged, f, indent=2, ensure_ascii=False)

# Build a plain-text version for summarization
with open("/tmp/yt-transcript.txt", "w") as f:
    for s in merged:
        mm = int(s["start"] // 60)
        ss = int(s["start"] % 60)
        f.write(f"[{mm:02d}:{ss:02d}] {s['text']}\n")

print("\nFirst 10 segments:")
for s in merged[:10]:
    mm = int(s["start"] // 60)
    ss = int(s["start"] % 60)
    print(f"  [{mm:02d}:{ss:02d}] {s['text'][:100]}")

print("\nLast 5 segments:")
for s in merged[-5:]:
    mm = int(s["start"] // 60)
    ss = int(s["start"] % 60)
    print(f"  [{mm:02d}:{ss:02d}] {s['text'][:100]}")

# Sample middle
print("\nMiddle segments (around 15:00):")
for s in merged:
    if 890 < s["start"] < 910:
        mm = int(s["start"] // 60)
        ss = int(s["start"] % 60)
        print(f"  [{mm:02d}:{ss:02d}] {s['text'][:120]}")
