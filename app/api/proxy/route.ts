import { NextRequest, NextResponse } from "next/server";

export const runtime = "edge";

export async function GET(req: NextRequest) {
  const mediaUrl = req.nextUrl.searchParams.get("url");
  const mediaType = req.nextUrl.searchParams.get("type") || "image";

  if (!mediaUrl) {
    return NextResponse.json({ error: "URL is required" }, { status: 400 });
  }

  // Validate URL is from Instagram/Facebook CDN
  try {
    const host = new URL(mediaUrl).hostname.toLowerCase();
    const isAllowed =
      host.includes("scontent") ||
      host.includes("instagram") ||
      host.includes("cdninstagram") ||
      host.includes("fbcdn") ||
      host.includes("facebook") ||
      host.includes("fbsbx");
    if (!isAllowed) {
      return NextResponse.json({ error: `Host not allowed: ${host}` }, { status: 403 });
    }
  } catch {
    return NextResponse.json({ error: "Invalid URL" }, { status: 400 });
  }

  try {
    // Try multiple header combinations
    const headerSets: Record<string, string>[] = [
      { Accept: "*/*" },
      {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        Accept: "*/*",
        Referer: "https://www.instagram.com/",
      },
      {
        "User-Agent": "Instagram 275.0.0.27.98 Android",
        Accept: "*/*",
      },
    ];

    for (const headers of headerSets) {
      const response = await fetch(mediaUrl, { headers, redirect: "follow" });
      if (!response.ok) continue;

      const buffer = await response.arrayBuffer();
      const contentType =
        response.headers.get("content-type") ||
        (mediaType === "video" ? "video/mp4" : "image/jpeg");

      const ext = mediaType === "video" ? "mp4" : "jpg";
      return new NextResponse(buffer, {
        headers: {
          "Content-Type": contentType,
          "Content-Disposition": `attachment; filename="instagram_${Date.now()}.${ext}"`,
          "Content-Length": buffer.byteLength.toString(),
          "Cache-Control": "public, max-age=3600",
          "Access-Control-Allow-Origin": "*",
        },
      });
    }

    return NextResponse.json({ error: "CDN rejected all attempts" }, { status: 403 });
  } catch (e) {
    return NextResponse.json(
      { error: `Proxy error: ${String(e).substring(0, 200)}` },
      { status: 500 }
    );
  }
}
