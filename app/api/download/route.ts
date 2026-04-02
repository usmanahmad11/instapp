import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 30;

interface MediaItem {
  type: "image" | "video";
  url: string;
  thumbnail?: string;
  width?: number;
  height?: number;
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

    const shortcode = getShortcode(url);
    if (!shortcode) {
      return NextResponse.json({ error: "Could not extract post ID" }, { status: 400 });
    }

    const cleanUrl = url.split("?")[0].replace(/\/$/, "") + "/";
    const debug: string[] = [];

    const items = await extractAllMedia(shortcode, cleanUrl, debug);

    if (!items || items.length === 0) {
      return NextResponse.json(
        { error: "Could not extract media. The post may be private or unavailable.", debug },
        { status: 404 }
      );
    }

    return NextResponse.json({ items });
  } catch (error) {
    return NextResponse.json(
      { error: "Failed to process Instagram URL.", debug: [String(error)] },
      { status: 500 }
    );
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function getShortcode(url: string): string | null {
  const match = url.match(/instagram\.com\/(?:p|reel|reels)\/([\w-]+)/);
  return match ? match[1] : null;
}

function decodeUnicode(s: string): string {
  return s
    .replace(/\\u0026/g, "&")
    .replace(/\\u003C/g, "<")
    .replace(/\\u003E/g, ">")
    .replace(/\\u002F/g, "/")
    .replace(/\\\//g, "/");
}

// ── Pipeline ─────────────────────────────────────────────────────────────────

async function extractAllMedia(
  shortcode: string,
  cleanUrl: string,
  debug: string[]
): Promise<MediaItem[]> {
  // Method 1: Third-party scraper services (most reliable from cloud)
  for (const fetcher of [fetchFromSaveIG, fetchFromSnapInsta]) {
    try {
      const items = await fetcher(cleanUrl, debug);
      if (items.length > 0) return items;
    } catch (e) {
      debug.push(`service error: ${e}`);
    }
  }

  // Method 2: Instagram GraphQL POST (doc_id method)
  try {
    const items = await fetchFromGraphQL(shortcode, debug);
    if (items.length > 0) return items;
  } catch (e) {
    debug.push(`graphql error: ${e}`);
  }

  // Method 3: Page scraping with crawler UAs
  try {
    const items = await fetchFromPage(cleanUrl, debug);
    if (items.length > 0) return items;
  } catch (e) {
    debug.push(`page error: ${e}`);
  }

  return [];
}

// ── Method 1a: SaveIG API ────────────────────────────────────────────────────

async function fetchFromSaveIG(url: string, debug: string[]): Promise<MediaItem[]> {
  try {
    const res = await fetch("https://v3.saveig.app/api/ajaxSearch", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        Accept: "*/*",
        Origin: "https://saveig.app",
        Referer: "https://saveig.app/",
      },
      body: `q=${encodeURIComponent(url)}&t=media&lang=en`,
    });

    debug.push(`saveig: ${res.status}`);
    if (!res.ok) return [];

    const data = await res.json();
    if (data.status !== "ok" || !data.data) {
      debug.push(`saveig: status=${data.status}`);
      return [];
    }

    // Parse the HTML response to extract download links
    const html: string = data.data;
    return parseServiceHtml(html, debug, "saveig");
  } catch (e) {
    debug.push(`saveig err: ${e}`);
    return [];
  }
}

// ── Method 1b: SnapInsta API ─────────────────────────────────────────────────

async function fetchFromSnapInsta(url: string, debug: string[]): Promise<MediaItem[]> {
  try {
    const res = await fetch("https://snapinsta.app/action2.php", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        Accept: "*/*",
        Origin: "https://snapinsta.app",
        Referer: "https://snapinsta.app/",
      },
      body: `url=${encodeURIComponent(url)}`,
    });

    debug.push(`snapinsta: ${res.status}`);
    if (!res.ok) return [];

    const text = await res.text();
    // Try as JSON first
    try {
      const data = JSON.parse(text);
      if (data.data) {
        return parseServiceHtml(data.data, debug, "snapinsta");
      }
    } catch {
      // Response might be direct HTML
      return parseServiceHtml(text, debug, "snapinsta");
    }

    return [];
  } catch (e) {
    debug.push(`snapinsta err: ${e}`);
    return [];
  }
}

// ── Parse HTML from third-party services ─────────────────────────────────────

