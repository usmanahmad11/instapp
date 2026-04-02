import { NextRequest, NextResponse } from "next/server";

export const runtime = "edge";

export async function GET(req: NextRequest) {
  const mediaUrl = req.nextUrl.searchParams.get("url");
  const mediaType = req.nextUrl.searchParams.get("type") || "image";
  const forceDownload = req.nextUrl.searchParams.get("dl") === "1";

  if (!mediaUrl) {
    return NextResponse.json({ error: "URL is required" }, { status: 400 });
  }

  // Validate the URL is from Instagram/Facebook CDN
  try {
    const parsedUrl = new URL(mediaUrl);
    const host = parsedUrl.hostname.toLowerCase();
    const isAllowed =
      host.includes("scontent") ||
      host.includes("instagram") ||
      host.includes("cdninstagram") ||
      host.includes("fbcdn") ||
      host.includes("facebook") ||
      host.includes("fbsbx") ||
      host.includes("fna.");
    if (!isAllowed) {
      return NextResponse.json(
        { error: `Host not allowed: ${host}` },
        { status: 403 }
      );
    }
  } catch {
    return NextResponse.json(
      { error: `Invalid URL: ${mediaUrl.substring(0, 100)}` },
      { status: 400 }
    );
  }

  try {
    const response = await fetch(mediaUrl, {
      headers: {
        "User-Agent":
          "Instagram 275.0.0.27.98 Android (33/13; 420dpi; 1080x2400; samsung; SM-G991B; o1s; exynos2100; en_US; 458229258)",
        Accept: "*/*",
        "Accept-Encoding": "identity",
        Referer: "https://www.instagram.com/",
      },
      redirect: "follow",
    });

    if (!response.ok) {
      return NextResponse.json(
        {
          error: `CDN returned ${response.status}`,
          url: mediaUrl.substring(0, 120),
        },
        { status: response.status }
      );
    }

    const contentType =
      response.headers.get("content-type") ||
      (mediaType === "video" ? "video/mp4" : "image/jpeg");

    const buffer = await response.arrayBuffer();

    const ext = mediaType === "video" ? "mp4" : "jpg";
    const disposition = forceDownload
      ? `attachment; filename="instagram_${Date.now()}.${ext}"`
      : "inline";

    return new NextResponse(buffer, {
      headers: {
        "Content-Type": contentType,
        "Content-Disposition": disposition,
        "Content-Length": buffer.byteLength.toString(),
        "Cache-Control": "public, max-age=3600",
        "Access-Control-Allow-Origin": "*",
      },
    });
  } catch (e) {
    return NextResponse.json(
      { error: `Proxy fetch failed: ${String(e).substring(0, 200)}` },
      { status: 500 }
    );
  }
}
