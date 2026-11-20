# Product rename: OpenBot to Atelier

The product that users see is now **Atelier**. Phase 1 changed only names and wording. The logo,
colours, avatars and design tokens did not change; a later phase changes the visual identity.

## Renamed in phase 1

- **Interface text** (`packages/i18n/src/messages/*`, all 12 languages): about 9,200 occurrences of
  "OpenBot" in UI text, errors, notices ("Atelier restarted…", "Atelier sent … a note"), settings,
  onboarding, notifications, window titles and mobile text. Korean particles and Turkish suffixes
  follow the new name. Keys did not change, for example `remoteDesktop.backToOpenBot`.
- **Web app** (`apps/auth-api`): the `/app` page title and `apple-mobile-web-app-title`,
  `app.webmanifest` and `site.webmanifest` names, the 404 title, the push notification fallback
  title in `public/app/sw.js`, and the web server name fallback.
- **Desktop**: the `<title>` of `index.html`, `helper.html` and `browser-pip.html`, the browser
  picture-in-picture window, and the welcome and test notifications.
- **Account service**: the sign-in, invitation and welcome emails, the `From:` display name, the
  sign-in and contact delivery errors, the MCP sign-in return page, the host update (426) errors and
  the "Another Atelier server answers…" connector conflicts.
- **Host errors sent as text** that the catalog translates by their English (`sourceText` matching):
  MCP name clash, ChatGPT sign-in page, provider connect failure, unmanaged provider CLI. The E2E
  scripts and stories that compare this text now use the new text.
- **Interface literals**: sign-in and setup wordmark text, avatar fallback, generated server name,
  remote host gateway title, agent template share card, logo label, update target.
- **Agent-facing text**: developer instructions, tool guidance, tool descriptions, notes
  ("Atelier note: …") and tool errors name the product Atelier. The direct tool lists say
  "openbot tools", so the model sees that the tool namespace did not change.

## Kept on purpose (rename in a later phase)

These are identifiers, stored values, protocol strings or names of external things. A change can
break saved data, released clients, or an outside integration.

| Kept | Why |
| --- | --- |
| Tool names and namespaces `openbot.*`, `openbot_browser.*`, `openbotPage`, MCP server names | Agents, saved prompts and provider sessions call them by name. |
| Skill ids (`openbot-motion`, `openbot-data`, `openbot-export`, …) | Installed skills and prompts name them. |
| Prompt tags `<openbot_saved_memories>`, `<openbot_section_teammates>` | Protocol between host and model. |
| Package names `@openbot/*`, CLI `openbot`, `openbot-host`, docker images, systemd units | Build, deploy and install scripts. |
| Env vars `OPENBOT_*`, headers `X-OpenBot-*`, `OpenBot-Signature`, `openbot://` scheme | Wire and webhook contracts. |
| `openbot.db`, `~/OpenBot/…` folders, `OpenBot/Shared`, "OpenBot Shared", "the OpenBot folder" text | Paths on disk. The text names a real folder. |
| `app.setName("OpenBot")`, `productName`, `app.openbot.desktop`, mobile bundle ids, `app.json` name | Electron uses the name for the user data folder; native builds. macOS shows "OpenBot" in the app menu and in Privacy settings (`ComputerUsePermissionHelp`). |
| "Shared with OpenBot" 1Password vault and Bitwarden folder (also Italian "Condiviso con OpenBot") | The code creates and finds this exact name. |
| `@OpenBot` handle, "Reply to OpenBot", Slack, Discord and Telegram orchestrator text, "Post … as OpenBot" | The name of the bot user in Slack, Discord and Telegram. Change the app names there first. |
| "OpenBot GitHub App", "The OpenBot Slack/Discord app is not configured", "GitHub records the OpenBot app" | Names of registered external apps. |
| "OpenBot Mobile", mobile About wordmark, Live Activity title | The native iPhone app is still named OpenBot. |
| ACP `clientInfo` titles, `OpenBot Remote Desktop` Moonlight pairing name, "OpenBot on {host}" 1Password service account | Names sent to other programs and kept by them. |
| `RESTART_INTERRUPTION_REASON` ("OpenBot restarted before this delivery…") | Stored in the database; the host searches for it. |
| "OpenBot user" marketplace author fallback | A Worker test asserts it; low value. |
| Agent import prompt "Export my agents for OpenBot", "OpenBot export" agent | Names of the external export skill and agent. |
| Analytics event names, log lines, database error and migration messages | Not interface text; logs and tests compare them. |
| Marketing site (`apps/auth-api/src/content`, landing, compare, guides, news, changelog pages, `llms.txt`), `apps/site-router` pages for `openbot.site` | The public OpenBot site, not the Atelier front door. |
| Domains `openbot.run`, `openbot.site`, `licenses@openbot.run` | URLs. |
| LICENSE, NOTICE (Required Notice lines), CLA, copyright, legal pages, `CHANGELOG.md` and What's New history | Legal text and history. |

## Notes for the next phases

- A host and a client of different versions show the English error text of the host, not a
  translation, for the errors whose English changed. Deploy host and web together.
- Comments and identifiers such as `OpenBotDesktopApi` still say OpenBot.
