import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "PFA Cage Rentals",
  description:
    "Cage, bullpen, and weight-room rental tracking for PFA Baseball.",
  // iOS standalone PWA — without these, "Add to Home Screen" still works
  // but opens the page in Safari with the URL bar instead of as an app.
  appleWebApp: {
    capable: true,
    title: "PFA Rentals",
    statusBarStyle: "black-translucent",
  },
};

export const viewport: Viewport = {
  // FEAT-04 light rebrand: browser/PWA chrome color matches the white
  // page background (--color-page). Kept as a literal because <meta
  // name="theme-color"> can't read CSS custom properties.
  themeColor: "#ffffff",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full`}
    >
      <body className="min-h-full flex flex-col bg-page text-fg antialiased">
        {children}
      </body>
    </html>
  );
}
