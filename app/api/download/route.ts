import { NextRequest, NextResponse } from "next/server";
import * as cheerio from "cheerio";

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

    // Clean the URL
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

// ── helpers ──────────────────────────────────────────────────────────────────

function decodeUnicode(s: string): string {
  return s.replace(/\\u0026/g, "&").replace(/\\\//g, "/");
}

/**
 * Pick the highest-resolution URL from a display_resources array.
 * Each entry looks like: { "src": "…", "config_width": 1080, "config_height": 1080 }
 * We pick the one with the largest config_width.
 */
function bestFromDisplayResources(resources: string): string | null {
  try {
    const arr = JSON.parse(resources);
    if (!Array.isArray(arr) || arr.length === 0) return null;
    // sort descending by config_width
    arr.sort(
      (a: { config_width: number }, b: { config_width: number }) =>
        b.config_width - a.config_width
    );
    return decodeUnicode(arr[0].src);
  } catch {
    return null;
  }
}

// ── main extraction pipeline ─────────────────────────────────────────────────

async function extractAllMedia(url: string): Promise<MediaItem[]> {
  // Method 1: embed page (most reliable for full JSON data)
  const embedItems = await fetchFromEmbed(url);
  if (embedItems && embedItems.length > 0) return embedItems;

  // Method 2: main page HTML
  const pageItems = await fetchFromPage(url);
  if (pageItems && pageItems.length > 0) return pageItems;

  return [];
}

// ── Method 1: Embed page ─────────────────────────────────────────────────────

async function fetchFromEmbed(url: string): Promise<MediaItem[]> {
  try {
    const embedUrl = url.replace(/\/$/, "") + "/embed/captioned/";
    const response = await fetch(embedUrl, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.5",
        "Sec-Fetch-Dest": "document",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Site": "none",
      },
      redirect: "follow",
    });
    if (!response.ok) return [];

    const html = await response.text();

    // Instagram embed pages contain a JSON blob inside a <script> that has
    // the full media data.  Look for the largest JSON object we can parse.
    const items: MediaItem[] = [];

    // ── try to find gql_data or shortcode_media from script content ───────
    // The embed page ships something like:
    //   window.__additionalDataLoaded('/p/XXXXX/', {...});
    // or it inlines a huge JSON blob.

    // Strategy: find all JSON-like objects that contain "shortcode_media"
    const jsonBlobMatches = html.matchAll(
      /["']?shortcode_media["']?\s*:\s*(\{[\s\S]*?\})\s*[,}]/g
    );

    for (const m of jsonBlobMatches) {
      const parsed = tryParseMediaJson(m[1]);
      if (parsed && parsed.length > 0) return parsed;
    }

    // Try extracting the full JSON from additionalDataLoaded or similar
    const additionalDataMatch = html.match(
      /window\.__additionalDataLoaded\s*\(\s*['"][^'"]*['"]\s*,\s*(\{.+?\})\s*\)\s*;/s
    );
    if (additionalDataMatch) {
      try {
        const data = JSON.parse(additionalDataMatch[1]);
        const media =
          data?.graphql?.shortcode_media ||
          data?.shortcode_media ||
          data?.items?.[0];
        if (media) {
          const parsed = extractFromShortcodeMedia(media);
          if (parsed.length > 0) return parsed;
        }
      } catch {
        // continue
      }
    }

    // ── fallback: regex extraction from embed HTML ────────────────────────
    // Grab ALL display_url values (carousel items each have one)
    const allDisplayUrls: string[] = [];
    const allVideoUrls: string[] = [];

    // Find display_resources arrays (highest quality)
    const resourceMatches = html.matchAll(
      /"display_resources"\s*:\s*(\[[^\]]+\])/g
    );
    for (const rm of resourceMatches) {
      const best = bestFromDisplayResources(rm[1]);
      if (best) allDisplayUrls.push(best);
    }

    // Find video_url entries
    const videoMatches = html.matchAll(/"video_url"\s*:\s*"([^"]+)"/g);
    for (const vm of videoMatches) {
      allVideoUrls.push(decodeUnicode(vm[1]));
    }

    // If we got display_resources, use those
    if (allDisplayUrls.length > 0) {
      // pair with videos if counts match (carousel with mixed media)
      if (allVideoUrls.length > 0 && allVideoUrls.length === allDisplayUrls.length) {
        // all items are videos
        for (let i = 0; i < allVideoUrls.length; i++) {
          items.push({
            type: "video",
            url: allVideoUrls[i],
            thumbnail: allDisplayUrls[i],
          });
        }
      } else if (allVideoUrls.length > 0) {
        // mixed: we can't perfectly pair, so add videos first then remaining images
        const videoThumbs = new Set<string>();
        for (const vUrl of allVideoUrls) {
          items.push({ type: "video", url: vUrl });
        }
        // find display_urls that are paired with a video (appear right before video_url)
        const videoDisplayMatches = html.matchAll(
          /"display_url"\s*:\s*"([^"]+)"[\s\S]*?"video_url"\s*:\s*"([^"]+)"/g
        );
        for (const vdm of videoDisplayMatches) {
          videoThumbs.add(decodeUnicode(vdm[1]));
        }
        for (const dUrl of allDisplayUrls) {
          if (!videoThumbs.has(dUrl)) {
            items.push({ type: "image", url: dUrl });
          }
        }
      } else {
        for (const dUrl of allDisplayUrls) {
          items.push({ type: "image", url: dUrl });
        }
      }
      if (items.length > 0) return items;
    }

    // Even more basic: grab display_url (no display_resources)
    const displayUrlMatches = html.matchAll(/"display_url"\s*:\s*"([^"]+)"/g);
    const seen = new Set<string>();
    for (const dm of displayUrlMatches) {
      const decoded = decodeUnicode(dm[1]);
      if (!seen.has(decoded)) {
        seen.add(decoded);
        allDisplayUrls.push(decoded);
      }
    }

    if (allVideoUrls.length > 0) {
      for (const v of allVideoUrls) {
        items.push({ type: "video", url: v });
      }
    }
    for (const d of allDisplayUrls) {
      if (!items.some((i) => i.url === d)) {
        items.push({ type: "image", url: d });
      }
    }

    // Last resort: HTML video / image elements
    if (items.length === 0) {
      const $ = cheerio.load(html);
      const video =
        $("video source").attr("src") || $("video").attr("src");
      if (video) {
        items.push({
          type: "video",
          url: video,
          thumbnail: $("video").attr("poster") || undefined,
        });
      }
      const img =
        $(".EmbeddedMediaImage").attr("src") ||
        $("img.EmbeddedMediaImage").attr("src");
      if (img) {
        items.push({ type: "image", url: img });
      }
    }

    return items;
  } catch {
    return [];
  }
}

