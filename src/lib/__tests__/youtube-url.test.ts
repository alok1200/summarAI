import { describe, it, expect } from "bun:test";
import {
  detectYouTubeUrl,
  detectLanguage,
  extractVideoIdFromUrl,
  extractInstructions,
} from "../youtube-url";

describe("detectYouTubeUrl", () => {
  it("detects a watch URL with v= param", () => {
    expect(
      detectYouTubeUrl("check https://www.youtube.com/watch?v=dQw4w9WgXcQ out")
    ).toBe("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
  });

  it("detects a youtu.be short URL", () => {
    expect(detectYouTubeUrl("https://youtu.be/dQw4w9WgXcQ")).toBe(
      "https://youtu.be/dQw4w9WgXcQ"
    );
  });

  it("detects an embed URL", () => {
    expect(
      detectYouTubeUrl("see https://www.youtube.com/embed/dQw4w9WgXcQ")
    ).toBe("https://www.youtube.com/embed/dQw4w9WgXcQ");
  });

  it("detects a shorts URL", () => {
    expect(
      detectYouTubeUrl("https://www.youtube.com/shorts/abc123XYZ_4")
    ).toBe("https://www.youtube.com/shorts/abc123XYZ_4");
  });

  it("detects a live URL", () => {
    expect(
      detectYouTubeUrl("https://www.youtube.com/live/abc123XYZ_4")
    ).toBe("https://www.youtube.com/live/abc123XYZ_4");
  });

  it("preserves trailing query params like &t=120s", () => {
    expect(
      detectYouTubeUrl(
        "https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=120s&feature=share"
      )
    ).toBe(
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=120s&feature=share"
    );
  });

  it("returns null for non-YouTube URLs", () => {
    expect(detectYouTubeUrl("https://example.com/foo")).toBeNull();
    expect(detectYouTubeUrl("https://vimeo.com/12345")).toBeNull();
    expect(detectYouTubeUrl("hello world")).toBeNull();
    expect(detectYouTubeUrl("")).toBeNull();
  });

  it("returns null for a YouTube URL with a malformed video ID (wrong length)", () => {
    // 10 chars instead of 11 — none of the patterns should match.
    expect(
      detectYouTubeUrl("https://www.youtube.com/watch?v=shortid12")
    ).toBeNull();
  });
});

describe("extractVideoIdFromUrl", () => {
  it("extracts from a watch URL", () => {
    expect(
      extractVideoIdFromUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ")
    ).toBe("dQw4w9WgXcQ");
  });

  it("extracts from a youtu.be URL", () => {
    expect(extractVideoIdFromUrl("https://youtu.be/dQw4w9WgXcQ")).toBe(
      "dQw4w9WgXcQ"
    );
  });

  it("extracts from an embed URL", () => {
    expect(
      extractVideoIdFromUrl("https://www.youtube.com/embed/dQw4w9WgXcQ")
    ).toBe("dQw4w9WgXcQ");
  });

  it("extracts from a shorts URL", () => {
    expect(
      extractVideoIdFromUrl("https://www.youtube.com/shorts/dQw4w9WgXcQ")
    ).toBe("dQw4w9WgXcQ");
  });

  it("extracts from a live URL", () => {
    expect(
      extractVideoIdFromUrl("https://www.youtube.com/live/dQw4w9WgXcQ")
    ).toBe("dQw4w9WgXcQ");
  });

  it("returns empty string for a non-YouTube URL", () => {
    expect(extractVideoIdFromUrl("https://example.com/foo")).toBe("");
  });

  it("returns empty string for a YouTube URL without an ID", () => {
    expect(extractVideoIdFromUrl("https://www.youtube.com/")).toBe("");
  });
});

describe("detectLanguage", () => {
  it("detects 'in Hindi'", () => {
    expect(detectLanguage("summarize this in Hindi: https://youtu.be/x")).toBe(
      "Hindi"
    );
  });

  it("detects 'in Spanish'", () => {
    expect(detectLanguage("summarize in Spanish")).toBe("Spanish");
  });

  it("detects 'in French'", () => {
    expect(detectLanguage("in French please")).toBe("French");
  });

  it("filters out programming languages (Python)", () => {
    expect(detectLanguage("summarize this in Python")).toBeUndefined();
  });

  it("filters out programming languages (JavaScript)", () => {
    expect(detectLanguage("explain in JavaScript")).toBeUndefined();
  });

  it("filters out programming languages (TypeScript)", () => {
    expect(detectLanguage("in TypeScript")).toBeUndefined();
  });

  it("returns undefined when no language hint is present", () => {
    expect(detectLanguage("summarize this video")).toBeUndefined();
    expect(detectLanguage("")).toBeUndefined();
  });

  it("does not match lowercase 'in' as language hint", () => {
    // 'in' must be followed by a Capitalized word.
    expect(detectLanguage("jump in the pool")).toBeUndefined();
  });
});

describe("extractInstructions", () => {
  it("removes the YouTube URL and returns the rest", () => {
    expect(
      extractInstructions(
        "summarize https://youtu.be/dQw4w9WgXcQ focus on the React parts",
        "https://youtu.be/dQw4w9WgXcQ"
      )
    ).toBe("focus on the React parts");
  });

  it("removes a 'summarize this video:' prefix", () => {
    expect(
      extractInstructions(
        "summarize this video: https://youtu.be/dQw4w9WgXcQ",
        "https://youtu.be/dQw4w9WgXcQ"
      )
    ).toBe("");
  });

  it("removes a 'tl;dr' prefix", () => {
    expect(
      extractInstructions(
        "tl;dr https://youtu.be/dQw4w9WgXcQ",
        "https://youtu.be/dQw4w9WgXcQ"
      )
    ).toBe("");
  });

  it("removes a 'summarize this' prefix and language hint", () => {
    expect(
      extractInstructions(
        "summarize this in Hindi: https://youtu.be/dQw4w9WgXcQ focus on hooks",
        "https://youtu.be/dQw4w9WgXcQ"
      )
    ).toBe("focus on hooks");
  });

  it("returns empty string when the message was just the URL", () => {
    expect(
      extractInstructions(
        "https://youtu.be/dQw4w9WgXcQ",
        "https://youtu.be/dQw4w9WgXcQ"
      )
    ).toBe("");
  });
});
