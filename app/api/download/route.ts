import { NextRequest, NextResponse } from "next/server";

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

    const instagramRegex =
      /^https?:\/\/(www\.)?instagram\.com\/(p|reel|reels)\/[\w-]+/i;
    if (!instagramRegex.test(url)) {
      return NextResponse.json(
        { error: "Invalid Instagram URL" },
        { status: 400 }
      );
    }

    const shortcode = getShortcode(url);
    if (!shortcode) {
      return NextResponse.json(
        { error: "Could not extract post ID from URL" },
        { status: 400 }
      );
    }

    const items = await extractAllMedia(shortcode, url);
    if (!items || items.length === 0) {
      return NextResponse.json(
        {
          error:
            "Could not extract media. The post may be private or unavailable.",
        },
        { status: 404 }
      );
    }

    return NextResponse.json({ items });
  } catch (error) {
    console.error("Download API error:", error);
    return NextResponse.json(
      { error: "Failed to process the Instagram URL. Please try again." },
      { status: 500 }
    );
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function decodeUnicode(s: string): string {
  return s
    .replace(/\\u0026/g, "&")
    .replace(/\\u003C/g, "<")
    .replace(/\\u003E/g, ">")
    .replace(/\\u002F/g, "/")
    .replace(/\\\//g, "/");
}

function getShortcode(url: string): string | null {
  const match = url.match(/instagram\.com\/(?:p|reel|reels)\/([\w-]+)/);
  return match ? match[1] : null;
}

/**
 * Convert an Instagram shortcode to a numeric media ID.
 * Instagram uses a base64-like encoding for shortcodes.
 */
function shortcodeToMediaId(shortcode: string): string {
  const alphabet =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  let mediaId = BigInt(0);
  for (const char of shortcode) {
    mediaId = mediaId * BigInt(64) + BigInt(alphabet.indexOf(char));
  }
  return mediaId.toString();
}

// ── Main pipeline ────────────────────────────────────────────────────────────

async function extractAllMedia(
  shortcode: string,
  originalUrl: string
): Promise<MediaItem[]> {
  const cleanUrl = originalUrl.split("?")[0].replace(/\/$/, "") + "/";

  // Method 1: Instagram Mobile API (most reliable from servers)
  const mobileItems = await fetchFromMobileApi(shortcode);
  if (mobileItems.length > 0) return mobileItems;

  // Method 2: Instagram GraphQL API
  const gqlItems = await fetchFromGraphQL(shortcode);
  if (gqlItems.length > 0) return gqlItems;

  // Method 3: Embed page scraping
  const embedItems = await fetchFromEmbed(cleanUrl);
  if (embedItems.length > 0) return embedItems;

  // Method 4: Direct page with JSON extraction
  const pageItems = await fetchFromPage(cleanUrl);
  if (pageItems.length > 0) return pageItems;

  return [];
}

// ── Method 1: Mobile API ─────────────────────────────────────────────────────

async function fetchFromMobileApi(shortcode: string): Promise<MediaItem[]> {
  try {
    const mediaId = shortcodeToMediaId(shortcode);
    const apiUrl = `https://i.instagram.com/api/v1/media/${mediaId}/info/`;

    const res = await fetch(apiUrl, {
      headers: {
        "User-Agent":
          "Instagram 275.0.0.27.98 Android (33/13; 420dpi; 1080x2400; samsung; SM-G991B; o1s; exynos2100; en_US; 458229258)",
        Accept: "*/*",
        "Accept-Language": "en-US,en;q=0.9",
        "X-IG-App-ID": "936619743392459",
        "X-IG-WWW-Claim": "0",
        "X-Requested-With": "XMLHttpRequest",
      },
    });

    if (!res.ok) return [];

    const contentType = res.headers.get("content-type") || "";
    if (!contentType.includes("json")) return [];

    const data = await res.json();
    const mediaItems = data?.items;
    if (!Array.isArray(mediaItems) || mediaItems.length === 0) return [];

    const item = mediaItems[0];
    return parseMobileApiItem(item);
  } catch {
    return [];
  }
}

function parseMobileApiItem(item: Record<string, unknown>): MediaItem[] {
  const results: MediaItem[] = [];

  // Check for carousel
  const carouselMedia = item.carousel_media as
    | Array<Record<string, unknown>>
    | undefined;

  if (carouselMedia && Array.isArray(carouselMedia) && carouselMedia.length > 0) {
    for (const slide of carouselMedia) {
      results.push(parseMobileNode(slide));
    }
  } else {
    results.push(parseMobileNode(item));
  }

  return results;
}

function parseMobileNode(node: Record<string, unknown>): MediaItem {
  const mediaType = node.media_type as number;
  const isVideo = mediaType === 2 || !!node.video_versions;

  // Get best image
  let imageUrl = "";
  let width: number | undefined;
  let height: number | undefined;

  const imageVersions2 = node.image_versions2 as
    | { candidates: Array<{ url: string; width: number; height: number }> }
    | undefined;

  if (imageVersions2?.candidates && imageVersions2.candidates.length > 0) {
    const sorted = [...imageVersions2.candidates].sort(
      (a, b) => b.width - a.width
    );
    imageUrl = sorted[0].url;
    width = sorted[0].width;
    height = sorted[0].height;
  }

  if (isVideo) {
    let videoUrl = "";
    const videoVersions = node.video_versions as
      | Array<{ url: string; width: number; height: number; type?: number }>
      | undefined;

    if (videoVersions && videoVersions.length > 0) {
      const sorted = [...videoVersions].sort((a, b) => b.width - a.width);
      videoUrl = sorted[0].url;
      width = sorted[0].width;
      height = sorted[0].height;
    }

    return {
      type: "video",
      url: videoUrl,
      thumbnail: imageUrl || undefined,
      width,
      height,
    };
  }

  return { type: "image", url: imageUrl, width, height };
}

// ── Method 2: GraphQL API ────────────────────────────────────────────────────

async function fetchFromGraphQL(shortcode: string): Promise<MediaItem[]> {
  try {
    const variables = JSON.stringify({
      shortcode,
      child_comment_count: 0,
      fetch_comment_count: 0,
      parent_comment_count: 0,
      has_threaded_comments: false,
    });
    const queryHash = "b3055c01b4b222b8a47dc12b090e4e64";
    const gqlUrl = `https://www.instagram.com/graphql/query/?query_hash=${queryHash}&variables=${encodeURIComponent(variables)}`;

    const res = await fetch(gqlUrl, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        Accept: "*/*",
        "Accept-Language": "en-US,en;q=0.9",
        "X-IG-App-ID": "936619743392459",
        "X-Requested-With": "XMLHttpRequest",
        Referer: "https://www.instagram.com/",
        Origin: "https://www.instagram.com",
      },
    });

    if (!res.ok) return [];

    const contentType = res.headers.get("content-type") || "";
    if (!contentType.includes("json")) return [];

    const data = await res.json();
    const media = data?.data?.shortcode_media;
    if (!media) return [];

    return parseGraphQLMedia(media);
  } catch {
    return [];
  }
}

