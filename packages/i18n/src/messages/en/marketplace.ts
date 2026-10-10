import { defineMessages } from "../../message";

export const messages = defineMessages("marketplace", {
  "marketplace.app.addAccount": "Add account",
  // The listing: categories, rows, and the words for each kind of listing.
  "marketplace.category.coding": "Coding",
  "marketplace.category.design": "Design",
  "marketplace.category.dataAnalytics": "Data & Analytics",
  "marketplace.category.documents": "Documents",
  "marketplace.category.productivity": "Productivity",
  "marketplace.category.research": "Research",
  "marketplace.category.automation": "Automation",
  "marketplace.category.other": "Other",
  "marketplace.loadFailed": "Could not load the marketplace.",
  "marketplace.loading.skills": "Loading skills",
  "marketplace.loading.agents": "Loading agents",
  "marketplace.noMatch.skills": "No skills match this search.",
  "marketplace.noMatch.agents": "No agents match this search.",
  "marketplace.loadMore": "Load more",
  "marketplace.version": "Version {version}",

  // The dialog frame: title, close and tabs.
  "marketplace.title": "Marketplace",
  "marketplace.close": "Close marketplace",
  "marketplace.kinds": "Marketplace content types",
  "marketplace.tab.agents": "Agents",
  "marketplace.tab.skills": "Skills",

  // A plugin link.
  "marketplace.plugins.missing": "This plugin is not in the OpenBot catalog.",

  // The agent page.
  "marketplace.agents.loadingDetail": "Loading agent details…",
  "marketplace.agents.skills": "Skills",
  "marketplace.agents.routines": "Routines",
  "marketplace.agents.routineActive": "Active",
  "marketplace.agents.routineInactive": "Inactive",

  // The skill page, and why Try is off.
  "marketplace.skill.loading": "Loading skill",
  "marketplace.skill.update": "Update skill",
  "marketplace.skill.updateAvailable": "Update available",
  "marketplace.skill.remove.titleMany": "Remove {name} from {agents}?",
  "marketplace.skill.remove.many": "OpenBot removes {name} from each of these agents. Chat history stays.",
  "marketplace.skill.remove.modifiedMany":
    "Some of these agents have local changes in the skill's files. Removing deletes those files. Chat history stays.",
  "marketplace.skill.updates.label": "Skill updates",
  "marketplace.skill.updates.count": {
    one: "{count} installed skill has an update.",
    other: "{count} installed skills have updates.",
  },
  "marketplace.skill.updates.all": "Update all",
  "marketplace.try.readFailed": "OpenBot could not read this agent's skills. Try again.",
  "marketplace.try.enable": "Enable this skill in agent settings to try it.",
  "marketplace.try.repair": "Repair this skill in agent settings to try it.",
  "marketplace.try.update": "Update this skill to try this version.",
  "marketplace.try.composerUnavailable": "The agent composer is unavailable.",

  // The Marketplace window. {name} is an agent, app or skill name. {count} is a number.
  "marketplace.open": "Open {name}",
  "marketplace.tab.apps": "Apps",
  "marketplace.crumbs.label": "Location",
  "marketplace.search.label": "Search the marketplace",
  "marketplace.search.placeholder": "Search",
  "marketplace.installs": { one: "{installs} install", other: "{installs} installs" },
  "marketplace.filter": "Filter",
  "marketplace.filter.on": "Filter: {filters}",
  "marketplace.filter.all": "All",
  "marketplace.filter.status": "Status",
  "marketplace.filter.category": "Category",
  "marketplace.filter.added": "Added",
  "marketplace.filter.notAdded": "Not added",
  "marketplace.filter.installed": "Installed",
  "marketplace.filter.notInstalled": "Not installed",
  "marketplace.filter.updates": "Updates available",
  "marketplace.filter.clear": "Clear filters",
  "marketplace.noMatch.apps": "No apps match this search.",
  "marketplace.noMatch.filters": "Nothing matches the filters.",
  "marketplace.noMatch.showAgents": { one: "Show {count} agent", other: "Show {count} agents" },
  "marketplace.noMatch.showApps": { one: "Show {count} app", other: "Show {count} apps" },
  "marketplace.noMatch.showSkills": { one: "Show {count} skill", other: "Show {count} skills" },
  "marketplace.empty.agents": "No agents are in the marketplace yet.",
  "marketplace.empty.apps": "No apps are in the marketplace yet.",
  "marketplace.empty.skills": "No skills are in the marketplace yet.",
  "marketplace.properties.agent": "About this agent",
  "marketplace.properties.skill": "About this skill",
  "marketplace.properties.creator": "Creator",
  "marketplace.properties.category": "Category",
  "marketplace.properties.version": "Version",
  "marketplace.properties.updated": "Updated",
  "marketplace.properties.installs": "Installs",

  // Agents.
  "marketplace.agent.add": "Add",
  "marketplace.agent.addNamed": "Add {name}",
  "marketplace.agent.addAgent": "Add agent",
  "marketplace.agent.added": "Added",
  "marketplace.agent.updateAvailable": "Update available",
  "marketplace.agent.update": "Update",
  "marketplace.agent.openChat": "Open chat",

  // Apps.
  "marketplace.app.connect": "Connect",
  "marketplace.app.reconnect": "Reconnect",
  "marketplace.app.disabled": "Disabled",
  "marketplace.app.review": "Review",
  "marketplace.app.reviewNamed": "Review {name}",
  "marketplace.app.accounts": { one: "{count} account", other: "{count} accounts" },
  "marketplace.app.connectNamed": "Connect {name}",
  "marketplace.app.checking": "Checking…",
  "marketplace.app.reviewAccounts": "Review accounts",
  "marketplace.app.readFailed": "Could not read apps on {host}.",
  "marketplace.app.adminOnly": "Only an owner or admin of {server} can connect apps.",
  "marketplace.app.adminOnlyThisServer": "Only an owner or admin of this server can connect apps.",
  "marketplace.app.reconnectNamed": "Reconnect {name}",
  "marketplace.app.connected": "Connected",
  "marketplace.app.attention": "Needs attention",
  "marketplace.app.notConnected": "Not connected",
  "marketplace.app.connecting": "Connecting…",
  "marketplace.app.custom": "MCP server",
  "marketplace.app.githubTagline": "Repositories, issues and pull requests",
  "marketplace.app.onePasswordTagline": "Sign in to sites with logins you share",
  // The category row in the 1Password page's information.
  "marketplace.app.onePasswordCategory": "Login and Credential Management",
  "marketplace.app.yourApps": "Your apps",
  "marketplace.app.moreApps": "More apps",
  "marketplace.app.server": "Server",
  "marketplace.app.command": "Command",
  "marketplace.app.address": "Address",
  "marketplace.app.disconnect.title": "Disconnect",
  "marketplace.app.disconnect.description":
    "Remove {name} and its skills from this computer. You can connect it again later.",
  "marketplace.app.disconnect.descriptionOnHost":
    "Remove {name} and its skills from {host}. You can connect it again later.",
  "marketplace.app.disconnect.action": "Disconnect",
  "marketplace.app.remove.title": "Remove server",
  "marketplace.app.remove.description": "Your agents can no longer use this server. Its settings are deleted.",
  "marketplace.app.remove.action": "Remove",
  "marketplace.app.remove.confirmTitle": "Remove {name}?",
  "marketplace.app.remove.keep": "Keep",

  // The catalog apps' listing text, by slug. Each English text is the catalog's own text, byte for
  // byte: a key whose English no longer matches the catalog is not used. The prompts are requests that
  // the user sends to an agent.
  "marketplace.plugin.aave.tagline": "Aave data and transactions",
  "marketplace.plugin.aave.description":
    "Aave helps users explore live Aave V3 and V4 markets, review wallet positions and DAO governance, simulate lending actions, and prepare non-custodial transactions. Every transaction is returned unsigned: the plugin reads the markets and writes the call, and the wallet stays with the user.",
  "marketplace.plugin.aave.app":
    "Live V3 and V4 markets, wallet positions, DAO governance, and prepared transactions, over one MCP server.",
  "marketplace.plugin.aave.prompt.stablecoinYield": "Where can I earn the most on stablecoins across Aave right now?",
  "marketplace.plugin.aave.prompt.usdcRates": "Which pays more for USDC right now, Aave V3 or V4 on Ethereum?",
  "marketplace.plugin.aave.prompt.healthFactor":
    "What's the health factor of 0x0a42b2f3a0d54157dbd7cc346335a4f1909fc02c, and how far from liquidation?",
  "marketplace.plugin.canva.tagline": "Designs, assets and exports",
  "marketplace.plugin.canva.description":
    "Canva lets users create and edit designs in words, search their own design library, upload and organize assets, export in the format a channel needs, and leave comments where the work is. Each user signs in to their own Canva account, and the agent can do what that account can do.",
  "marketplace.plugin.canva.app":
    "Design creation and editing, library search, asset and brand management, exports, and comments, over one MCP server.",
  "marketplace.plugin.canva.prompt.recentDesign": "Show me my most recently edited Canva design.",
  "marketplace.plugin.canva.prompt.socialResize": "Resize my launch poster for Instagram and export both as PNG.",
  "marketplace.plugin.canva.prompt.deckFromNotes": "Turn these release notes into a six-slide Canva presentation.",
  "marketplace.plugin.linear.tagline": "Issues and project triage",
  "marketplace.plugin.linear.description":
    "Linear lets agents list assigned issues, triage the backlog, update statuses, and draft new issues in the workspace the signed-in account belongs to. Each user signs in to their own Linear account through the browser.",
  "marketplace.plugin.linear.app":
    "Issue search, triage, status updates, and issue creation, over Linear's MCP server with browser sign-in.",
  "marketplace.plugin.linear.prompt.myWeek": "What is assigned to me this week?",
  "marketplace.plugin.linear.prompt.backlog": "Triage the backlog: what is stale, blocked, or missing an owner?",
  "marketplace.plugin.linear.prompt.newIssue": "File an issue for the crash in the sync queue with reproduction steps.",
  "marketplace.plugin.notion.tagline": "Docs and knowledge base",
  "marketplace.plugin.notion.description":
    "Notion lets agents read and write pages, search the workspace, and keep meeting notes and specs where the team already works. Each user signs in to their own Notion account through the browser.",
  "marketplace.plugin.notion.app":
    "Page search, reading, writing, and workspace navigation, over Notion's MCP server with browser sign-in.",
  "marketplace.plugin.notion.prompt.findSpec": "Find the current launch spec and summarize the open questions.",
  "marketplace.plugin.notion.prompt.meetingNotes":
    "Turn these bullets into a structured meeting note in my team space.",
  "marketplace.plugin.notion.prompt.updateDoc": "Update the onboarding doc with the new release checklist.",
  "marketplace.plugin.figma.tagline": "Designs and prototypes",
  "marketplace.plugin.figma.description":
    "Figma lets agents read design files, inspect components, styles and variables, and hand production specs to engineers. It connects to the MCP server in the Figma desktop app, on this computer. The server can read designs only; write support is in progress.",
  "marketplace.plugin.figma.app":
    "Design context, metadata, variables and screenshots, over the MCP server in the Figma desktop app. Read-only for now.",
  "marketplace.plugin.figma.prompt.handoff": "Hand off the checkout file: list screens, components, and styles.",
  "marketplace.plugin.figma.prompt.audit": "Audit this file for inconsistent spacing and color use.",
  "marketplace.plugin.figma.prompt.assets": "Extract the marketing icons at 2x for the app bundle.",
  "marketplace.plugin.paper.tagline": "Design canvas built on HTML and CSS",
  "marketplace.plugin.paper.description":
    "Paper lets agents read and write the design file that is open in Paper Desktop: inspect artboards, selections, computed styles, JSX and tokens, and create or change frames, text and styles. Install Paper Desktop, open it once, and open a file before you start. OpenBot starts the Paper CLI that Paper Desktop installs. Paper needs no key. Write tools change the open file, so review each write before you approve it.",
  "marketplace.plugin.paper.app":
    "Reads and writes the open Paper Desktop file, over the local MCP server that the Paper CLI relays. Needs Paper Desktop with a file open.",
  "marketplace.plugin.paper.prompt.implement":
    "Implement the selected Paper frame in this codebase, with our code conventions.",
  "marketplace.plugin.paper.prompt.codeToDesign":
    "Use the styles in this repository and design a settings page in Paper.",
  "marketplace.plugin.paper.prompt.tokens":
    "List the design tokens in the open Paper file and compare them with our theme.",
  "marketplace.plugin.sentry.tagline": "Errors and crash triage",
  "marketplace.plugin.sentry.description":
    "Sentry lets agents search recent errors, inspect stack traces and affected releases, and summarize what broke after a deploy. Each user signs in to their own Sentry account through the browser.",
  "marketplace.plugin.sentry.app":
    "Error search, issue inspection, and release health, over Sentry's MCP server with browser sign-in.",
  "marketplace.plugin.sentry.prompt.newErrors": "What new errors appeared since yesterday's deploy?",
  "marketplace.plugin.sentry.prompt.topCrash": "Explain the top crash in the mobile project and its likely cause.",
  "marketplace.plugin.sentry.prompt.releaseHealth": "How healthy is the current release compared to the last one?",
  "marketplace.plugin.context7.tagline": "Current library documentation",
  "marketplace.plugin.context7.description":
    "Context7 fetches current documentation and API references for libraries and frameworks, so answers use the version the project actually runs. It needs no account and no key.",
  "marketplace.plugin.context7.app":
    "Current library documentation lookup, over the Context7 MCP server with no sign-in.",
  "marketplace.plugin.context7.prompt.apiCheck": "What is the current API for virtualized lists in this framework?",
  "marketplace.plugin.context7.prompt.migrate": "What changed between v2 and v3 of this router?",
  "marketplace.plugin.context7.prompt.example": "Show a current example for authenticated file uploads.",
  "marketplace.plugin.stripe.tagline": "Payments and billing review",
  "marketplace.plugin.stripe.description":
    "Stripe lets agents look up payments, customers, and invoices, and draft payment links, in the account the signed-in user can reach. Each user signs in to their own Stripe account through the browser.",
  "marketplace.plugin.stripe.app":
    "Payment, customer, and invoice lookup, over Stripe's MCP server with browser sign-in.",
  "marketplace.plugin.stripe.prompt.payment": "Look up this payment and explain why it failed.",
  "marketplace.plugin.stripe.prompt.customer": "Summarize this customer's invoices and outstanding balance.",
  "marketplace.plugin.stripe.prompt.link": "Draft a payment link for the Pro plan at 49 per month.",
  "marketplace.plugin.posthog.tagline": "Product analytics and flags",
  "marketplace.plugin.posthog.description":
    "PostHog lets agents query events and funnels, inspect feature flags, and summarize what changed after a release. A personal API key from the project settings goes into one Authorization header.",
  "marketplace.plugin.posthog.app":
    "Event, funnel, and feature-flag access, over PostHog's MCP server with a personal API key.",
  "marketplace.plugin.posthog.prompt.funnel": "How does the signup funnel look for the last 14 days?",
  "marketplace.plugin.posthog.prompt.flag": "Which feature flags are enabled for this user?",
  "marketplace.plugin.posthog.prompt.release": "Did activation change after last week's release?",
  "marketplace.plugin.airtable.tagline": "Bases and records",
  "marketplace.plugin.airtable.description":
    "Airtable lets agents list bases, read and update records, and summarize table contents. An API key from the account page is passed to the local server as one environment variable.",
  "marketplace.plugin.airtable.app":
    "Base listing and record access, over a local MCP server with an Airtable API key.",
  "marketplace.plugin.airtable.prompt.bases": "What bases do I have access to?",
  "marketplace.plugin.airtable.prompt.records": "Summarize the launch tracker table.",
  "marketplace.plugin.airtable.prompt.update": "Mark the shipped features as done in the roadmap base.",
  "marketplace.plugin.firecrawl.tagline": "Web extraction and search",
  "marketplace.plugin.firecrawl.description":
    "Firecrawl lets agents scrape pages, extract structured data, and search the web through one API. An API key from the Firecrawl dashboard is passed to the local server as one environment variable.",
  "marketplace.plugin.firecrawl.app":
    "Page scraping, extraction, and web search, over a local MCP server with a Firecrawl API key.",
  "marketplace.plugin.firecrawl.prompt.scrape": "Extract the pricing table from this page as structured data.",
  "marketplace.plugin.firecrawl.prompt.research": "Research competitor pricing and cite each source page.",
  "marketplace.plugin.firecrawl.prompt.monitor": "What changed on our changelog page this month?",
  "marketplace.plugin.braveSearch.tagline": "Private web search",
  "marketplace.plugin.braveSearch.description":
    "Brave Search lets agents search the web and local results without tracking. An API key from the Brave Search API dashboard is passed to the local server as one environment variable.",
  "marketplace.plugin.braveSearch.app": "Web and local search, over a local MCP server with a Brave API key.",
  "marketplace.plugin.braveSearch.prompt.search": "What are reviewers saying about this framework version?",
  "marketplace.plugin.braveSearch.prompt.news": "Find today's announcements for this product area.",
  "marketplace.plugin.braveSearch.prompt.compare": "Compare these two vendors with cited sources.",
  "marketplace.plugin.resend.tagline": "Transactional email",
  "marketplace.plugin.resend.description":
    "Resend lets agents send transactional email and check delivery through one API. An API key from the Resend dashboard is passed to the local server as one environment variable.",
  "marketplace.plugin.resend.app": "Email sending and delivery checks, over a local MCP server with a Resend API key.",
  "marketplace.plugin.resend.prompt.send": "Send the launch announcement draft to the beta list.",
  "marketplace.plugin.resend.prompt.status": "Did the invoice email reach the customer?",
  "marketplace.plugin.resend.prompt.template": "Draft a password-reset email for the new flow.",
  "marketplace.plugin.composio.tagline": "Many apps through your own Composio link",
  "marketplace.plugin.composio.description":
    "Composio connects agents to Gmail, Slack, GitHub, and hundreds of other apps through one MCP server. Create the server in your Composio account, add the apps you want to it, and paste its link here. Add an API key only if your server requires one.",
  "marketplace.plugin.composio.app":
    "The apps you add to your Composio MCP server, over the link from your Composio account.",
  "marketplace.plugin.composio.prompt.inbox": "Summarize my unread email and draft replies to the urgent ones.",
  "marketplace.plugin.composio.prompt.handoff": "Post a summary of this pull request to our team channel.",
  "marketplace.plugin.composio.prompt.apps": "Which apps and actions can you use through Composio?",

  // Skills. {label} is the install button text: an agent name, "All agents" or "2 agents".
  "marketplace.skill.installMenu.install": "Install",
  "marketplace.skill.installMenu.installNamed": "Install {name}",
  "marketplace.skill.installMenu.allAgents": "All agents",
  "marketplace.skill.installMenu.agents": { one: "{count} agent", other: "{count} agents" },
  "marketplace.skill.installMenu.here": "You're here",
  "marketplace.skill.installMenu.change": {
    one: "{label} has {name}. Change",
    other: "{label} have {name}. Change",
  },
  "marketplace.skill.doc": "SKILL.md",
  "marketplace.try.in": "Try in {name}",

  // Results that a screen reader hears. {agents} is a list of agent names.
  "marketplace.notice.agentAdded": "{name} added.",
  "marketplace.notice.agentUpdated": "{name} updated.",
  "marketplace.notice.appConnected": "{name} connected.",
  "marketplace.notice.appDisconnected": "{name} disconnected.",
  "marketplace.notice.serverRemoved": "{name} removed.",
  "marketplace.notice.skillsUpdated": { one: "{count} skill updated.", other: "{count} skills updated." },
  "marketplace.notice.accountEnabled": "{name} turned on.",
  "marketplace.notice.accountDisabled": "{name} turned off.",
  "marketplace.notice.accountRenamed": "Renamed to {name}.",
  "marketplace.notice.accountChecked": {
    one: "{name} works. {count} tool is available.",
    other: "{name} works. {count} tools are available.",
  },
  "marketplace.notice.accountCheckFailed": "{name} does not work.",
  "marketplace.notice.accountReconnected": "{name} is connected again.",
  "marketplace.notice.appUpdated": {
    one: "{count} account of {name} updated.",
    other: "{count} accounts of {name} updated.",
  },
  "marketplace.notice.appUpdatedSignIn": {
    one: "{count} account of {name} updated. Sign in again if the app asks.",
    other: "{count} accounts of {name} updated. Sign in again if the app asks.",
  },
  "marketplace.notice.accessSet": "{account} for {agent}: {mode}.",
  "marketplace.notice.skillInstalled": {
    one: "{name} installed on {count} agent.",
    other: "{name} installed on {count} agents.",
  },
  "marketplace.notice.skillRemoved": {
    one: "{name} removed from {count} agent.",
    other: "{name} removed from {count} agents.",
  },
  "marketplace.error.skillPartial": "{name} did not change on these agents: {agents}. {reason}",

  // Event checks: reusable templates for polling an app with no AI.
  "marketplace.tab.eventChecks": "Event checks",
  "marketplace.loading.eventChecks": "Loading event checks",
  "marketplace.noMatch.eventChecks": "No event checks match this search.",
  "marketplace.noMatch.showEventChecks": { one: "Show {count} event check", other: "Show {count} event checks" },
  "marketplace.empty.eventChecks": "No event checks are in the marketplace yet.",
  "marketplace.properties.eventCheck": "About this event check",
  "marketplace.properties.worksWith": "Works with",
  "marketplace.properties.website": "Website",
  "marketplace.properties.interval": "Default interval",
  "marketplace.eventCheck.intro":
    "An event check reads an app on a schedule, with no AI, and wakes an agent only when something is new or changed.",
  "marketplace.eventCheck.worksWith": "Works with {app}",
  "marketplace.eventCheck.installed": "Installed",
  "marketplace.eventCheck.updateAvailable": "Update available",
  "marketplace.eventCheck.install": "Install",
  "marketplace.eventCheck.loading": "Loading event checks",
  "marketplace.eventCheck.loadFailed": "Could not load the event checks of this host.",
  "marketplace.eventCheck.missing": "This event check is not on this host.",
  "marketplace.eventCheck.intervalSeconds": {
    one: "{count} second",
    other: "{count} seconds",
  },
  "marketplace.eventCheck.need.title": "What you need",
  "marketplace.eventCheck.need.variables": "Private variables",
  "marketplace.eventCheck.need.variablesHelp":
    "You enter these after you install, in masked fields. They stay on the host and are never sent to a chat.",
  "marketplace.eventCheck.need.docs": "Setup guide",
  "marketplace.eventCheck.need.docsNamed": "Setup guide for {label}",
  "marketplace.eventCheck.need.settings": "Settings",
  "marketplace.eventCheck.need.settingsHelp": "You can change these when you install.",
  "marketplace.eventCheck.need.required": "Required",
  "marketplace.eventCheck.optional": "Optional",
  "marketplace.eventCheck.dialog.draftTitle": "To load your list",
  "marketplace.eventCheck.dialog.draftHelp":
    "These private values are used once to read your list. They are not saved here. You save them for the check in the next step.",
  "marketplace.eventCheck.need.nothing": "This event check needs no private variable and no setting.",
  "marketplace.eventCheck.need.interval": "Checks every {interval} by default.",
  "marketplace.eventCheck.forApp": "Event checks for this app",
  "marketplace.eventCheck.forAppHelp":
    "Reviewed checks that read the API of this app. They use their own private variables, never the accounts you connected here.",
  "marketplace.eventCheck.view": "View",
  "marketplace.eventCheck.installedTitle": "Installed",
  "marketplace.eventCheck.installedHelp": "Every copy of this event check, on every agent.",
  "marketplace.eventCheck.installedNone": "Not installed on any agent yet.",
  "marketplace.eventCheck.reading": "Reading the event checks of your agents",
  "marketplace.eventCheck.readFailed": "Could not read the event checks of {agents}.",
  "marketplace.eventCheck.instance": "{agent} · {account}",
  "marketplace.eventCheck.status.paused": "Paused",
  "marketplace.eventCheck.status.active": "Active",
  "marketplace.eventCheck.version": "Version {version}",
  "marketplace.eventCheck.update": "Update",
  "marketplace.eventCheck.updateNamed": "Update {name}",
  "marketplace.eventCheck.update.title": "Update {name}?",
  "marketplace.eventCheck.update.description":
    "This moves the check from version {from} to version {to}. Your settings, schedule and instruction stay. The check gets a fresh baseline: it saves what the app shows now and stays quiet until something changes.",
  "marketplace.eventCheck.update.confirm": "Update and reset baseline",
  "marketplace.eventCheck.updated": "{name} is on version {version}. It has a fresh baseline.",
  "marketplace.eventCheck.unlinked.title": "Event checks you made yourself",
  "marketplace.eventCheck.unlinked.help":
    "These checks have no template. If a check runs exactly the program of this template, you can link it. The baseline stays.",
  "marketplace.eventCheck.link": "Link to this template",
  "marketplace.eventCheck.linkNamed": "Link {name} to this template",
  "marketplace.eventCheck.linked": "{name} is linked to this template.",
  "marketplace.eventCheck.dialog.title": "Install {name}",
  "marketplace.eventCheck.dialog.description":
    "This creates a paused event check for each agent you choose. Nothing runs until you test the check and enable it.",
  "marketplace.eventCheck.dialog.agents": "Agents",
  "marketplace.eventCheck.dialog.noAgents": "You have no agent to install this event check on.",
  "marketplace.eventCheck.dialog.agentsRequired": "Choose at least one agent.",
  "marketplace.eventCheck.dialog.accountLabel": "Account label",
  "marketplace.eventCheck.dialog.accountLabelHelp":
    "Tells apart the accounts when you install this event check more than once.",
  "marketplace.eventCheck.dialog.fieldRequired": "This field is required.",
  "marketplace.eventCheck.dialog.intervalInvalid": "Enter at least 30 seconds.",
  "marketplace.eventCheck.dialog.actorIdsTooMany": "Enter no more than {max} IDs.",
  "marketplace.eventCheck.dialog.actorIds": "Your verified user IDs",
  "marketplace.eventCheck.dialog.actorIdsHelp":
    "Your own user IDs in the app, separated by commas or new lines. The check skips changes that these IDs made. You need at least one ID to enable the check. You can leave this empty while the check is paused.",
  "marketplace.eventCheck.dialog.submit": {
    one: "Install on {count} agent",
    other: "Install on {count} agents",
  },
  "marketplace.eventCheck.dialog.installing": "Installing…",
  "marketplace.eventCheck.dialog.done.title": "Add the private variables",
  "marketplace.eventCheck.dialog.done.paused":
    "The checks were created paused. Enter the private variables below. Then test each check and enable it in agent settings, Event checks.",
  "marketplace.eventCheck.dialog.done.noVariables":
    "The checks were created paused. This event check needs no private variable. Test each check and enable it in agent settings, Event checks.",
  "marketplace.eventCheck.dialog.done.check": "{agent} · {name}",
  "marketplace.eventCheck.dialog.failedTitle": "Could not install on some agents",
  "marketplace.eventCheck.dialog.failedFor": "{agent}: {reason}",
  "marketplace.eventCheck.dialog.retryFailed": "Try the failed agents again",
  "marketplace.eventCheck.dialog.finish": "Done",

  // Errors. {reason} is an error message. {failures} is a list of error messages.
  "marketplace.error.openLink": "Could not open the link.",
  "marketplace.error.accountNoServer": "This account cannot change app accounts on this server. Ask an owner or admin.",
  "marketplace.error.updateFailed": "{name} was not updated, because the new version did not work. {reason}",
  "marketplace.error.updateAllPartial": "Could not update {skills}.",
  "marketplace.error.accessGone": "{name} is not available to chats now. Close this window and try again.",
  "marketplace.error.copyLink": "Could not copy the link.",
  "marketplace.error.connectNoServer": "This account cannot connect apps on this server. Ask an owner or admin.",
  "marketplace.error.installNoServer": "This account cannot install plugins on this server. Ask an owner or admin.",
  "marketplace.error.installNoAgent": "Choose an agent to install this plugin's skills.",
  "marketplace.error.installLocalOnHost":
    "Install {name} on the computer that runs these agents: its app runs its server on that computer.",
  "marketplace.error.installOnHost":
    "Install {name} on the computer that runs these agents: its app needs a browser sign-in.",
  "marketplace.error.appInvalid": "{name} cannot be added: {reason}",
  "marketplace.error.uninstallNoServer": "This account cannot remove plugins on this server. Ask an owner or admin.",
  "marketplace.error.uninstallPartial": "Some of {name} could not be removed. {failures}",
  "marketplace.error.actionFailed": "Could not complete the marketplace action. Try again.",
  "marketplace.thisAgent": "this agent",

  // The accounts of an app. {name} is the name of an account.
  "marketplace.account.disabled": "Disabled",
  "marketplace.account.outdated": "Update available",
  "marketplace.account.rename": "Rename",
  "marketplace.account.renameNamed": "Rename {name}",
  "marketplace.account.check": "Check connection",
  "marketplace.account.checkNamed": "Check the connection of {name}",
  "marketplace.account.checking": "Checking…",
  "marketplace.account.working": {
    one: "Works. {count} tool is available.",
    other: "Works. {count} tools are available.",
  },
  "marketplace.account.failed": "Does not work. {reason}",
  "marketplace.account.removeDescription": "{name} is removed from {host}. The app and its other accounts stay.",
  "marketplace.account.removeChats": "Chats of {agents} can no longer use it.",
  "marketplace.account.removeChatsNone": "No chat can use it now.",
  "marketplace.account.removeChatsUnknown": "Chats can no longer use it.",
  "marketplace.account.removeSignIn": "The saved sign-in or key is deleted. Connect again to use the account.",
  "marketplace.account.signedOut": "Signed out. Sign in again to use this account.",
  "marketplace.account.signedOutTitle": "Sign in to {name} again",
  "marketplace.account.signedOutDescription":
    "This computer no longer holds the sign-in, so agents cannot use this account until you sign in again.",
  "marketplace.account.signIn": "Sign in again",
  "marketplace.account.signInNamed": "Sign in again to {name}",
  "marketplace.account.changeKey": "Change key",
  "marketplace.account.changeKeyNamed": "Change the key of {name}",
  "marketplace.account.updateTitle": "Update {name}",
  "marketplace.account.updateDescription": {
    one: "One account of {name} still uses an older version of its server. The update moves it to the current version. Its name, sign-in and chat access stay.",
    other:
      "{count} accounts of {name} still use an older version of its server. The update moves them to the current version. Their names, sign-ins and chat access stay.",
  },
  "marketplace.account.update": "Update",
  "marketplace.account.updateNamed": "Update the connection of {name}",

  // What each agent's chat may do with an account.
  "marketplace.access.title": "Chat access",
  "marketplace.access.description":
    "Choose what each agent's chat may do with each account. A new account starts Off in every chat.",
  "marketplace.access.thisChat": "This chat",
  "marketplace.access.loading": "Reading chat access",
  "marketplace.access.readFailed": "Could not read the chat access of {agents}.",
  "marketplace.access.saving": "Saving access for {agent}. The host refreshes its agents, so this can take a moment.",
  "marketplace.access.unreadable": "Not available",
  "marketplace.access.noAccounts": "Turn on an account to choose what chats may do with it.",
  "marketplace.access.disabledNote": "An account that is turned off is not offered to any chat.",
  "marketplace.access.groups": "Group chats are set in the chat itself, in Apps for this chat.",
  "marketplace.access.groupLabel": "{agent}, {account}",
  "marketplace.access.allowFor": "Allow for {agent}",
  "marketplace.access.allowDescription":
    "{account} is connected, but {agent} cannot use it yet. Choose what {agent} may do with it.",
  "marketplace.access.notNow": "Keep it off",
});
