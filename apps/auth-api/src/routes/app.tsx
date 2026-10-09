import { createFileRoute } from "@tanstack/solid-router";

export const Route = createFileRoute("/app")({
  head: () => ({
    meta: [
      { title: "OpenBot web" },
      { name: "robots", content: "noindex, nofollow" },
      // The keyboard shrinks the layout on Android, so the composer stays above it instead of under it.
      { name: "viewport", content: "width=device-width, initial-scale=1, interactive-widget=resizes-content" },
      // The app can be added to the home screen. Safari reads these, and not the manifest, for its own mode.
      { name: "mobile-web-app-capable", content: "yes" },
      { name: "apple-mobile-web-app-capable", content: "yes" },
      { name: "apple-mobile-web-app-title", content: "OpenBot" },
      { name: "apple-mobile-web-app-status-bar-style", content: "black" },
    ],
    links: [
      // The app is behind Cloudflare Access, which answers a request with no cookie by a sign-in page.
      // A manifest request sends no cookie unless it asks for one.
      { rel: "manifest", href: "/app.webmanifest", crossorigin: "use-credentials" as const },
      // Opaque: iOS fills the transparent corners of the site's touch icon with black.
      { rel: "apple-touch-icon", href: "/app-apple-touch-icon.png", sizes: "180x180" },
    ],
  }),
  headers: () => ({
    "Cache-Control": "no-store",
    "X-Robots-Tag": "noindex, nofollow",
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy": "frame-ancestors 'none'",
    "X-Frame-Options": "DENY",
  }),
});
