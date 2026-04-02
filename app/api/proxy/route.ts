import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 30;

export async function GET(req: NextRequest) {
  const mediaUrl = req.nextUrl.searchParams.get("url");
  const mediaType = req.nextUrl.searchParams.get("type") || "image";
  const forceDownload = req.nextUrl.searchParams.get("dl") === "1";

  if (!mediaUrl) {
    return NextResponse.json({ error: "URL is required" }, { status: 400 });
  }

  // Validate URL is from known CDN domains
  let host = "";
  try {
    host = new URL(mediaUrl).hostname.toLowerCase();
  } catch {
    return NextResponse.json({ error: "Invalid URL" }, { status: 400 });
  }

  const allowed =
    host.includes("scontent") ||
    host.includes("instagram") ||
    host.includes("cdninstagram") ||
    host.includes("fbcdn") ||
    host.includes("facebook") ||
    host.includes("fbsbx") ||
    // Third-party scraper CDNs (used by igdl)
    host.includes("saveinsta") ||
    host.includes("snapinsta") ||
    host.includes("ddinstagram") ||
    host.includes("igdownloader") ||
    // Allow any HTTPS URL as fallback (the media URL came from our own API)
    mediaUrl.startsWith("https://");

  if (!allowed) {
    return NextResponse.json({ error: `Host not allowed: ${host}` }, { status: 403 });
  }

  try {
    // CDN URLs use time-based tokens, NOT IP-based restrictions.
    // A simple fetch with minimal headers should work.
    const response = await fetch(mediaUrl, {
      redirect: "follow",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      },
    });

    if (!response.ok) {
      return NextResponse.json(
        { error: `Media server returned ${response.status}`, host },
        { status: response.status }
      );
    }

    const buffer = await response.arrayBuffer();
    const contentType =
      response.headers.get("content-type") ||
      (mediaType === "video" ? "video/mp4" : "image/jpeg");

    const ext = mediaType === "video" ? "mp4" : "jpg";
    const disposition = forceDownload
      ? `attachment; filename="instagram_${Date.now()}.${ext}"`
      : "inline";

    return new NextResponse(buffer, {
      headers: {
        "Content-Type": contentType,
        "Content-Disposition": disposition,
        "Content-Length": buffer.byteLength.toString(),
        "Cache-Control": "public, max-age=300",
        "Access-Control-Allow-Origin": "*",
      },
    });
  } catch (e) {
    return NextResponse.json(
      { error: `Proxy error: ${String(e).substring(0, 300)}` },
      { status: 500 }
    );
  }
}
