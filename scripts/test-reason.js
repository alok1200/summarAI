async function test() {
  // Use the ANDROID player API like the existing code does
  const body = {
    context: {
      client: {
        clientName: "ANDROID",
        clientVersion: "20.10.38",
        androidSdkVersion: 30,
        hl: "en",
        gl: "US",
      },
    },
    videoId: "dQw4w9WgXcQ",
  };
  const res = await fetch("https://www.youtube.com/youtubei/v1/player?prettyPrint=false", {
    method: "POST",
    headers: {
      "User-Agent": "com.google.android.youtube/20.10.38 (Linux; U; Android 11) gzip",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  console.log("Status:", res.status);
  const data = await res.json();
  console.log("Playability:", data?.playabilityStatus?.status);
  console.log("Reason:", data?.playabilityStatus?.reason);
  console.log("Has captions:", !!data?.captions);
  if (data?.captions?.playerCaptionsTracklistRenderer?.captionTracks) {
    const tracks = data.captions.playerCaptionsTracklistRenderer.captionTracks;
    console.log(`Found ${tracks.length} caption tracks`);
    console.log(`First: ${tracks[0].languageCode} (${tracks[0].kind || "manual"})`);

    // Fetch the actual caption
    let url = tracks[0].baseUrl;
    if (url.includes("fmt=")) url = url.replace(/fmt=[^&]+/, "fmt=json3");
    else url += (url.includes("?") ? "&" : "?") + "fmt=json3";
    console.log("\nFetching caption:", url.slice(0, 80) + "...");
    const captionRes = await fetch(url, {
      headers: { "User-Agent": "com.google.android.youtube/20.10.38 (Linux; U; Android 11) gzip" },
    });
    console.log("Caption status:", captionRes.status);
    const captionText = await captionRes.text();
    console.log("Caption length:", captionText.length);
    console.log("First 200 chars:", captionText.slice(0, 200));
  }
}

test().catch(e => console.error(e));
