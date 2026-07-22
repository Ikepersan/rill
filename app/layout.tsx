import type { Metadata } from "next";
import { headers } from "next/headers";
import { Geist_Mono, Noto_Sans_JP, Noto_Serif_JP } from "next/font/google";
import "./globals.css";

const rillSans = Noto_Sans_JP({
  variable: "--font-rill-sans",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  display: "swap",
});

const rillSerif = Noto_Serif_JP({
  variable: "--font-rill-serif",
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  display: "swap",
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const host = requestHeaders.get("x-forwarded-host") ?? requestHeaders.get("host") ?? "localhost:3000";
  const protocol = requestHeaders.get("x-forwarded-proto") ?? (host.includes("localhost") ? "http" : "https");
  const baseUrl = new URL(`${protocol}://${host}`);
  const title = "Rill — Medical Literature Workspace";
  const description = "Google DriveのPDF、論文タグ、Clinical note、Obsidian向けMarkdownをひとつにつなぐ医学文献ワークスペース。";
  const socialImage = new URL("/og.png", baseUrl).toString();

  return {
    metadataBase: baseUrl,
    title,
    description,
    openGraph: {
      title,
      description,
      type: "website",
      url: baseUrl,
      images: [{ url: socialImage, width: 1732, height: 909, alt: "Rill — 医学論文を、読む・残す・つなぐ。" }],
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      images: [socialImage],
    },
  };
}

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ja">
      <body className={`${rillSans.variable} ${rillSerif.variable} ${geistMono.variable}`}>{children}</body>
    </html>
  );
}
