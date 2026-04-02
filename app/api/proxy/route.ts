import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const mediaUrl = req.nextUrl.searchParams.get("url");
  const mediaType = req.nextUrl.searchParams.get("type") || "image";
  // dl=1 means force download headers, otherwise stream for preview
  const forceDownload = req.nextUrl.searchParams.get("dl") === "1";

  if (!mediaUrl) {
    return NextResponse.json({ error: "URL is required" }, { status: 400 });
  }

  // Only allow proxying Instagram / Facebook CDN URLs
  try {
    const parsedUrl = new URL(mediaUrl);
    const host = parsedUrl.hostname;
    const isAllowed =
      host.includes("scontent") ||
      host.includes("instagram") ||
      host.includes("cdninstagram") ||
      host.endsWith(".fbcdn.net") ||
      host.endsWith(".fna.fbcdn.net");
    if (!isAllowed) {
      return NextResponse.json({ error: "URL not allowed" }, { status: 403 });
    }
  } catch {
    return NextResponse.json({ error: "Invalid URL" }, { status: 400 });
  }

  try {
    const response = await fetch(mediaUrl, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        Referer: "https://www.instagram.com/",
        Origin: "https://www.instagram.com",
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
    const contentLength = response.headers.get("content-length");

    const buffer = await response.arrayBuffer();

    const ext = mediaType === "video" ? "mp4" : "jpg";
    const disposition = forceDownload
      ? `attachment; filename="instagram_${Date.now()}.${ext}"`
      : "inline";

    const headers: Record<string, string> = {
      "Content-Type": contentType,
      "Content-Disposition": disposition,
      "Cache-Control": "public, max-age=3600",
      "Access-Control-Allow-Origin": "*",
    };
    if (contentLength) headers["Content-Length"] = contentLength;

    return new NextResponse(buffer, { headers });
  } catch {
    return NextResponse.json(
      { error: "Failed to proxy media" },
      { status: 500 }
    );
  }
}
