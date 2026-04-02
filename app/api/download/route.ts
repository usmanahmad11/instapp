import { NextRequest, NextResponse } from "next/server";

export const runtime = "edge";

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

    const cleanUrl = url.split("?")[0].replace(/\/$/, "") + "/";

    // Try all methods, collect debug info
    const debug: string[] = [];
    const items = await extractAllMedia(shortcode, cleanUrl, debug);

    if (!items || items.length === 0) {
      return NextResponse.json(
        {
          error:
            "Could not extract media. The post may be private or unavailable.",
          debug,
        },
        { status: 404 }
      );
    }

    return NextResponse.json({ items });
  } catch (error) {
    return NextResponse.json(
      {
        error: "Failed to process the Instagram URL.",
        debug: [String(error)],
      },
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

function shortcodeToMediaId(shortcode: string): string {
  const alphabet =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  let mediaId = BigInt(0);
  for (const char of shortcode) {
    const idx = alphabet.indexOf(char);
    if (idx === -1) continue;
    mediaId = mediaId * BigInt(64) + BigInt(idx);
  }
  return mediaId.toString();
}

// ── Main pipeline ────────────────────────────────────────────────────────────

async function extractAllMedia(
  shortcode: string,
  cleanUrl: string,
  debug: string[]
): Promise<MediaItem[]> {
  // Method 1: Mobile API
  try {
    const items = await fetchFromMobileApi(shortcode, debug);
    if (items.length > 0) return items;
  } catch (e) {
    debug.push(`M1 exception: ${e}`);
  }

  // Method 2: GraphQL
  try {
    const items = await fetchFromGraphQL(shortcode, debug);
    if (items.length > 0) return items;
  } catch (e) {
    debug.push(`M2 exception: ${e}`);
  }

  // Method 3: Web page with different UAs
  try {
    const items = await fetchFromWebPage(cleanUrl, debug);
    if (items.length > 0) return items;
  } catch (e) {
    debug.push(`M3 exception: ${e}`);
  }

  // Method 4: Embed page
  try {
    const items = await fetchFromEmbed(cleanUrl, debug);
    if (items.length > 0) return items;
  } catch (e) {
    debug.push(`M4 exception: ${e}`);
  }

  // Method 5: oEmbed (only gives thumbnail but at least works)
  try {
    const items = await fetchFromOEmbed(cleanUrl, debug);
    if (items.length > 0) return items;
  } catch (e) {
    debug.push(`M5 exception: ${e}`);
  }

  return [];
}

// ── Method 1: Mobile API ─────────────────────────────────────────────────────

async function fetchFromMobileApi(
  shortcode: string,
  debug: string[]
): Promise<MediaItem[]> {
  const mediaId = shortcodeToMediaId(shortcode);
  const apiUrl = `https://i.instagram.com/api/v1/media/${mediaId}/info/`;

  const res = await fetch(apiUrl, {
    headers: {
      "User-Agent":
        "Instagram 275.0.0.27.98 Android (33/13; 420dpi; 1080x2400; samsung; SM-G991B; o1s; exynos2100; en_US; 458229258)",
      Accept: "*/*",
      "X-IG-App-ID": "936619743392459",
    },
  });

  debug.push(`M1 mobile-api: ${res.status} ${res.statusText}`);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    debug.push(`M1 body: ${text.substring(0, 200)}`);
    return [];
  }

  const ct = res.headers.get("content-type") || "";
  if (!ct.includes("json")) {
    debug.push(`M1 not-json: ${ct}`);
    return [];
  }

  const data = await res.json();
  const mediaItems = data?.items;
  if (!Array.isArray(mediaItems) || mediaItems.length === 0) {
    debug.push("M1 no items in response");
    return [];
  }

  return parseMobileApiItem(mediaItems[0]);
}

// ── Method 2: GraphQL ────────────────────────────────────────────────────────

async function fetchFromGraphQL(
  shortcode: string,
  debug: string[]
): Promise<MediaItem[]> {
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
      "X-IG-App-ID": "936619743392459",
      "X-Requested-With": "XMLHttpRequest",
      Referer: "https://www.instagram.com/",
    },
  });

  debug.push(`M2 graphql: ${res.status}`);
  if (!res.ok) return [];

  const ct = res.headers.get("content-type") || "";
  if (!ct.includes("json")) {
    debug.push(`M2 not-json: ${ct}`);
    return [];
  }

  const data = await res.json();
  const media = data?.data?.shortcode_media;
  if (!media) {
    debug.push("M2 no shortcode_media");
    return [];
  }

  return parseGraphQLMedia(media);
}

// ── Method 3: Web page scraping ──────────────────────────────────────────────

