import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 30;

export async function GET(req: NextRequest) {
  const mediaUrl = req.nextUrl.searchParams.get("url");
  const mediaType = req.nextUrl.searchParams.get("type") || "image";
  const forceDownload = req.nextUrl.searchParams.get("dl") === "1";

  if (!mediaUrl || !mediaUrl.startsWith("https://")) {
    return NextResponse.json({ error: "Valid HTTPS URL required" }, { status: 400 });
  }

  try {
    const response = await fetch(mediaUrl, {
      redirect: "follow",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        Accept: "*/*",
      },
    });

    if (!response.ok) {
      return NextResponse.json(
        { error: `Media fetch failed: ${response.status}` },
        { status: response.status }
      );
    }

    const buffer = await response.arrayBuffer();
    const contentType =
      response.headers.get("content-type") ||
      (mediaType === "video" ? "video/mp4" : "image/jpeg");

    const ext = mediaType === "video" ? "mp4" : "jpg";

    return new NextResponse(buffer, {
      headers: {
        "Content-Type": contentType,
        "Content-Disposition": forceDownload
          ? `attachment; filename="instagram_${Date.now()}.${ext}"`
          : "inline",
        "Content-Length": buffer.byteLength.toString(),
        "Cache-Control": "public, max-age=300",
        "Access-Control-Allow-Origin": "*",
      },
    });
  } catch (e) {
    return NextResponse.json(
      { error: `Proxy error: ${String(e).substring(0, 200)}` },
      { status: 500 }
    );
  }
}
