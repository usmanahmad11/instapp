import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "InstaGrab - Download Instagram Reels & Photos",
  description: "Download Instagram public reels and photos for free. Just paste the link!",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="antialiased">{children}</body>
    </html>
  );
}