function parseGraphQLMedia(media: Record<string, unknown>): MediaItem[] {
  const items: MediaItem[] = [];

  const sidecar = media.edge_sidecar_to_children as
    | { edges: Array<{ node: Record<string, unknown> }> }
    | undefined;

  if (sidecar?.edges && Array.isArray(sidecar.edges) && sidecar.edges.length > 0) {
    for (const edge of sidecar.edges) {
      items.push(parseGraphQLNode(edge.node));
    }
  } else {
    items.push(parseGraphQLNode(media));
  }

  return items;
}

function parseGraphQLNode(node: Record<string, unknown>): MediaItem {
  const isVideo = node.is_video === true;

  let imageUrl = "";
  let width: number | undefined;
  let height: number | undefined;

  const displayResources = node.display_resources as
    | Array<{ src: string; config_width: number; config_height: number }>
    | undefined;

  if (displayResources && displayResources.length > 0) {
    const sorted = [...displayResources].sort(
      (a, b) => b.config_width - a.config_width
    );
    imageUrl = decodeUnicode(sorted[0].src);
    width = sorted[0].config_width;
    height = sorted[0].config_height;
  } else if (typeof node.display_url === "string") {
    imageUrl = decodeUnicode(node.display_url);
  }

  const dimensions = node.dimensions as
    | { width: number; height: number }
    | undefined;
  if (!width && dimensions) {
    width = dimensions.width;
    height = dimensions.height;
  }

  if (isVideo && typeof node.video_url === "string") {
    return {
      type: "video",
      url: decodeUnicode(node.video_url),
      thumbnail: imageUrl || undefined,
      width,
      height,
    };
  }

  return { type: "image", url: imageUrl, width, height };
}

// ── Method 3: Embed page ─────────────────────────────────────────────────────

async function fetchFromEmbed(url: string): Promise<MediaItem[]> {
  try {
    for (const suffix of ["/embed/captioned/", "/embed/"]) {
      const embedUrl = url.replace(/\/$/, "") + suffix;
      const res = await fetch(embedUrl, {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.9",
        },
        redirect: "follow",
      });
      if (!res.ok) continue;

      const html = await res.text();

      // Don't process login pages
      if (html.includes("loginForm") || html.includes("/accounts/login")) {
        continue;
      }

      const items = extractFromHtml(html);
      if (items.length > 0) return items;
    }
    return [];
  } catch {
    return [];
  }
}

// ── Method 4: Main page ──────────────────────────────────────────────────────

