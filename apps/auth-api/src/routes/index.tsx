import { createFileRoute } from "@tanstack/solid-router";
import { AtelierLanding } from "../components/landing/AtelierLanding";
import { atelierHomeHead } from "../lib/atelier-home-head";

export const Route = createFileRoute("/")({
  head: ({ match }) => atelierHomeHead(match.context.siteUrl),
  component: AtelierLanding,
});
