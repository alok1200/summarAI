import { describe, it, expect } from "bun:test";
import {
  extractVideoId,
  parseTimeString,
  formatTime,
  parseUserTranscript,
  buildLanguageInstruction,
} from "../youtube-transcript";

describe("extractVideoId", () => {
  it("extracts from a watch URL", () => {
    expect(extractVideoId("https://www.youtube.com/watch?v=dQw4w9WgXcQ")).toBe(
      "dQw4w9WgXcQ"
    );
  });

  it("extracts from a youtu.be URL", () => {
    expect(extractVideoId("https://youtu.be/dQw4w9WgXcQ")).toBe(
      "dQw4w9WgXcQ"
    );
  });

  it("extracts from an embed URL", () => {
    expect(extractVideoId("https://www.youtube.com/embed/dQw4w9WgXcQ")).toBe(
      "dQw4w9WgXcQ"
    );
  });

  it("extracts from a shorts URL", () => {
    expect(extractVideoId("https://www.youtube.com/shorts/dQw4w9WgXcQ")).toBe(
      "dQw4w9WgXcQ"
    );
  });

  it("extracts from a live URL", () => {
    expect(extractVideoId("https://www.youtube.com/live/dQw4w9WgXcQ")).toBe(
      "dQw4w9WgXcQ"
    );
  });

  it("accepts a bare 11-char video ID", () => {
    expect(extractVideoId("dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
  });

  it("accepts a bare 11-char ID with surrounding whitespace", () => {
    expect(extractVideoId("  dQw4w9WgXcQ  ")).toBe("dQw4w9WgXcQ");
  });

  it("returns null for non-YouTube URLs", () => {
    expect(extractVideoId("https://example.com/foo")).toBeNull();
    expect(extractVideoId("not a url")).toBeNull();
    expect(extractVideoId("")).toBeNull();
  });

  it("returns null for a too-short ID", () => {
    expect(extractVideoId("shortid")).toBeNull();
  });

  it("returns null for a 10-char ID (must be exactly 11)", () => {
    expect(extractVideoId("abcdefghij")).toBeNull();
  });
});

describe("parseTimeString", () => {
  it("treats a bare number as MINUTES (not seconds)", () => {
    expect(parseTimeString("5")).toBe(300); // 5 min = 300 sec
    expect(parseTimeString("0")).toBe(0);
    expect(parseTimeString("90")).toBe(5400); // 90 min = 1.5 hours
  });

  it("parses MM:SS", () => {
    expect(parseTimeString("3:25")).toBe(205);
    expect(parseTimeString("12:08")).toBe(728);
    expect(parseTimeString("0:30")).toBe(30);
  });

  it("parses HH:MM:SS", () => {
    expect(parseTimeString("1:25:30")).toBe(5130);
    expect(parseTimeString("2:05:14")).toBe(7514);
    expect(parseTimeString("0:00:00")).toBe(0);
  });

  it("parses explicit 'm' suffix", () => {
    expect(parseTimeString("5m")).toBe(300);
    expect(parseTimeString("90m")).toBe(5400);
  });

  it("parses explicit 's' suffix", () => {
    expect(parseTimeString("30s")).toBe(30);
    expect(parseTimeString("90s")).toBe(90);
  });

  it("parses explicit 'h' suffix", () => {
    expect(parseTimeString("1h")).toBe(3600);
    expect(parseTimeString("2h")).toBe(7200);
  });

  it("parses compound 'h m s' forms", () => {
    expect(parseTimeString("1h30m")).toBe(5400);
    expect(parseTimeString("1h 30m")).toBe(5400);
    expect(parseTimeString("2h15m30s")).toBe(8130);
    expect(parseTimeString("1h30m15s")).toBe(5415);
  });

  it("returns undefined for empty / whitespace input", () => {
    expect(parseTimeString("")).toBeUndefined();
    expect(parseTimeString("   ")).toBeUndefined();
  });

  it("returns undefined for unparseable input", () => {
    expect(parseTimeString("foo")).toBeUndefined();
    expect(parseTimeString("abc:def")).toBeUndefined();
    expect(parseTimeString("1:2:3:4")).toBeUndefined();
  });

  it("returns undefined for non-numeric colon parts", () => {
    expect(parseTimeString("x:y")).toBeUndefined();
  });
});

describe("formatTime", () => {
  it("formats seconds as M:SS for short videos", () => {
    expect(formatTime(0)).toBe("0:00");
    expect(formatTime(5)).toBe("0:05");
    expect(formatTime(60)).toBe("1:00");
    expect(formatTime(205)).toBe("3:25");
    expect(formatTime(728)).toBe("12:08");
  });

  it("formats seconds as H:MM:SS for hour+ videos", () => {
    expect(formatTime(3600)).toBe("1:00:00");
    expect(formatTime(5130)).toBe("1:25:30");
    expect(formatTime(7514)).toBe("2:05:14");
  });

  it("zero-pads minutes and seconds", () => {
    expect(formatTime(601)).toBe("10:01");
    expect(formatTime(3661)).toBe("1:01:01");
  });

  it("truncates fractional seconds", () => {
    expect(formatTime(3.7)).toBe("0:03");
    expect(formatTime(205.99)).toBe("3:25");
  });
});

describe("parseUserTranscript", () => {
  it("parses '[MM:SS] text' lines", () => {
    const result = parseUserTranscript(
      "[0:00] Hello world\n[0:05] This is a test"
    );
    expect(result.hasTimestamps).toBe(true);
    expect(result.segments).toHaveLength(2);
    expect(result.segments[0]).toEqual({
      start: 0,
      dur: 5,
      text: "Hello world",
    });
    expect(result.segments[1]).toEqual({
      start: 5,
      dur: 5,
      text: "This is a test",
    });
  });

  it("parses 'MM:SS text' lines (without brackets)", () => {
    const result = parseUserTranscript("0:00 Hello\n1:30 World");
    expect(result.hasTimestamps).toBe(true);
    expect(result.segments[0].start).toBe(0);
    expect(result.segments[0].text).toBe("Hello");
    expect(result.segments[1].start).toBe(90);
    expect(result.segments[1].text).toBe("World");
  });

  it("parses HH:MM:SS lines", () => {
    const result = parseUserTranscript("[1:25:30] Chapter title");
    expect(result.hasTimestamps).toBe(true);
    expect(result.segments[0].start).toBe(5130);
    expect(result.segments[0].text).toBe("Chapter title");
  });

  it("handles plain-text lines without timestamps by giving them sequential 5s offsets", () => {
    const result = parseUserTranscript("First line\nSecond line\nThird line");
    expect(result.hasTimestamps).toBe(false);
    expect(result.segments).toHaveLength(3);
    expect(result.segments[0].start).toBe(0);
    expect(result.segments[1].start).toBe(5);
    expect(result.segments[2].start).toBe(10);
  });

  it("continues timestamp sequence after a timestamped line", () => {
    const result = parseUserTranscript(
      "[0:10] timestamped\nplain after\nanother plain"
    );
    expect(result.hasTimestamps).toBe(true);
    expect(result.segments).toHaveLength(3);
    expect(result.segments[0].start).toBe(10);
    expect(result.segments[1].start).toBe(10); // continues from last ts
    expect(result.segments[2].start).toBe(15); // +5 after the plain line
  });

  it("returns empty segments for empty input", () => {
    expect(parseUserTranscript("")).toEqual({ segments: [], hasTimestamps: false });
    expect(parseUserTranscript("   \n  \n")).toEqual({
      segments: [],
      hasTimestamps: false,
    });
  });
});

describe("buildLanguageInstruction", () => {
  it("returns empty string for undefined language", () => {
    expect(buildLanguageInstruction(undefined)).toBe("");
  });

  it("returns empty string for empty string language", () => {
    expect(buildLanguageInstruction("")).toBe("");
  });

  it("returns empty string for whitespace-only language", () => {
    expect(buildLanguageInstruction("   ")).toBe("");
  });

  it("returns a non-empty instruction block for 'Hindi'", () => {
    const out = buildLanguageInstruction("Hindi");
    expect(out).toContain("Hindi");
    expect(out).toContain("LANGUAGE INSTRUCTION");
    expect(out.length).toBeGreaterThan(100);
  });

  it("instructs the LLM to keep timestamps untranslated", () => {
    const out = buildLanguageInstruction("Spanish");
    expect(out.toLowerCase()).toContain("timestamp");
    expect(out).toContain("ORIGINAL form");
  });
});
