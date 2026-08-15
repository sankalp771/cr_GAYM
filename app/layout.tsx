import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Archivo, Chakra_Petch, IBM_Plex_Mono } from "next/font/google";
import "./globals.css";

/*
 * Typefaces.
 *
 * `next/font` downloads and self-hosts these at build time, so there is no
 * runtime request to a font CDN — no third-party connection, no flash of
 * unstyled text, and nothing to break if Google Fonts is blocked or slow.
 *
 * Three roles, deliberately: Chakra Petch is angular and mechanical and carries
 * the headings; Archivo is a sturdy grotesque that holds up at small sizes for
 * running text and UI; IBM Plex Mono sets labels, counters and eyebrows, where
 * the fixed advance is doing real work rather than decoration.
 */
const heading = Chakra_Petch({
  subsets: ["latin"],
  weight: ["600", "700"],
  variable: "--font-heading",
  display: "swap"
});

const sans = Archivo({
  subsets: ["latin"],
  variable: "--font-sans",
  display: "swap"
});

const code = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500"],
  variable: "--font-code",
  display: "swap"
});

export const metadata: Metadata = {
  title: "Chain Reaction Global",
  description:
    "Overload a cell and it detonates into its neighbours. Play locally against up to seven bots, or share a room code and play online."
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en" className={`${heading.variable} ${sans.variable} ${code.variable}`}>
      <body className="min-h-screen bg-[var(--bg)] text-[var(--text)] antialiased">{children}</body>
    </html>
  );
}
