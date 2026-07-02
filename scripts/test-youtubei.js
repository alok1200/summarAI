import { Innertube } from 'youtubei.js';

async function test() {
  try {
    console.log("Creating Innertube instance...");
    const yt = await Innertube.create();
    console.log("✓ Innertube created");

    const videoId = "dQw4w9WgXcQ";
    console.log(`Fetching info for ${videoId}...`);
    const info = await yt.getInfo(videoId);
    console.log("✓ Got video info");
    console.log("  Title:", info.basic_info?.title);
    console.log("  Duration:", info.basic_info?.duration, "seconds");

    console.log("Fetching transcript...");
    const transcript = await info.getTranscript();
    console.log("✓ Got transcript");
    console.log("  Languages:", transcript.languages);
    console.log("  Selected:", transcript.selectedLanguage);

    const segments = transcript.transcript?.content?.initial_segments || [];
    console.log(`✓ Found ${segments.length} segments`);
    if (segments.length > 0) {
      const first = segments[0];
      console.log("  First segment:", {
        start_ms: first.start_ms,
        end_ms: first.end_ms,
        text: first.snippet?.text,
      });
    }
  } catch (err) {
    console.error("✗ Error:", err.message);
    console.error(err.stack);
  }
}

test();