// ── Method 2: Main page HTML ─────────────────────────────────────────────────

async function fetchFromPage(url: string): Promise<MediaItem[]> {
  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.5",
        "Sec-Fetch-Dest": "document",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Site": "none",
        "Cache-Control": "no-cache",
      },
      redirect: "follow",
    });
    if (!response.ok) return [];

    const html = await response.text();
    const $ = cheerio.load(html);
    const items: MediaItem[] = [];

    // Try script JSON blobs
    const scripts = $("script")
      .map((_, el) => $(el).html())
      .get();

    for (const script of scripts) {
      if (!script) continue;

      // Look for shortcode_media JSON
      const scmMatch = script.match(
        /["']?shortcode_media["']?\s*:\s*(\{[\s\S]*?\})\s*[,}]/
      );
      if (scmMatch) {
        const parsed = tryParseMediaJson(scmMatch[1]);
        if (parsed && parsed.length > 0) return parsed;
      }

      // additionalDataLoaded
      const adMatch = script.match(
        /window\.__additionalDataLoaded\s*\(\s*['"][^'"]*['"]\s*,\s*(\{.+?\})\s*\)\s*;/s
      );
      if (adMatch) {
        try {
          const data = JSON.parse(adMatch[1]);
          const media = data?.graphql?.shortcode_media || data?.shortcode_media;
          if (media) {
            const parsed = extractFromShortcodeMedia(media);
            if (parsed.length > 0) return parsed;
          }
        } catch {
          // continue
        }
      }
    }

    // Regex fallback — collect all display_resources
    const allDisplayUrls: string[] = [];
    const allVideoUrls: string[] = [];

    for (const script of scripts) {
      if (!script) continue;
      const resMatches = script.matchAll(
        /"display_resources"\s*:\s*(\[[^\]]+\])/g
      );
      for (const rm of resMatches) {
        const best = bestFromDisplayResources(rm[1]);
        if (best && !allDisplayUrls.includes(best)) allDisplayUrls.push(best);
      }
      const vidMatches = script.matchAll(/"video_url"\s*:\s*"([^"]+)"/g);
      for (const vm of vidMatches) {
        const v = decodeUnicode(vm[1]);
        if (!allVideoUrls.includes(v)) allVideoUrls.push(v);
      }
    }

    if (allDisplayUrls.length > 0 || allVideoUrls.length > 0) {
      for (const v of allVideoUrls) items.push({ type: "video", url: v });
      for (const d of allDisplayUrls) {
        if (!items.some((i) => i.thumbnail === d))
          items.push({ type: "image", url: d });
      }
      if (items.length > 0) return items;
    }

    // Regex fallback — display_url (single values, no resources array)
    for (const script of scripts) {
      if (!script) continue;
      const displayMatches = script.matchAll(/"display_url"\s*:\s*"([^"]+)"/g);
      for (const dm of displayMatches) {
        const decoded = decodeUnicode(dm[1]);
        if (!items.some((i) => i.url === decoded))
          items.push({ type: "image", url: decoded });
      }
      const vidMatches = script.matchAll(/"video_url"\s*:\s*"([^"]+)"/g);
      for (const vm of vidMatches) {
        const decoded = decodeUnicode(vm[1]);
        if (!items.some((i) => i.url === decoded))
          items.push({ type: "video", url: decoded });
      }
    }

    if (items.length > 0) return items;

    // og:video / og:image as absolute last resort
    const ogVideo =
      $('meta[property="og:video"]').attr("content") ||
      $('meta[property="og:video:secure_url"]').attr("content");
    if (ogVideo) {
      items.push({
        type: "video",
        url: ogVideo,
        thumbnail:
          $('meta[property="og:image"]').attr("content") || undefined,
      });
    }
    const ogImage = $('meta[property="og:image"]').attr("content");
    if (ogImage && !items.some((i) => i.thumbnail === ogImage)) {
      items.push({ type: "image", url: ogImage });
    }

    return items;
  } catch {
    return [];
  }
}

