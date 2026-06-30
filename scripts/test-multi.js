import { Innertube } from 'youtubei.js';

async function tryClient(clientName, videoId) {
  try {
    const yt = await Innertube.create({
      client: clientName,
      retrieve_player: false,
    });
    console.log(`\n[${clientName}] session created`);
    console.log(`[${clientName}] context:`, JSON.stringify(yt.session.context.client));

    const response = await yt.session.http.fetch("player", {
      method: "POST",
      body: JSON.stringify({
        context: yt.session.context,
        videoId,
      }),
    });

    const data = await response.json();
    const status = data?.playabilityStatus?.status;
    console.log(`[${clientName}] playability:`, status);
    console.log(`[${clientName}] has captions:`, !!data?.captions);

    if (data?.captions?.playerCaptionsTracklistRenderer?.captionTracks) {
      const tracks = data.captions.playerCaptionsTracklistRenderer.captionTracks;
      console.log(`[${clientName}] tracks:`, tracks.length);
      console.log(`[${clientName}] first track:`, tracks[0]?.languageCode, tracks[0]?.kind || "manual");
      return tracks;
    }
    return null;
  } catch (err) {
    console.error(`[${clientName}] Error:`, err.message);
    return null;
  }
}

async function test() {
  const videoId = "dQw4w9WgXcQ";
  for (const c of ["WEB", "ANDROID", "IOS", "TVHTML5", "MWEB"]) {
    await tryClient(c, videoId);
  }
}

test();
