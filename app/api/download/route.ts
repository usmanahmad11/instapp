import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 30;

interface MediaItem {
  type: "image" | "video";
  url: string;
  thumbnail?: string;
}

export async function POST(req: NextRequest) {
  try {
    const { url } = await req.json();

    if (!url || typeof url !== "string") {
      return NextResponse.json({ error: "URL is required" }, { status: 400 });
    }

    if (!/^https?:\/\/(www\.)?instagram\.com\/(p|reel|reels)\/[\w-]+/i.test(url)) {
      return NextResponse.json({ error: "Invalid Instagram URL" }, { status: 400 });
    }

    const cleanUrl = url.split("?")[0].replace(/\/$/, "") + "/";
    const debug: string[] = [];

    const items = await extractAllMedia(cleanUrl, debug);

    if (!items || items.length === 0) {
      return NextResponse.json(
        { error: "Could not extract media. The post may be private or unavailable.", debug },
        { status: 404 }
      );
    }

    return NextResponse.json({ items });
  } catch (error) {
    return NextResponse.json(
      { error: "Server error.", debug: [String(error)] },
      { status: 500 }
    );
  }
}

// ── Pipeline ─────────────────────────────────────────────────────────────────

async function extractAllMedia(url: string, debug: string[]): Promise<MediaItem[]> {
  // Method 1: Cobalt API (open-source media download service)
  try {
    const items = await fetchFromCobalt(url, debug);
    if (items.length > 0) return items;
  } catch (e) { debug.push(`cobalt exception: ${e}`); }

  // Method 2: AllOrigins proxy + embed page scraping
  try {
    const items = await fetchFromAllOrigins(url, debug);
    if (items.length > 0) return items;
  } catch (e) { debug.push(`allorigins exception: ${e}`); }

  // Method 3: Direct page scraping with crawler UAs
  try {
    const items = await fetchFromPage(url, debug);
    if (items.length > 0) return items;
  } catch (e) { debug.push(`page exception: ${e}`); }

  return [];
}

// ── Method 1: Cobalt API ─────────────────────────────────────────────────────
// https://github.com/imputnet/cobalt — free, open-source

async function fetchFromCobalt(url: string, debug: string[]): Promise<MediaItem[]> {
  const cobaltEndpoints = [
    "https://api.cobalt.tools/",
    "https://cobalt-api.kwiatekmiki.com/",
  ];

  for (const endpoint of cobaltEndpoints) {
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          "User-Agent": "InstaGrab/1.0",
        },
        body: JSON.stringify({ url, videoQuality: "1080" }),
      });

      debug.push(`cobalt ${endpoint}: ${res.status}`);

      if (!res.ok) {
        const errText = await res.text().catch(() => "");
        debug.push(`cobalt body: ${errText.substring(0, 150)}`);
        continue;
      }

      const data = await res.json();
      debug.push(`cobalt status: ${data.status}`);

      if (data.status === "error") {
        debug.push(`cobalt error: ${JSON.stringify(data.error || data).substring(0, 150)}`);
        continue;
      }

      const items: MediaItem[] = [];

      // "redirect" or "tunnel" = single media
      if ((data.status === "redirect" || data.status === "tunnel" || data.status === "stream") && data.url) {
        const isVideo = data.url.includes(".mp4") || data.url.includes("video") || url.includes("/reel");
        items.push({
          type: isVideo ? "video" : "image",
          url: data.url,
          thumbnail: data.thumb || undefined,
        });
      }

      // "picker" = carousel / multiple items
      if (data.status === "picker" && Array.isArray(data.picker)) {
        for (const p of data.picker) {
          items.push({
            type: p.type === "video" ? "video" : "image",
            url: p.url,
            thumbnail: p.thumb || undefined,
          });
        }
      }

      if (items.length > 0) return items;
    } catch (e) {
      debug.push(`cobalt ${endpoint} err: ${e}`);
    }
  }

  return [];
}

