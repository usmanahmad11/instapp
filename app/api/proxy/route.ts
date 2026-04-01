import { NextRequest, NextResponse } from "next/server";

export async function GET(req: NextRequest) {
  const mediaUrl = req.nextUrl.searchParams.get("url");
  const mediaType = req.nextUrl.searchParams.get("type") || "image";

  if (!mediaUrl) {
    return NextResponse.json({ error: "URL is required" }, { status: 400 });
  }

  // Only allow proxying Instagram CDN URLs
  const allowedHosts = [
    "scontent",
    "instagram",
    "cdninstagram",
    "fbcdn.net",
    "fbcdn",
  ];
  try {
    const parsedUrl = new URL(mediaUrl);
    const isAllowed = allowedHosts.some(
      (host) =>
        parsedUrl.hostname.includes(host) ||
        parsedUrl.hostname.endsWith(".fbcdn.net") ||
        parsedUrl.hostname.endsWith(".cdninstagram.com") ||
        parsedUrl.hostname.endsWith(".instagram.com")
    );
    if (!isAllowed) {
      return NextResponse.json(
        { error: "URL not allowed" },
        { status: 403 }
      );
    }
  } catch {
    return NextResponse.json({ error: "Invalid URL" }, { status: 400 });
  }

  try {
    const response = await fetch(mediaUrl, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Referer: "https://www.instagram.com/",
      },
    });

    if (!response.ok) {
      return NextResponse.json(
        { error: "Failed to fetch media" },
        { status: response.status }
      );
    }

    const contentType =
      response.headers.get("content-type") ||
      (mediaType === "video" ? "video/mp4" : "image/jpeg");

    const buffer = await response.arrayBuffer();

    return new NextResponse(buffer, {
      headers: {
        "Content-Type": contentType,
        "Content-Disposition": `attachment; filename="instagram_${Date.now()}.${mediaType === "video" ? "mp4" : "jpg"}"`,
        "Cache-Control": "public, max-age=3600",
      },
    });
  } catch {
    return NextResponse.json(
      { error: "Failed to proxy media" },
      { status: 500 }
    );
  }
}
