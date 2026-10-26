import type { SkillCategory } from "@openbot/contracts/ipc";
import type { AppTextKey } from "@openbot/i18n";
import { Lock } from "@openbot/ui";
import type { JSX } from "@solidjs/web";
import { DiscordMark, GitHubMark, OnePasswordMark, SlackMark, TelegramMark } from "../settings/brand-marks";
import type { ConnectorId } from "./connectors";

export interface ConnectorListing {
  title: AppTextKey;
  /** The line under the name on a Marketplace card. */
  tagline: AppTextKey;
  /** The Marketplace category. */
  category: SkillCategory;
  /** The logo, without its tile. */
  Mark: () => JSX.Element;
}

/** What each connector is called and how it looks, on every screen that lists it. */
export const CONNECTOR_LISTINGS: Readonly<Record<ConnectorId, ConnectorListing>> = {
  slack: {
    title: "connector.slack.title",
    tagline: "connector.slack.description",
    category: "productivity",
    Mark: () => <SlackMark />,
  },
  discord: {
    title: "connector.discord.title",
    tagline: "connector.discord.description",
    category: "productivity",
    Mark: () => <DiscordMark />,
  },
  telegram: {
    title: "connector.telegram.title",
    tagline: "connector.telegram.description",
    category: "productivity",
    Mark: () => <TelegramMark />,
  },
  github: {
    title: "connector.github.title",
    tagline: "marketplace.app.githubTagline",
    category: "coding",
    Mark: () => <GitHubMark />,
  },
  onepassword: {
    title: "connector.onePassword.title",
    tagline: "marketplace.app.onePasswordTagline",
    category: "productivity",
    Mark: () => <OnePasswordMark />,
  },
  bitwarden: {
    title: "connector.bitwarden.title",
    tagline: "connector.bitwarden.description",
    category: "productivity",
    Mark: () => <Lock aria-hidden="true" />,
  },
};