// ── Method 2: AllOrigins proxy + Instagram embed page ────────────────────────

async function fetchFromAllOrigins(url: string, debug: string[]): Promise<MediaItem[]> {
  const embedUrl = url.replace(/\/$/, "") + "/embed/captioned/";

  const proxies = [
    `https://api.allorigins.win/raw?url=${encodeURIComponent(embedUrl)}`,
    `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(embedUrl)}`,
  ];

  for (const proxyUrl of proxies) {
    try {
      const res = await fetch(proxyUrl, {
        headers: { Accept: "text/html" },
      });

      debug.push(`proxy ${new URL(proxyUrl).hostname}: ${res.status}`);
      if (!res.ok) continue;

      const html = await res.text();
      if (html.includes("/accounts/login") && !html.includes("display_url")) {
        debug.push("proxy: got login page");
        continue;
      }

      const items = extractFromHtml(html);
      if (items.length > 0) {
        debug.push(`proxy: found ${items.length} items`);
        return items;
      }

      debug.push(`proxy: no items (html len: ${html.length})`);
    } catch (e) {
      debug.push(`proxy err: ${e}`);
    }
  }

  return [];
}

// ── Method 3: Direct page scraping ───────────────────────────────────────────

async function fetchFromPage(url: string, debug: string[]): Promise<MediaItem[]> {
  const uas = [
    "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)",
    "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
  ];

  for (let i = 0; i < uas.length; i++) {
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": uas[i], Accept: "text/html" },
        redirect: "follow",
      });

      debug.push(`page ua${i}: ${res.status}`);
      if (!res.ok) continue;

      const html = await res.text();
      if (html.includes("/accounts/login") && !html.includes("og:image")) continue;

      const items = extractFromHtml(html);
      if (items.length > 0) return items;
    } catch (e) {
      debug.push(`page ua${i}: ${e}`);
    }
  }

  return [];
}

// ── HTML extraction ──────────────────────────────────────────────────────────

function extractFromHtml(html: string): MediaItem[] {
  const items: MediaItem[] = [];
  const seen = new Set<string>();

  const decode = (s: string) =>
    s.replace(/\\u0026/g, "&").replace(/\\u002F/g, "/").replace(/\\\//g, "/");

  // Video URLs
  const videoRegex = /"video_url"\s*:\s*"([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = videoRegex.exec(html)) !== null) {
    const u = decode(m[1]);
    if (!seen.has(u)) { seen.add(u); items.push({ type: "video", url: u }); }
  }

  // High-res images from display_resources
  const drRegex = /"display_resources"\s*:\s*\[([^\]]+)\]/g;
  while ((m = drRegex.exec(html)) !== null) {
    try {
      const arr = JSON.parse("[" + m[1] + "]");
      if (Array.isArray(arr) && arr.length > 0) {
        arr.sort((a: { config_width: number }, b: { config_width: number }) =>
          b.config_width - a.config_width
        );
        const u = decode(arr[0].src);
        if (!seen.has(u)) { seen.add(u); items.push({ type: "image", url: u }); }
      }
    } catch { /* skip */ }
  }

  // display_url fallback
  const duRegex = /"display_url"\s*:\s*"([^"]+)"/g;
  while ((m = duRegex.exec(html)) !== null) {
    const u = decode(m[1]);
    if (!seen.has(u)) { seen.add(u); items.push({ type: "image", url: u }); }
  }

  if (items.length > 0) return items;

  // og: meta tags (last resort)
  const ogVid = html.match(
    /<meta[^>]*property=["']og:video(?::secure_url)?["'][^>]*content=["']([^"']+)["']/
  );
  if (ogVid) items.push({ type: "video", url: ogVid[1] });

  const ogImg = html.match(
    /<meta[^>]*property=["']og:image["'][^>]*content=["']([^"']+)["']/
  );
  if (ogImg && !ogVid) items.push({ type: "image", url: ogImg[1] });

  return items;
}
