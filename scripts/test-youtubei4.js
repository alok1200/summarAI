import { Innertube } from 'youtubei.js';

async function test() {
  try {
    // Create Innertube to get proper session/headers (evades bot detection)
    const yt = await Innertube.create();
    console.log("Innertube session created");
    console.log("Client name:", yt.session.context.client.clientName);
    console.log("Client version:", yt.session.context.client.clientVersion);

    // Use Innertube's session to call the player API directly
    const videoId = "dQw4w9WgXcQ";
    console.log(`\nCalling player API for ${videoId}...`);

    const playerResponse = await yt.session.http.fetch("/youtubei/v1/player", {
      method: "POST",
      body: JSON.stringify({
        context: yt.session.context,
        videoId,
      }),
      headers: {
        "Content-Type": "application/json",
      },
    });

    console.log("Player status:", playerResponse.status);
    const data = await playerResponse.json();
    console.log("Playability status:", data?.playabilityStatus?.status);
    console.log("Video title:", data?.videoDetails?.title);
    console.log("Has captions:", !!data?.captions);

    if (data?.captions?.playerCaptionsTracklistRenderer?.captionTracks) {
      const tracks = data.captions.playerCaptionsTracklistRenderer.captionTracks;
      console.log(`Found ${tracks.length} caption tracks`);
      console.log("First track:", JSON.stringify({
        lang: tracks[0].languageCode,
        kind: tracks[0].kind,
        name: tracks[0]?.name?.simpleText,
        baseUrl: tracks[0].baseUrl?.slice(0, 100),
      }, null, 2));
    }
  } catch (err) {
    console.error("Error:", err.message);
    console.error(err.stack);
  }
}

test();
