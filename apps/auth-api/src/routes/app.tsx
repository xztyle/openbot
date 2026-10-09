import { createFileRoute } from "@tanstack/solid-router";

export const Route = createFileRoute("/app")({
  head: () => ({
    meta: [
      { title: "OpenBot web" },
      { name: "robots", content: "noindex, nofollow" },
      // The keyboard shrinks the layout on Android, so the composer stays above it instead of under it.
      { name: "viewport", content: "width=device-width, initial-scale=1, interactive-widget=resizes-content" },
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
