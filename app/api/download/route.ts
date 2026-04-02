import { NextRequest, NextResponse } from "next/server";
import * as cheerio from "cheerio";

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

    // Clean the URL - remove query params and trailing slash
    const cleanUrl = url.split("?")[0].replace(/\/$/, "") + "/";

    // Try multiple extraction methods
    const result = await extractMedia(cleanUrl);
    if (!result) {
      return NextResponse.json(
        { error: "Could not extract media. The post may be private or unavailable." },
        { status: 404 }
      );
    }

    return NextResponse.json(result);
  } catch (error) {
    console.error("Download API error:", error);
    return NextResponse.json(
      { error: "Failed to process the Instagram URL. Please try again." },
      { status: 500 }
    );
  }
}

async function extractMedia(url: string) {
  // Method 1: Fetch the page and parse og meta tags
  const result = await fetchAndParseOgTags(url);
  if (result) return result;

  // Method 2: Try the embed page
  const embedResult = await fetchEmbed(url);
  if (embedResult) return embedResult;

  return null;
}

// Remove crop/size params from Instagram CDN URLs to get full resolution
function getFullResUrl(imageUrl: string): string {
  // Instagram CDN URLs contain size params like /s640x640/ or /s1080x1080/
  // or crop params like /c0.0.1440.1440a/ — stripping these gives full resolution
  let fullUrl = imageUrl;
  // Remove size restriction like /s150x150/ or /s640x640/ or /s1080x1080/
  fullUrl = fullUrl.replace(/\/s\d+x\d+\//, "/");
  // Remove crop params like /c0.135.1080.1080a/ or /c0.0.1440.1440/
  fullUrl = fullUrl.replace(/\/c[\d.]+a?\//, "/");
  // Remove /e\d+/ (encoding param that can limit quality)
  fullUrl = fullUrl.replace(/\/e\d+\//, "/");
  // Remove square crop flag /sh0.08/ etc
  fullUrl = fullUrl.replace(/\/sh[\d.]+\//, "/");
  return fullUrl;
}

async function fetchAndParseOgTags(url: string) {
  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
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

    if (!response.ok) return null;

    const html = await response.text();
    const $ = cheerio.load(html);

    // PRIORITY 1: Try embedded JSON data in scripts first — these have full-res URLs
    const scripts = $("script")
      .map((_, el) => $(el).html())
      .get();

    for (const script of scripts) {
      if (!script) continue;

      // Look for video_url in the script data
      const videoMatch = script.match(/"video_url"\s*:\s*"([^"]+)"/);
      if (videoMatch) {
        const videoUrl = videoMatch[1].replace(/\\u0026/g, "&");
        const thumbMatch = script.match(/"display_url"\s*:\s*"([^"]+)"/);
        const thumbnail = thumbMatch
          ? thumbMatch[1].replace(/\\u0026/g, "&")
          : undefined;
        return { type: "video" as const, url: videoUrl, thumbnail };
      }

      // display_url from JSON is the full-resolution image
      const imageMatch = script.match(/"display_url"\s*:\s*"([^"]+)"/);
      if (imageMatch) {
        const imageUrl = imageMatch[1].replace(/\\u0026/g, "&");
        return { type: "image" as const, url: imageUrl };
      }
    }

    // PRIORITY 2: Check og:video for reels
    const ogVideo =
      $('meta[property="og:video"]').attr("content") ||
      $('meta[property="og:video:secure_url"]').attr("content");

    if (ogVideo) {
      const thumbnail =
        $('meta[property="og:image"]').attr("content") || undefined;
      return { type: "video" as const, url: ogVideo, thumbnail };
    }

    // PRIORITY 3: og:image as last resort — strip crop/size params for full res
    const ogImage = $('meta[property="og:image"]').attr("content");
    if (ogImage) {
      return { type: "image" as const, url: getFullResUrl(ogImage) };
    }

    return null;
  } catch {
    return null;
  }
}

async function fetchEmbed(url: string) {
  try {
    // Use Instagram's oEmbed endpoint
    const oembedUrl = `https://graph.facebook.com/v18.0/instagram_oembed?url=${encodeURIComponent(url)}&access_token=IGQVJW`;

    // Alternative: use the embed page directly
    const embedPageUrl = url.replace(/\/$/, "") + "/embed/";
    const response = await fetch(embedPageUrl, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.5",
      },
      redirect: "follow",
    });

    if (!response.ok) return null;

    const html = await response.text();
    const $ = cheerio.load(html);

    // Look for video in embed page
    const video = $("video source").attr("src") || $("video").attr("src");
    if (video) {
      const poster = $("video").attr("poster") || undefined;
      return { type: "video" as const, url: video, thumbnail: poster };
    }

    // Parse embedded JSON data in scripts first — full resolution
    const scripts = $("script")
      .map((_, el) => $(el).html())
      .get();

    for (const script of scripts) {
      if (!script) continue;

      const videoMatch = script.match(/"video_url"\s*:\s*"([^"]+)"/);
      if (videoMatch) {
        return {
          type: "video" as const,
          url: videoMatch[1].replace(/\\u0026/g, "&"),
        };
      }

      const imgMatch = script.match(/"display_url"\s*:\s*"([^"]+)"/);
      if (imgMatch) {
        return {
          type: "image" as const,
          url: imgMatch[1].replace(/\\u0026/g, "&"),
        };
      }
    }

    // Fallback: image from embed HTML — strip crop params
    const img = $(".EmbeddedMediaImage").attr("src") || $("img.EmbeddedMediaImage").attr("src");
    if (img) {
      return { type: "image" as const, url: getFullResUrl(img) };
    }

    return null;
  } catch {
    return null;
  }
}
