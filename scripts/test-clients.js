// Test different YouTube client identities against a bot-blocked video.
const VIDEO_ID = process.argv[2] || "arj7oStGLkU"; // TED talk (currently blocked)

const UA_WEB =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

async function tryClient(name, context, headers) {
  const t0 = Date.now();
  try {
    const res = await fetch(
      "https://www.youtube.com/youtubei/v1/player?prettyPrint=false",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify({ context, videoId: VIDEO_ID }),
      }
    );
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      console.log(
        `✗ ${name}: HTTP ${res.status}, body not JSON (${text.slice(0, 80)}...)`
      );
      return;
    }
    const status = json?.playabilityStatus?.status;
    const reason =
      json?.playabilityStatus?.reason ||
      json?.playabilityStatus?.messages?.[0] ||
      "";
    const tracks =
      json?.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [];
    console.log(
      `· ${name}: HTTP ${res.status} | playability=${status} | tracks=${tracks.length}` +
        (reason ? ` | reason="${reason}"` : "") +
        ` | ${Date.now() - t0}ms`
    );
  } catch (e) {
    console.log(`✗ ${name}: ${e.message}`);
  }
}

(async () => {
  console.log(`Testing clients for videoId=${VIDEO_ID}\n`);

  // 1. ANDROID
  await tryClient(
    "ANDROID",
    {
      client: {
        clientName: "ANDROID",
        clientVersion: "20.10.38",
        androidSdkVersion: 30,
        hl: "en",
        gl: "US",
      },
    },
    {
      "User-Agent":
        "com.google.android.youtube/20.10.38 (Linux; U; Android 11) gzip",
    }
  );

  // 2. ANDROID (newer version)
  await tryClient(
    "ANDROID v19.09.37",
    {
      client: {
        clientName: "ANDROID",
        clientVersion: "19.09.37",
        androidSdkVersion: 30,
        hl: "en",
        gl: "US",
      },
    },
    {
      "User-Agent":
        "com.google.android.youtube/19.09.37 (Linux; U; Android 11) gzip",
    }
  );

  // 3. iOS
  await tryClient(
    "IOS",
    {
      client: {
        clientName: "IOS",
        clientVersion: "20.10.4",
        deviceModel: "iPhone16,2",
        hl: "en",
        gl: "US",
      },
    },
    {
      "User-Agent":
        "com.google.ios.youtube/20.10.4 (iPhone16,2; U; CPU iOS 17_4 like Mac OS X)",
    }
  );

  // 4. TVHTML5 SIMPLY_EMBEDDED_PLAYER (often works for embedded videos)
  await tryClient(
    "TVHTML5_SIMPLY_EMBEDDED_PLAYER",
    {
      client: {
        clientName: "TVHTML5_SIMPLY_EMBEDDED_PLAYER",
        clientVersion: "2.0",
        hl: "en",
        gl: "US",
      },
    },
    {
      "User-Agent":
        "Mozilla/5.0 (PlayStation; PlayStation 4/12.00) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
      // Some clients require a visitor data / PoToken. Try without first.
    }
  );

  // 5. MWEB (mobile web)
  await tryClient(
    "MWEB",
    {
      client: {
        clientName: "MWEB",
        clientVersion: "2.20241201.00.00",
        hl: "en",
        gl: "US",
      },
    },
    {
      "User-Agent":
        "Mozilla/5.0 (Linux; Android 11; Pixel 5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36",
    }
  );

  // 6. WEB_EMBEDDED (without PoToken - probably fails)
  await tryClient(
    "WEB_EMBEDDED",
    {
      client: {
        clientName: "WEB_EMBEDDED_PLAYER",
        clientVersion: "1.20241201.00.00",
        hl: "en",
        gl: "US",
      },
    },
    { "User-Agent": UA_WEB }
  );

  // 7. WEB with proper visitor data (scrape watch page first to get visitorData)
  console.log("\n--- Trying WEB client with visitor data from watch page ---");
  try {
    const t0 = Date.now();
    const wpRes = await fetch(`https://www.youtube.com/watch?v=${VIDEO_ID}`, {
      headers: {
        "User-Agent": UA_WEB,
        "Accept-Language": "en-US,en;q=0.9",
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
      },
    });
    const html = await wpRes.text();
    console.log(
      `  Watch page: HTTP ${wpRes.status}, ${html.length} bytes, ${Date.now() - t0}ms`
    );

    if (html.includes("g-recaptcha") || html.length < 10000) {
      console.log("  Watch page returned CAPTCHA / blocked");
    } else {
      const visitorMatch = html.match(/"visitorData":"([^"]+)"/);
      const clientVersionMatch = html.match(
        /"INNERTUBE_CONTEXT_CLIENT_VERSION":"([^"]+)"/
      );
      const visitorData = visitorMatch?.[1];
      const clientVersion = clientVersionMatch?.[1] || "2.20241201.00.00";
      console.log(
        `  visitorData=${visitorData ? "found" : "NOT found"}, clientVersion=${clientVersion}`
      );

      // Try WEB client with proper visitor data + cookies
      const cookieHeader = wpRes.headers
        .getSetCookie()
        ?.map((c) => c.split(";")[0])
        .join("; ");
      console.log(`  cookies: ${cookieHeader?.slice(0, 100) ?? "(none)"}`);

      await tryClient(
        "WEB (with visitorData + cookies)",
        {
          client: {
            clientName: "WEB",
            clientVersion,
            hl: "en",
            gl: "US",
            visitorData,
          },
        },
        {
          "User-Agent": UA_WEB,
          "Accept-Language": "en-US,en;q=0.9",
          Origin: "https://www.youtube.com",
          Referer: `https://www.youtube.com/watch?v=${VIDEO_ID}`,
          Cookie: cookieHeader ?? "",
        }
      );
    }
  } catch (e) {
    console.log(`  Watch page scrape failed: ${e.message}`);
  }
})();
