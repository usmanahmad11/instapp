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

    const cleanUrl = url.split("?")[0].replace(/\/$/, "") + "/";

    const items = await extractAllMedia(cleanUrl);
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

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  Accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  "Sec-Fetch-Dest": "document",
  "Sec-Fetch-Mode": "navigate",
  "Sec-Fetch-Site": "none",
  "Sec-Fetch-User": "?1",
  "Cache-Control": "no-cache",
  Pragma: "no-cache",
};

// ── Main extraction ──────────────────────────────────────────────────────────

async function extractAllMedia(url: string): Promise<MediaItem[]> {
  // Method 1: Instagram JSON API (?__a=1&__d=dis)
  const jsonItems = await fetchFromJsonApi(url);
  if (jsonItems.length > 0) return jsonItems;

  // Method 2: Embed page (parse the embedded JSON)
  const embedItems = await fetchFromEmbed(url);
  if (embedItems.length > 0) return embedItems;

  // Method 3: Main page scraping
  const pageItems = await fetchFromMainPage(url);
  if (pageItems.length > 0) return pageItems;

  return [];
}

// ── Method 1: JSON API ──────────────────────────────────────────────────────

async function fetchFromJsonApi(url: string): Promise<MediaItem[]> {
  try {
    const jsonUrl = url.replace(/\/$/, "") + "?__a=1&__d=dis";
    const res = await fetch(jsonUrl, {
      headers: {
        ...HEADERS,
        Accept: "application/json, text/plain, */*",
        "X-IG-App-ID": "936619743392459",
        "X-Requested-With": "XMLHttpRequest",
      },
      redirect: "follow",
    });

    if (!res.ok) return [];

    const contentType = res.headers.get("content-type") || "";
    if (!contentType.includes("json")) return [];

    const data = await res.json();
    const media =
      data?.graphql?.shortcode_media ||
      data?.shortcode_media ||
      data?.items?.[0];

    if (!media) return [];
    return parseShortcodeMedia(media);
  } catch {
    return [];
  }
}

// ── Method 2: Embed page ─────────────────────────────────────────────────────

async function fetchFromEmbed(url: string): Promise<MediaItem[]> {
  try {
    // Try both /embed/ and /embed/captioned/
    for (const suffix of ["/embed/captioned/", "/embed/"]) {
      const embedUrl = url.replace(/\/$/, "") + suffix;
      const res = await fetch(embedUrl, {
        headers: HEADERS,
        redirect: "follow",
      });
      if (!res.ok) continue;

      const html = await res.text();
      const items = extractFromHtml(html);
      if (items.length > 0) return items;
    }
    return [];
  } catch {
    return [];
  }
}

// ── Method 3: Main page ──────────────────────────────────────────────────────

async function fetchFromMainPage(url: string): Promise<MediaItem[]> {
  try {
    const res = await fetch(url, {
      headers: HEADERS,
      redirect: "follow",
    });
    if (!res.ok) return [];

    const html = await res.text();
    return extractFromHtml(html);
  } catch {
    return [];
  }
}

// ── HTML/Script JSON extractor (shared by embed + main page) ─────────────────

function extractFromHtml(html: string): MediaItem[] {
  // Strategy 1: Find window.__additionalDataLoaded(...) calls
  const addDataRegex =
    /window\.__additionalDataLoaded\s*\(\s*['"][^'"]*['"]\s*,\s*(\{.+?\})\s*\)\s*;/g;
  let match: RegExpExecArray | null;
  while ((match = addDataRegex.exec(html)) !== null) {
    try {
      const data = JSON.parse(match[1]);
      const media =
        data?.graphql?.shortcode_media ||
        data?.shortcode_media;
      if (media) {
        const items = parseShortcodeMedia(media);
        if (items.length > 0) return items;
      }
    } catch {
      // try next match
    }
  }

  // Strategy 2: Find window._sharedData or similar large JSON
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
        const items = parseShortcodeMedia(media);
        if (items.length > 0) return items;
      }
    } catch {
      // continue
    }
  }

  // Strategy 3: Find any JSON blob containing "shortcode_media" and
  // try to extract the full object by brace-balancing from the key
  const scmIndex = html.indexOf('"shortcode_media"');
  if (scmIndex !== -1) {
    // find the opening brace of the value
    const colonIdx = html.indexOf(":", scmIndex + 17);
    if (colonIdx !== -1) {
      const braceIdx = html.indexOf("{", colonIdx);
      if (braceIdx !== -1) {
        const jsonStr = extractBalancedJson(html, braceIdx);
        if (jsonStr) {
          try {
            const media = JSON.parse(jsonStr);
            const items = parseShortcodeMedia(media);
            if (items.length > 0) return items;
          } catch {
            // continue
          }
        }
      }
    }
  }

  // Strategy 4: Regex-based extraction of individual media entries
  // Collect ALL video_url and display_url / display_resources in order
  const items = regexExtractMedia(html);
  if (items.length > 0) return items;

  return [];
}

/**
 * Extract a balanced JSON object starting at the given brace position.
 */
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

// ── Regex-based fallback ─────────────────────────────────────────────────────

