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

    // Check for video first (reels)
    const ogVideo =
      $('meta[property="og:video"]').attr("content") ||
      $('meta[property="og:video:secure_url"]').attr("content");

    if (ogVideo) {
      const thumbnail =
        $('meta[property="og:image"]').attr("content") || undefined;
      return { type: "video" as const, url: ogVideo, thumbnail };
    }

    // Check for image
    const ogImage = $('meta[property="og:image"]').attr("content");
    if (ogImage) {
      return { type: "image" as const, url: ogImage };
    }

    // Try to find video in script tags (Instagram embeds JSON data)
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

      // Look for display_url for images
      const imageMatch = script.match(/"display_url"\s*:\s*"([^"]+)"/);
      if (imageMatch) {
        const imageUrl = imageMatch[1].replace(/\\u0026/g, "&");
        return { type: "image" as const, url: imageUrl };
      }
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

    // Look for image in embed page
    const img = $(".EmbeddedMediaImage").attr("src") || $("img.EmbeddedMediaImage").attr("src");
    if (img) {
      return { type: "image" as const, url: img };
    }

    // Parse embedded JSON data in scripts
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

      // Look for image URLs in embed data
      const imgMatch = script.match(/"display_url"\s*:\s*"([^"]+)"/);
      if (imgMatch) {
        return {
          type: "image" as const,
          url: imgMatch[1].replace(/\\u0026/g, "&"),
        };
      }
    }

    return null;
  } catch {
    return null;
  }
}