async function fetchFromPage(url: string): Promise<MediaItem[]> {
  try {
    // Try with Googlebot UA — Instagram serves full HTML to crawlers
    const res = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
      },
      redirect: "follow",
    });
    if (!res.ok) return [];

    const html = await res.text();
    if (html.includes("loginForm") || html.includes("/accounts/login")) {
      return [];
    }

    return extractFromHtml(html);
  } catch {
    return [];
  }
}

// ── HTML JSON extraction (shared) ────────────────────────────────────────────

function extractFromHtml(html: string): MediaItem[] {
  // Strategy 1: window.__additionalDataLoaded
  const addDataRegex =
    /window\.__additionalDataLoaded\s*\(\s*['"][^'"]*['"]\s*,\s*(\{.+?\})\s*\)\s*;/g;
  let match: RegExpExecArray | null;
  while ((match = addDataRegex.exec(html)) !== null) {
    try {
      const data = JSON.parse(match[1]);
      const media =
        data?.graphql?.shortcode_media || data?.shortcode_media;
      if (media) {
        const items = parseGraphQLMedia(media);
        if (items.length > 0) return items;
      }
    } catch {
      // next
    }
  }

  // Strategy 2: window._sharedData
  const sharedDataMatch = html.match(
    /window\._sharedData\s*=\s*(\{.+?\})\s*;/
  );
  if (sharedDataMatch) {
    try {
      const data = JSON.parse(sharedDataMatch[1]);
      const media =
        data?.entry_data?.PostPage?.[0]?.graphql?.shortcode_media ||
        data?.entry_data?.PostPage?.[0]?.shortcode_media;
      if (media) {
        const items = parseGraphQLMedia(media);
        if (items.length > 0) return items;
      }
    } catch {
      // continue
    }
  }

  // Strategy 3: Brace-balanced extraction of shortcode_media
  const scmIndex = html.indexOf('"shortcode_media"');
  if (scmIndex !== -1) {
    const colonIdx = html.indexOf(":", scmIndex + 17);
    if (colonIdx !== -1) {
      const braceIdx = html.indexOf("{", colonIdx);
      if (braceIdx !== -1) {
        const jsonStr = extractBalancedJson(html, braceIdx);
        if (jsonStr) {
          try {
            const media = JSON.parse(jsonStr);
            const items = parseGraphQLMedia(media);
            if (items.length > 0) return items;
          } catch {
            // continue
          }
        }
      }
    }
  }

  // Strategy 4: Regex fallback
  return regexExtractMedia(html);
}

function extractBalancedJson(
  str: string,
  startIdx: number,
  maxLen = 500000
): string | null {
  if (str[startIdx] !== "{") return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  const end = Math.min(str.length, startIdx + maxLen);

  for (let i = startIdx; i < end; i++) {
    const c = str[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (c === "\\") {
      escape = true;
      continue;
    }
    if (c === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (c === "{") depth++;
    if (c === "}") {
      depth--;
      if (depth === 0) return str.substring(startIdx, i + 1);
    }
  }
  return null;
}

function regexExtractMedia(html: string): MediaItem[] {
  const items: MediaItem[] = [];
  const seenUrls = new Set<string>();

  // Videos
  const simpleVideoRegex = /"video_url"\s*:\s*"([^"]+)"/g;
  let svm: RegExpExecArray | null;
  while ((svm = simpleVideoRegex.exec(html)) !== null) {
    const videoUrl = decodeUnicode(svm[1]);
    if (!seenUrls.has(videoUrl)) {
      seenUrls.add(videoUrl);
      items.push({ type: "video", url: videoUrl });
    }
  }

  // Images from display_resources
  const drRegex = /"display_resources"\s*:\s*\[([^\]]+)\]/g;
  let drm: RegExpExecArray | null;
  while ((drm = drRegex.exec(html)) !== null) {
    try {
      const arr = JSON.parse("[" + drm[1] + "]");
      if (Array.isArray(arr) && arr.length > 0) {
        arr.sort(
          (a: { config_width: number }, b: { config_width: number }) =>
            b.config_width - a.config_width
        );
        const bestUrl = decodeUnicode(arr[0].src);
        if (!seenUrls.has(bestUrl)) {
          seenUrls.add(bestUrl);
          items.push({ type: "image", url: bestUrl });
        }
      }
    } catch {
      // skip
    }
  }

  // Fallback: display_url
  const duRegex = /"display_url"\s*:\s*"([^"]+)"/g;
  let dum: RegExpExecArray | null;
  while ((dum = duRegex.exec(html)) !== null) {
    const imgUrl = decodeUnicode(dum[1]);
    if (!seenUrls.has(imgUrl)) {
      seenUrls.add(imgUrl);
      items.push({ type: "image", url: imgUrl });
    }
  }

  return items;
}