async function fetchFromWebPage(
  url: string,
  debug: string[]
): Promise<MediaItem[]> {
  const userAgents = [
    // Googlebot - Instagram serves content to search crawlers
    "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
    // Facebook crawler
    "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)",
    // WhatsApp
    "WhatsApp/2.23.20.0",
    // Regular browser
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  ];

  for (let i = 0; i < userAgents.length; i++) {
    const res = await fetch(url, {
      headers: {
        "User-Agent": userAgents[i],
        Accept: "text/html,application/xhtml+xml",
        "Accept-Language": "en-US,en;q=0.9",
      },
      redirect: "follow",
    });

    debug.push(`M3 ua${i}: ${res.status}`);
    if (!res.ok) continue;

    const html = await res.text();

    // Skip login pages
    if (
      html.includes("/accounts/login") &&
      !html.includes("og:image")
    ) {
      debug.push(`M3 ua${i}: login-redirect`);
      continue;
    }

    const items = extractFromHtml(html);
    if (items.length > 0) {
      debug.push(`M3 ua${i}: found ${items.length} items`);
      return items;
    }

    debug.push(`M3 ua${i}: no items extracted (html length: ${html.length})`);
  }

  return [];
}

// ── Method 4: Embed page ─────────────────────────────────────────────────────

async function fetchFromEmbed(
  url: string,
  debug: string[]
): Promise<MediaItem[]> {
  for (const suffix of ["/embed/captioned/", "/embed/"]) {
    const embedUrl = url.replace(/\/$/, "") + suffix;
    const res = await fetch(embedUrl, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
        Accept: "text/html",
      },
      redirect: "follow",
    });

    debug.push(`M4 ${suffix}: ${res.status}`);
    if (!res.ok) continue;

    const html = await res.text();
    if (html.includes("/accounts/login")) {
      debug.push(`M4 ${suffix}: login-redirect`);
      continue;
    }

    const items = extractFromHtml(html);
    if (items.length > 0) {
      debug.push(`M4 ${suffix}: found ${items.length} items`);
      return items;
    }
    debug.push(`M4 ${suffix}: no items (html: ${html.length})`);
  }

  return [];
}

// ── Method 5: oEmbed (last resort — only thumbnail) ──────────────────────────

async function fetchFromOEmbed(
  url: string,
  debug: string[]
): Promise<MediaItem[]> {
  // Try the public oEmbed endpoint
  const oembedUrl = `https://api.instagram.com/oembed/?url=${encodeURIComponent(url)}&maxwidth=1080`;
  const res = await fetch(oembedUrl, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      Accept: "application/json",
    },
  });

  debug.push(`M5 oembed: ${res.status}`);
  if (!res.ok) return [];

  const ct = res.headers.get("content-type") || "";
  if (!ct.includes("json")) {
    debug.push(`M5 not-json: ${ct}`);
    return [];
  }

  const data = await res.json();
  if (data.thumbnail_url) {
    // Try to get higher res by modifying the CDN URL
    let imageUrl = data.thumbnail_url;
    // Remove size restrictions from CDN URL
    imageUrl = imageUrl.replace(/\/s\d+x\d+\//, "/");
    imageUrl = imageUrl.replace(/\/c[\d.]+a?\//, "/");

    const isVideo =
      data.type === "video" ||
      (data.html && data.html.includes("data-instgrm-type=\"video\""));

    return [
      {
        type: isVideo ? "video" : "image",
        url: imageUrl,
        width: data.thumbnail_width,
        height: data.thumbnail_height,
      },
    ];
  }

  debug.push("M5 no thumbnail_url");
  return [];
}

// ── HTML extraction (shared by Methods 3 & 4) ───────────────────────────────

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
  const regexItems = regexExtractMedia(html);
  if (regexItems.length > 0) return regexItems;

  // Strategy 5: og:image / og:video from meta tags (absolute last resort)
  const ogItems: MediaItem[] = [];

  const ogVideoMatch = html.match(
    /<meta[^>]*property=["']og:video(?::secure_url)?["'][^>]*content=["']([^"']+)["']/
  );
  if (ogVideoMatch) {
    const ogImageMatch = html.match(
      /<meta[^>]*property=["']og:image["'][^>]*content=["']([^"']+)["']/
    );
    ogItems.push({
      type: "video",
      url: ogVideoMatch[1],
      thumbnail: ogImageMatch ? ogImageMatch[1] : undefined,
    });
  }

  const ogImageMatch = html.match(
    /<meta[^>]*property=["']og:image["'][^>]*content=["']([^"']+)["']/
  );
  if (ogImageMatch && ogItems.length === 0) {
    // Remove size/crop params for full resolution
    let imgUrl = ogImageMatch[1];
    imgUrl = imgUrl.replace(/\/s\d+x\d+\//, "/");
    imgUrl = imgUrl.replace(/\/c[\d.]+a?\//, "/");
    ogItems.push({ type: "image", url: imgUrl });
  }

  return ogItems;
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

  // display_url
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

// ── Mobile API parser ────────────────────────────────────────────────────────

function parseMobileApiItem(item: Record<string, unknown>): MediaItem[] {
  const results: MediaItem[] = [];
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
      | Array<{ url: string; width: number; height: number }>
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

// ── GraphQL parser ───────────────────────────────────────────────────────────

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