function parseServiceHtml(html: string, debug: string[], source: string): MediaItem[] {
  const items: MediaItem[] = [];
  const seen = new Set<string>();

  // Extract all download links (usually in <a> tags with download URLs)
  // Pattern: href="https://...cdninstagram.com/..." or similar CDN URLs
  const linkRegex = /href=["']([^"']+)["']/g;
  let match: RegExpExecArray | null;
  while ((match = linkRegex.exec(html)) !== null) {
    let href = match[1].replace(/&amp;/g, "&");

    // Skip non-media links
    if (
      href.startsWith("#") ||
      href.startsWith("javascript:") ||
      href.includes("saveig.app") ||
      href.includes("snapinsta.app") ||
      (!href.includes("cdninstagram") &&
        !href.includes("scontent") &&
        !href.includes("fbcdn") &&
        !href.includes(".mp4") &&
        !href.includes(".jpg") &&
        !href.includes("instagram"))
    )
      continue;

    if (seen.has(href)) continue;
    seen.add(href);

    const isVideo = href.includes(".mp4") || href.includes("video");
    items.push({ type: isVideo ? "video" : "image", url: href });
  }

  // Also try to find src= attributes for images/videos
  const srcRegex = /src=["']([^"']+(?:cdninstagram|scontent|fbcdn)[^"']*)["']/g;
  while ((match = srcRegex.exec(html)) !== null) {
    let src = match[1].replace(/&amp;/g, "&");
    if (seen.has(src)) continue;
    seen.add(src);

    const isVideo = src.includes(".mp4") || src.includes("video");
    items.push({ type: isVideo ? "video" : "image", url: src });
  }

  // Try to find download_link or download_url in JSON-like data
  const dlRegex = /["'](?:download_link|download_url|url)["']\s*:\s*["']([^"']+)["']/g;
  while ((match = dlRegex.exec(html)) !== null) {
    let dl = match[1].replace(/\\u0026/g, "&").replace(/\\\//g, "/");
    if (seen.has(dl)) continue;
    seen.add(dl);

    const isVideo = dl.includes(".mp4") || dl.includes("video");
    items.push({ type: isVideo ? "video" : "image", url: dl });
  }

  debug.push(`${source}: parsed ${items.length} items`);
  return items;
}

// ── Method 2: GraphQL POST ───────────────────────────────────────────────────

async function fetchFromGraphQL(shortcode: string, debug: string[]): Promise<MediaItem[]> {
  const docIds = ["10015901848480474", "8845758582119845"];

  for (const docId of docIds) {
    try {
      const body = new URLSearchParams({
        variables: JSON.stringify({ shortcode }),
        doc_id: docId,
        lsd: "AVqbxe3J_YA",
      });

      const res = await fetch("https://www.instagram.com/api/graphql", {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
          "X-IG-App-ID": "936619743392459",
          "X-FB-LSD": "AVqbxe3J_YA",
          "X-ASBD-ID": "129477",
          Accept: "*/*",
          Origin: "https://www.instagram.com",
          Referer: "https://www.instagram.com/",
        },
        body: body.toString(),
      });

      debug.push(`graphql doc=${docId}: ${res.status}`);
      if (!res.ok) continue;

      const ct = res.headers.get("content-type") || "";
      if (!ct.includes("json")) continue;

      const data = await res.json();
      const media = data?.data?.xdt_shortcode_media || data?.data?.shortcode_media;
      if (!media) {
        debug.push(`graphql doc=${docId}: no media`);
        continue;
      }

      return parseGraphQLMedia(media);
    } catch (e) {
      debug.push(`graphql doc=${docId}: ${e}`);
    }
  }

  return [];
}

// ── Method 3: Page scraping ──────────────────────────────────────────────────

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

  // Video URLs
  const videoRegex = /"video_url"\s*:\s*"([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = videoRegex.exec(html)) !== null) {
    const u = decodeUnicode(m[1]);
    if (!seen.has(u)) { seen.add(u); items.push({ type: "video", url: u }); }
  }

  // Image URLs from display_resources (highest res)
  const drRegex = /"display_resources"\s*:\s*\[([^\]]+)\]/g;
  while ((m = drRegex.exec(html)) !== null) {
    try {
      const arr = JSON.parse("[" + m[1] + "]");
      if (Array.isArray(arr) && arr.length > 0) {
        arr.sort((a: { config_width: number }, b: { config_width: number }) => b.config_width - a.config_width);
        const u = decodeUnicode(arr[0].src);
        if (!seen.has(u)) { seen.add(u); items.push({ type: "image", url: u }); }
      }
    } catch { /* skip */ }
  }

  // display_url fallback
  const duRegex = /"display_url"\s*:\s*"([^"]+)"/g;
  while ((m = duRegex.exec(html)) !== null) {
    const u = decodeUnicode(m[1]);
    if (!seen.has(u)) { seen.add(u); items.push({ type: "image", url: u }); }
  }

  if (items.length > 0) return items;

  // og: meta tags (last resort)
  const ogVid = html.match(/<meta[^>]*property=["']og:video(?::secure_url)?["'][^>]*content=["']([^"']+)["']/);
  if (ogVid) items.push({ type: "video", url: ogVid[1] });

  const ogImg = html.match(/<meta[^>]*property=["']og:image["'][^>]*content=["']([^"']+)["']/);
  if (ogImg && !ogVid) items.push({ type: "image", url: ogImg[1] });

  return items;
}

// ── GraphQL parser ───────────────────────────────────────────────────────────

function parseGraphQLMedia(media: Record<string, unknown>): MediaItem[] {
  const items: MediaItem[] = [];
  const sidecar = media.edge_sidecar_to_children as
    | { edges: Array<{ node: Record<string, unknown> }> }
    | undefined;

  if (sidecar?.edges?.length) {
    for (const edge of sidecar.edges) items.push(parseNode(edge.node));
  } else {
    items.push(parseNode(media));
  }
  return items;
}

function parseNode(node: Record<string, unknown>): MediaItem {
  const isVideo = node.is_video === true;

  let imageUrl = "";
  let width: number | undefined;
  let height: number | undefined;

  const resources = node.display_resources as Array<{ src: string; config_width: number; config_height: number }> | undefined;
  if (resources?.length) {
    const best = [...resources].sort((a, b) => b.config_width - a.config_width)[0];
    imageUrl = decodeUnicode(best.src);
    width = best.config_width;
    height = best.config_height;
  } else if (typeof node.display_url === "string") {
    imageUrl = decodeUnicode(node.display_url);
  }

  const dims = node.dimensions as { width: number; height: number } | undefined;
  if (!width && dims) { width = dims.width; height = dims.height; }

  if (isVideo && typeof node.video_url === "string") {
    return { type: "video", url: decodeUnicode(node.video_url), thumbnail: imageUrl || undefined, width, height };
  }

  return { type: "image", url: imageUrl, width, height };
}
