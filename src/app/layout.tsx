import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/ui/toaster";
import { ThemeProvider } from "next-themes";
import Script from "next/script";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "SummarAI — AI chat & YouTube summarizer",
  description:
    "SummarAI is an AI chat assistant with YouTube video summarization, interview Q&A generation, and conversational video Q&A.",
  keywords: ["SummarAI", "AI chat", "YouTube summarizer", "interview Q&A", "Next.js"],
  authors: [{ name: "SummarAI" }],
  icons: {
    icon: "https://z-cdn.chatglm.cn/z-ai/static/logo.svg",
  },
};

// Runs BEFORE React hydrates. Strips Dark Reader's injected attributes and
// CSS variables from the DOM so the server-rendered HTML matches the client
// HTML, preventing the "A tree hydrated but some attributes didn't match"
// hydration error overlay.
const darkReaderGuard = `(function () {
  try {
    if (typeof document === "undefined") return;
    var ready = function () {
      // 1) Remove Dark Reader's injected <style> blocks
      document
        .querySelectorAll("style[data-darkreader-inline-stroke], style[data-darkreader-inline-fill], style[data-darkreader-inline-color], style[data-darkreader-bgcolor], style[data-darkreader-proxy]")
        .forEach(function (el) { el.remove(); });
      // 2) Strip Dark Reader's data-* attributes and CSS custom properties from every element
      document.querySelectorAll("*").forEach(function (el) {
        var toRemove = [];
        for (var i = 0; i < el.attributes.length; i++) {
          var name = el.attributes[i].name;
          if (name.indexOf("data-darkreader") === 0) toRemove.push(name);
        }
        toRemove.forEach(function (n) { el.removeAttribute(n); });
        if (el.style && el.style.cssText) {
          var cleaned = el.style.cssText.replace(/--darkreader[^:;]+:[^;]+;?/g, "").trim();
          if (cleaned !== el.style.cssText.trim()) el.style.cssText = cleaned;
        }
      });
    };
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", ready, { once: true });
    } else {
      ready();
    }
    // Re-run after a tick — Dark Reader is async and keeps re-injecting.
    setTimeout(ready, 0);
    setTimeout(ready, 250);
  } catch (e) { /* no-op */ }
})();`;

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased bg-background text-foreground`}
        suppressHydrationWarning
      >
        <Script
          id="dark-reader-guard"
          strategy="beforeInteractive"
          dangerouslySetInnerHTML={{ __html: darkReaderGuard }}
        />
        <ThemeProvider
          attribute="class"
          defaultTheme="dark"
          enableSystem={false}
          disableTransitionOnChange
        >
          {children}
          <Toaster />
        </ThemeProvider>
      </body>
    </html>
  );
}
