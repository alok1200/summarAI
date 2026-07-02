import { Innertube } from 'youtubei.js';

async function test() {
  try {
    const yt = await Innertube.create();
    const videoId = "dQw4w9WgXcQ";
    console.log("Fetching FULL info...");
    const info = await yt.getInfo(videoId);
    console.log("✓ Title:", info.basic_info?.title);
    console.log("Has streaming_data:", !!info.streaming_data);

    // Look for caption tracks via the player_response
    const playerResponse = info.player_response || {};
    const captions = playerResponse.captions;
    console.log("Has captions:", !!captions);
    if (captions) {
      const tracks = captions?.playerCaptionsTracklistRenderer?.captionTracks;
      console.log("Tracks count:", tracks?.length);
      if (tracks?.length) {
        console.log("First track:", JSON.stringify({
          lang: tracks[0].languageCode,
          kind: tracks[0].kind,
          baseUrl: tracks[0].baseUrl?.slice(0, 100),
        }, null, 2));
      }
    } else {
      console.log("Keys on player_response:", Object.keys(playerResponse).slice(0, 20));
    }

    // Try `toDash` and look at the original raw data
    console.log("Storyboard?", !!info.storyboard);
  } catch (err) {
    console.error("Error:", err.message);
  }
}

test();