// ── JSON parsing helpers ─────────────────────────────────────────────────────

function tryParseMediaJson(raw: string): MediaItem[] | null {
  // Try increasingly aggressive bracket balancing
  for (let i = 0; i < 5; i++) {
    try {
      const balanced = balanceBraces(raw, i);
      const obj = JSON.parse(balanced);
      return extractFromShortcodeMedia(obj);
    } catch {
      continue;
    }
  }
  return null;
}

function balanceBraces(s: string, extraClose: number): string {
  let depth = 0;
  for (const c of s) {
    if (c === "{" || c === "[") depth++;
    if (c === "}" || c === "]") depth--;
  }
  let result = s;
  for (let i = 0; i < depth + extraClose; i++) result += "}";
  return result;
}

/**
 * Given a shortcode_media object (from Instagram's GraphQL response),
 * extract all media items at their highest resolution.
 */
function extractFromShortcodeMedia(media: Record<string, unknown>): MediaItem[] {
  const items: MediaItem[] = [];

  // Check if this is a carousel (sidecar)
  const sidecar = media.edge_sidecar_to_children as
    | { edges: Array<{ node: Record<string, unknown> }> }
    | undefined;

  if (sidecar?.edges && Array.isArray(sidecar.edges)) {
    for (const edge of sidecar.edges) {
      const node = edge.node;
      items.push(extractSingleMedia(node));
    }
  } else {
    // Single media post
    items.push(extractSingleMedia(media));
  }

  return items;
}

function extractSingleMedia(node: Record<string, unknown>): MediaItem {
  const isVideo = node.is_video === true || !!node.video_url;

  // Get highest resolution image URL
  let imageUrl = "";
  const displayResources = node.display_resources as
    | Array<{ src: string; config_width: number }>
    | undefined;

  if (displayResources && Array.isArray(displayResources) && displayResources.length > 0) {
    // Sort by width descending, pick largest
    displayResources.sort((a, b) => b.config_width - a.config_width);
    imageUrl = decodeUnicode(displayResources[0].src);
  } else if (typeof node.display_url === "string") {
    imageUrl = decodeUnicode(node.display_url);
  }

  const dimensions = node.dimensions as
    | { width: number; height: number }
    | undefined;

  if (isVideo) {
    return {
      type: "video",
      url: decodeUnicode(node.video_url as string),
      thumbnail: imageUrl || undefined,
      width: dimensions?.width,
      height: dimensions?.height,
    };
  }

  return {
    type: "image",
    url: imageUrl,
    width: dimensions?.width,
    height: dimensions?.height,
  };
}
