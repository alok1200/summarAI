import { Innertube } from 'youtubei.js';

async function test() {
  try {
    // Force US region
    const yt = await Innertube.create({
      location: "US",
      lang: "en",
    });
    console.log("Location:", yt.session.context.client.gl);
    console.log("Lang:", yt.session.context.client.hl);

    const videoId = "dQw4w9WgXcQ";
    const response = await yt.session.http.fetch("player", {
      method: "POST",
      body: JSON.stringify({
        context: yt.session.context,
        videoId,
      }),
    });

    const data = await response.json();
    console.log("Playability:", data?.playabilityStatus?.status);
    console.log("Has captions:", !!data?.captions);
    if (data?.captions?.playerCaptionsTracklistRenderer?.captionTracks) {
      const tracks = data.captions.playerCaptionsTracklistRenderer.captionTracks;
      console.log(`Found ${tracks.length} caption tracks`);
      console.log(`First: ${tracks[0].languageCode} (${tracks[0].kind || "manual"})`);
    }
  } catch (err) {
    console.error("Error:", err.message);
  }
}

test();
