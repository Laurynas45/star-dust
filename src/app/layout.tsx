import type { Metadata } from "next";
import { Nav } from "@/components/Nav";
import "./globals.css";

export const metadata: Metadata = {
  title: "Star Dust — local image-to-video studio",
  description:
    "Offline image-to-video studio. ffmpeg Ken Burns with no GPU, a shot list you can render and stitch, plus optional fal, Replicate, and ComfyUI.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="dark">
      <body className="antialiased">
        <Nav />
        <main className="mx-auto max-w-6xl px-4 py-8">{children}</main>
        <footer className="mx-auto max-w-6xl px-4 pb-10 text-xs text-[var(--muted)]">
          Local studio, MIT license. Mock is camera motion only. A hosted pack
          with accounts and billing is not in this release.
        </footer>
      </body>
    </html>
  );
}
