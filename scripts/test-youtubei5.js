import { Innertube } from 'youtubei.js';

async function test() {
  try {
    const yt = await Innertube.create();
    const videoId = "dQw4w9WgXcQ";

    // Use Innertube's session http to get player response with proper client identity
    const response = await yt.session.http.fetch("player", {
      method: "POST",
      body: JSON.stringify({
        context: yt.session.context,
        videoId,
      }),
    });

    console.log("Status:", response.status);
    const data = await response.json();
    console.log("Playability:", data?.playabilityStatus?.status);
    console.log("Title:", data?.videoDetails?.title);
    console.log("Has captions:", !!data?.captions);

    const tracks = data?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
    if (tracks) {
      console.log(`Found ${tracks.length} caption tracks`);
      for (const t of tracks) {
        console.log(`  - ${t.languageCode} (kind: ${t.kind || "manual"}) - ${t.name?.simpleText || t.name?.runs?.[0]?.text || ""}`);
      }
      // Fetch the first English track
      const enTrack = tracks.find(t => t.languageCode === "en" && t.kind !== "asr") ||
                      tracks.find(t => t.languageCode === "en") ||
                      tracks[0];
      console.log("\nFetching track:", enTrack.languageCode, enTrack.kind || "manual");

      // baseUrl from player API needs fmt=json3 to be set explicitly
      let url = enTrack.baseUrl;
      if (url.includes("fmt=")) {
        url = url.replace(/fmt=[^&]+/, "fmt=json3");
      } else {
        url += (url.includes("?") ? "&" : "?") + "fmt=json3";
      }
      console.log("Fetching:", url.slice(0, 120) + "...");

      const captionRes = await fetch(url);
      console.log("Caption status:", captionRes.status);
      const captionText = await captionRes.text();
      console.log("Caption text length:", captionText.length);
      console.log("First 200 chars:", captionText.slice(0, 200));
    }
  } catch (err) {
    console.error("Error:", err.message);
  }
}

test();