function regexExtractMedia(html: string): MediaItem[] {
  const items: MediaItem[] = [];
  const seenUrls = new Set<string>();

  // Find all "edge_sidecar_to_children" sections — carousel
  // If present, find each node's media

  // Step 1: Collect ALL video entries with their display_url (thumbnail)
  const videoBlockRegex =
    /"is_video"\s*:\s*true[\s\S]*?"video_url"\s*:\s*"([^"]+)"[\s\S]*?"display_url"\s*:\s*"([^"]+)"/g;
  let vm: RegExpExecArray | null;
  while ((vm = videoBlockRegex.exec(html)) !== null) {
    const videoUrl = decodeUnicode(vm[1]);
    const thumbUrl = decodeUnicode(vm[2]);
    if (!seenUrls.has(videoUrl)) {
      seenUrls.add(videoUrl);
      seenUrls.add(thumbUrl); // mark thumbnail so it's not added as image
      items.push({ type: "video", url: videoUrl, thumbnail: thumbUrl });
    }
  }

  // Also try simpler video_url pattern
  const simpleVideoRegex = /"video_url"\s*:\s*"([^"]+)"/g;
  let svm: RegExpExecArray | null;
  while ((svm = simpleVideoRegex.exec(html)) !== null) {
    const videoUrl = decodeUnicode(svm[1]);
    if (!seenUrls.has(videoUrl)) {
      seenUrls.add(videoUrl);
      items.push({ type: "video", url: videoUrl });
    }
  }

  // Step 2: Collect display_resources (highest res) for images
  // Each display_resources array belongs to one media item
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
          items.push({
            type: "image",
            url: bestUrl,
            width: arr[0].config_width,
            height: arr[0].config_height,
          });
        }
      }
    } catch {
      // skip
    }
  }

  // Step 3: Fallback — collect display_url entries not already seen
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

// ── Parse structured shortcode_media JSON ────────────────────────────────────

function parseShortcodeMedia(media: Record<string, unknown>): MediaItem[] {
  const items: MediaItem[] = [];

  // Check if carousel
  const sidecar = media.edge_sidecar_to_children as
    | { edges: Array<{ node: Record<string, unknown> }> }
    | undefined;

  if (sidecar?.edges && Array.isArray(sidecar.edges) && sidecar.edges.length > 0) {
    // Carousel post — extract each slide
    for (const edge of sidecar.edges) {
      items.push(parseSingleNode(edge.node));
    }
  } else {
    // Single media post
    items.push(parseSingleNode(media));
  }

  // Also check items array (v2 API format)
  if (items.length === 0 && Array.isArray((media as Record<string, unknown>).carousel_media)) {
    const carousel = (media as Record<string, unknown>).carousel_media as Array<Record<string, unknown>>;
    for (const item of carousel) {
      items.push(parseSingleNode(item));
    }
  }

  return items;
}

function parseSingleNode(node: Record<string, unknown>): MediaItem {
  const isVideo =
    node.is_video === true ||
    node.media_type === 2 ||
    !!node.video_url;

  // Get best image URL
  let imageUrl = "";
  const displayResources = node.display_resources as
    | Array<{ src: string; config_width: number; config_height: number }>
    | undefined;

  let width: number | undefined;
  let height: number | undefined;

  if (
    displayResources &&
    Array.isArray(displayResources) &&
    displayResources.length > 0
  ) {
    // Pick highest resolution
    displayResources.sort((a, b) => b.config_width - a.config_width);
    imageUrl = decodeUnicode(displayResources[0].src);
    width = displayResources[0].config_width;
    height = displayResources[0].config_height;
  } else if (typeof node.display_url === "string") {
    imageUrl = decodeUnicode(node.display_url);
  }

  // v2 API: image_versions2
  if (!imageUrl && node.image_versions2) {
    const iv2 = node.image_versions2 as {
      candidates: Array<{ url: string; width: number; height: number }>;
    };
    if (iv2.candidates && iv2.candidates.length > 0) {
      iv2.candidates.sort((a, b) => b.width - a.width);
      imageUrl = decodeUnicode(iv2.candidates[0].url);
      width = iv2.candidates[0].width;
      height = iv2.candidates[0].height;
    }
  }

  const dimensions = node.dimensions as
    | { width: number; height: number }
    | undefined;
  if (!width && dimensions) {
    width = dimensions.width;
    height = dimensions.height;
  }

  if (isVideo) {
    let videoUrl = "";
    if (typeof node.video_url === "string") {
      videoUrl = decodeUnicode(node.video_url);
    }
    // v2 API: video_versions
    if (!videoUrl && Array.isArray(node.video_versions)) {
      const vv = node.video_versions as Array<{
        url: string;
        width: number;
        height: number;
      }>;
      if (vv.length > 0) {
        vv.sort((a, b) => b.width - a.width);
        videoUrl = decodeUnicode(vv[0].url);
        width = vv[0].width;
        height = vv[0].height;
      }
    }

    return {
      type: "video",
      url: videoUrl,
      thumbnail: imageUrl || undefined,
      width,
      height,
    };
  }

  return {
    type: "image",
    url: imageUrl,
    width,
    height,
  };
}
