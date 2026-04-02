"use client";

import { useState } from "react";

interface MediaItem {
  type: "image" | "video";
  url: string;
  thumbnail?: string;
  width?: number;
  height?: number;
}

export default function Home() {
  const [url, setUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [items, setItems] = useState<MediaItem[]>([]);
  const [downloadingIdx, setDownloadingIdx] = useState<number | null>(null);
  const [downloadingAll, setDownloadingAll] = useState(false);

  const isValidInstagramUrl = (u: string) =>
    /^https?:\/\/(www\.)?instagram\.com\/(p|reel|reels)\/[\w-]+/i.test(u);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setItems([]);

    const trimmed = url.trim();
    if (!trimmed) {
      setError("Please paste an Instagram URL");
      return;
    }
    if (!isValidInstagramUrl(trimmed)) {
      setError("Please enter a valid Instagram post or reel URL");
      return;
    }

    setLoading(true);
    try {
      const res = await fetch("/api/download", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: trimmed }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to fetch media");
      setItems(data.items || []);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setLoading(false);
    }
  };

  const downloadOne = async (item: MediaItem, index: number) => {
    setDownloadingIdx(index);
    try {
      const res = await fetch(
        `/api/proxy?url=${encodeURIComponent(item.url)}&type=${item.type}&dl=1`
      );
      if (!res.ok) throw new Error("Download failed");
      const blob = await res.blob();
      const blobUrl = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = blobUrl;
      a.download = `instagram_${index + 1}_${Date.now()}.${item.type === "video" ? "mp4" : "jpg"}`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(blobUrl);
    } catch {
      setError("Failed to download. Please try again.");
    } finally {
      setDownloadingIdx(null);
    }
  };

  const downloadAll = async () => {
    setDownloadingAll(true);
    for (let i = 0; i < items.length; i++) {
      await downloadOne(items[i], i);
      // small delay between downloads so browser doesn't block them
      if (i < items.length - 1) await new Promise((r) => setTimeout(r, 500));
    }
    setDownloadingAll(false);
  };

  const handlePaste = async () => {
    try {
      const text = await navigator.clipboard.readText();
      setUrl(text);
    } catch {
      // clipboard access denied
    }
  };

  const proxyUrl = (mediaUrl: string, type: string) =>
    `/api/proxy?url=${encodeURIComponent(mediaUrl)}&type=${type}`;

  return (
    <main className="min-h-screen flex flex-col items-center justify-center px-4 py-12">
      <div className="w-full max-w-3xl mx-auto text-center">
        {/* Logo & Title */}
        <div className="mb-8">
          <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-gradient-to-br from-yellow-400 via-pink-500 to-purple-600 mb-4">
            <svg className="w-8 h-8 text-white" fill="currentColor" viewBox="0 0 24 24">
              <path d="M12 2.163c3.204 0 3.584.012 4.85.07 3.252.148 4.771 1.691 4.919 4.919.058 1.265.069 1.645.069 4.849 0 3.205-.012 3.584-.069 4.849-.149 3.225-1.664 4.771-4.919 4.919-1.266.058-1.644.07-4.85.07-3.204 0-3.584-.012-4.849-.07-3.26-.149-4.771-1.699-4.919-4.92-.058-1.265-.07-1.644-.07-4.849 0-3.204.013-3.583.07-4.849.149-3.227 1.664-4.771 4.919-4.919 1.266-.057 1.645-.069 4.849-.069zM12 0C8.741 0 8.333.014 7.053.072 2.695.272.273 2.69.073 7.052.014 8.333 0 8.741 0 12c0 3.259.014 3.668.072 4.948.2 4.358 2.618 6.78 6.98 6.98C8.333 23.986 8.741 24 12 24c3.259 0 3.668-.014 4.948-.072 4.354-.2 6.782-2.618 6.979-6.98.059-1.28.073-1.689.073-4.948 0-3.259-.014-3.667-.072-4.947-.196-4.354-2.617-6.78-6.979-6.98C15.668.014 15.259 0 12 0zm0 5.838a6.162 6.162 0 100 12.324 6.162 6.162 0 000-12.324zM12 16a4 4 0 110-8 4 4 0 010 8zm6.406-11.845a1.44 1.44 0 100 2.881 1.44 1.44 0 000-2.881z" />
            </svg>
          </div>
          <h1 className="text-4xl md:text-5xl font-bold text-white mb-2">
            Insta<span className="instagram-gradient">Grab</span>
          </h1>
          <p className="text-gray-400 text-lg">
            Download Instagram reels & photos instantly
          </p>
        </div>

        {/* Input Form */}
        <form onSubmit={handleSubmit} className="mb-8">
          <div className="flex flex-col sm:flex-row gap-3">
            <div className="flex-1 relative glow-border rounded-xl transition-all duration-300">
              <input
                type="text"
                value={url}
                onChange={(e) => {
                  setUrl(e.target.value);
                  setError("");
                }}
                placeholder="Paste Instagram link here..."
                className="w-full px-5 py-4 bg-white/10 backdrop-blur-sm text-white placeholder-gray-400 rounded-xl border border-white/20 focus:outline-none focus:border-pink-500 transition-colors text-base"
              />
              <button
                type="button"
                onClick={handlePaste}
                className="absolute right-3 top-1/2 -translate-y-1/2 px-3 py-1.5 text-xs font-medium text-pink-400 hover:text-pink-300 bg-white/5 hover:bg-white/10 rounded-lg transition-colors"
              >
                Paste
              </button>
            </div>
            <button
              type="submit"
              disabled={loading}
              className="px-8 py-4 bg-gradient-to-r from-pink-500 to-purple-600 hover:from-pink-600 hover:to-purple-700 text-white font-semibold rounded-xl transition-all duration-300 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2 min-w-[140px]"
            >
              {loading ? (
                <>
                  <Spinner />
                  Fetching...
                </>
              ) : (
                <>
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                  </svg>
                  Get Media
                </>
              )}
            </button>
          </div>
        </form>

        {/* Error */}
        {error && (
          <div className="mb-6 px-4 py-3 bg-red-500/10 border border-red-500/30 rounded-xl text-red-400 text-sm">
            {error}
          </div>
        )}

        {/* Results */}
        {items.length > 0 && (
          <div className="space-y-4">
            {/* Download All button (for multi-item posts) */}
            {items.length > 1 && (
              <div className="flex items-center justify-between bg-white/5 backdrop-blur-sm border border-white/10 rounded-2xl px-6 py-4">
                <span className="text-gray-300 text-sm font-medium">
                  {items.length} items found
                </span>
                <button
                  onClick={downloadAll}
                  disabled={downloadingAll}
                  className="px-6 py-2.5 bg-gradient-to-r from-blue-500 to-indigo-600 hover:from-blue-600 hover:to-indigo-700 text-white font-semibold rounded-xl transition-all duration-300 disabled:opacity-50 flex items-center gap-2"
                >
                  {downloadingAll ? (
                    <>
                      <Spinner />
                      Downloading All...
                    </>
                  ) : (
                    <>
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                      </svg>
                      Download All
                    </>
                  )}
                </button>
              </div>
            )}

            {/* Media cards */}
            <div className={`grid gap-4 ${items.length === 1 ? "grid-cols-1" : "grid-cols-1 sm:grid-cols-2"}`}>
              {items.map((item, idx) => (
                <div
                  key={idx}
                  className="bg-white/5 backdrop-blur-sm border border-white/10 rounded-2xl p-4 transition-all hover:border-white/20"
                >
                  {/* Preview */}
                  <div className="mb-3 rounded-xl overflow-hidden bg-black/30 relative">
                    {item.type === "video" ? (
                      <video
                        src={proxyUrl(item.url, "video")}
                        controls
                        className="w-full max-h-[400px] object-contain"
                        poster={
                          item.thumbnail
                            ? proxyUrl(item.thumbnail, "image")
                            : undefined
                        }
                      />
                    ) : (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={proxyUrl(item.url, "image")}
                        alt={`Instagram media ${idx + 1}`}
                        className="w-full object-contain"
                        style={{ maxHeight: "500px" }}
                      />
                    )}
                    {/* Badge */}
                    <span className="absolute top-2 left-2 px-2 py-1 rounded-lg bg-black/60 text-white text-xs font-medium flex items-center gap-1">
                      {item.type === "video" ? (
                        <>
                          <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 24 24">
                            <path d="M8 5v14l11-7z" />
                          </svg>
                          Video
                        </>
                      ) : (
                        <>
                          <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                          </svg>
                          Photo
                        </>
                      )}
                    </span>
                    {items.length > 1 && (
                      <span className="absolute top-2 right-2 px-2 py-1 rounded-lg bg-black/60 text-white text-xs font-bold">
                        {idx + 1}/{items.length}
                      </span>
                    )}
                  </div>

                  {/* Info + Download */}
                  <div className="flex items-center justify-between">
                    <span className="text-gray-500 text-xs">
                      {item.width && item.height
                        ? `${item.width} × ${item.height}`
                        : "Original size"}
                    </span>
                    <button
                      onClick={() => downloadOne(item, idx)}
                      disabled={downloadingIdx === idx}
                      className="px-5 py-2 bg-gradient-to-r from-green-500 to-emerald-600 hover:from-green-600 hover:to-emerald-700 text-white text-sm font-semibold rounded-xl transition-all duration-300 disabled:opacity-50 flex items-center gap-2"
                    >
                      {downloadingIdx === idx ? (
                        <>
                          <Spinner />
                          Saving...
                        </>
                      ) : (
                        <>
                          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                          </svg>
                          Download
                        </>
                      )}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Footer */}
        <p className="mt-12 text-gray-500 text-xs">
          Only works with public Instagram posts and reels.
        </p>
      </div>
    </main>
  );
}

function Spinner() {
  return (
    <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
    </svg>
  );
}
