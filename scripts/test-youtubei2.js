import { Innertube } from 'youtubei.js';

async function test() {
  try {
    const yt = await Innertube.create();
    const videoId = "dQw4w9WgXcQ";
    console.log("Fetching basic info...");
    const info = await yt.getBasicInfo(videoId);
    console.log("✓ Title:", info.basic_info?.title);

    // Look for caption tracks in the player response
    const playerData = info.player_response || info.page;
    const captions = info.player_response?.captions;
    console.log("Has captions:", !!captions);
    if (captions) {
      const tracks = captions?.playerCaptionsTracklistRenderer?.captionTracks;
      console.log("Tracks:", JSON.stringify(tracks?.map(t => ({
        lang: t.languageCode,
        kind: t.kind,
        baseUrl: t.baseUrl?.slice(0, 80),
      })), null, 2));
    }
  } catch (err) {
    console.error("Error:", err.message);
  }
}

test();
