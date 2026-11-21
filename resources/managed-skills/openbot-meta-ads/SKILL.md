---
name: openbot-meta-ads
description: Manage the user's Meta (Facebook and Instagram) ads through the Marketing API with the meta-ads helper - read results, find losers and winners, pause, change budgets and bids, create campaigns, ad sets, creatives and ads, upload media, audiences, lead form leads, Conversions API events, and set up Meta ads event checks. Use when the user asks about Meta, Facebook or Instagram ads, ad spend, ROAS, cost per purchase, or ad rejections.
---

# Meta ads

You manage the user's Meta ads with `meta-ads.mjs`, a helper that ships with OpenBot. It calls the Meta
Marketing API (Graph API `v27.0` by default) and prints JSON. The user trusts Meta's own numbers for
clicks, purchases and purchase value. Do not ask for store or analytics access to check them.

## The helper

On the OpenBot server the helper is `/opt/OpenBot/app/resources/managed-skills/openbot-meta-ads/meta-ads.mjs`.
Start each command with these lines. The loop also finds the helper in the desktop app.
`<path>` is the path of the shared key `META_ACCESS_TOKEN` from `openbot.list_api_keys`, or of the key that holds the
token under another name:

```bash
for M in /opt/OpenBot/app/resources /Applications/OpenBot.app/Contents/Resources /opt/OpenBot/resources; do
  M="$M/managed-skills/openbot-meta-ads/meta-ads.mjs"; [ -f "$M" ] && break; done
[ -f "$M" ] || M=$(find / -maxdepth 8 -path '*/managed-skills/openbot-meta-ads/meta-ads.mjs' 2>/dev/null | head -n 1)
export META_ACCESS_TOKEN_FILE='<path>' META_ADS_ACTOR='<your name>'
node "$M" help
```

In the examples below `meta-ads` means `node "$M"`. The helper reads the token from the file and never
prints it. Do not print, copy or pass the token in any other way.

The settings and the audit log are in `meta-ads/` in the shared directory of your space (on the
server `/data/OpenBot/Spaces/<space>/Shared/meta-ads/`). `meta-ads config show` shows the folder. Every
agent of your space uses the same files; another space has its own.

Exit codes: 0 done, 1 error (JSON on standard error, with Meta's message and a `hint`), 2 wrong command,
3 refused by the spend guard, 4 rate limited for longer than `--max-wait` seconds (default 120).

## One-time setup

Do these steps with the user once. The user does the steps in Meta; you do the OpenBot steps.

1. **Business Manager.** The ad account, the Facebook page and the pixel (dataset) must belong to the user's
   Meta Business Manager (business.facebook.com).
2. **Developer app.** At developers.facebook.com, create an app of type **Business**, connected to that
   Business Manager. Add the **Marketing API** product. For lead forms, also request `leads_retrieval`.
3. **System user.** In Business settings → Users → System users, add a system user (Admin role is simplest).
   Assign it the ad account (Manage campaigns), and also the page and the pixel when needed. Add the app to it.
4. **Token.** On the system user, choose **Generate new token**, select the app, and select the permissions
   `ads_management`, `ads_read` and `business_management`. For lead forms, add `leads_retrieval`,
   `pages_show_list`, `pages_read_engagement` and `pages_manage_ads`. Set the expiry to never.
5. **Save the token.** Call `openbot.request_api_key` with `name: "META_ACCESS_TOKEN"` and `shared: true`, so
   every agent can use it. Never ask for the token in chat. If the user pastes it in chat, do not repeat it
   and ask again with `request_api_key`. Only the server owner or an admin can answer the form, and not in a
   Slack, Discord or Telegram chat. If the app requires an app secret proof, save the app secret the
   same way as `META_APP_SECRET` and pass `--app-secret-file '<its path>'`.
6. **Check and configure.** `meta-ads whoami`, then `meta-ads accounts`. Ask the user which ad account to use
   if there is more than one. Then:
   `meta-ads config set adAccountId act_<id>` (and `pageId`, `pixelId` when needed). These IDs are not secret.
7. **Spend guard.** Ask the user for a daily budget cap for the whole account and set it with
   `meta-ads config set guard.dailyBudgetCap <amount>`. Save the person's rules for automatic actions
   (when to pause, what counts as a winner) in your memory and in `meta-ads/rules.md` in the shared folder.

## Reading

- `meta-ads account`: status, currency, time zone, amount spent.
- `meta-ads campaigns --status ACTIVE`, `meta-ads adsets --campaign <id>`, `meta-ads ads --adset <id>`,
  `meta-ads creatives`, `meta-ads get <id>`.
- `meta-ads insights --level campaign --preset last_7d`. Also `--level account|adset|ad`, `--preset today|yesterday|last_3d|last_14d|last_30d|this_month`,
  `--since 2026-11-01 --until 2026-11-14`, `--time-increment 1` (per day), `--breakdowns age,gender` or
  `publisher_platform,platform_position`, `--object <campaign id>`. Each row has `spend`, `impressions`,
  `clicks`, `ctr`, `cpc`, `actions`, and these computed fields: `purchases`, `purchase_value`,
  `cost_per_purchase`, `roas`, `leads`, `cost_per_lead`. `totals` sums the rows. If the user counts another
  action as a sale, add `--action-type <type>`.
- `meta-ads review`: the account status, campaigns and ad sets with issues, and rejected ads with Meta's
  review feedback.
- `meta-ads audiences`, `meta-ads lead-forms`, `meta-ads leads <form id> --hours 24`.
- `meta-ads audit --tail 20`: the last changes that agents made.

Money values that you give and that the helper shows as `*_amount` are in normal currency units (25.50).
Raw Meta fields such as `daily_budget` are in the smallest unit (2550 cents). `--params` uses raw units.

Meta reports purchases with a delay of up to a few hours, and results for the last 1 to 3 days still change.
Do not judge a campaign on today alone, and do not judge one that is still in its learning phase
(about the first 50 results or 7 days) unless it spends with no result at all.

## Changing

- New campaigns, ad sets and ads are always created **PAUSED**. `--activate` turns one on at creation, and
  needs `--approved`.
- `meta-ads pause <id>...` works on campaigns, ad sets and ads. It never needs approval.
- `meta-ads resume <id>... --approved`, `meta-ads set-budget <id> --daily 40`, `meta-ads set-bid <adset id> --bid 2.5`,
  `meta-ads update <id> --params '{"name":"New name"}'`.
- `meta-ads duplicate <id> [--deep] [--to-campaign <id>] [--suffix " - v2"]` copies, paused.
- `meta-ads upload-image <file>` answers the `hash` for a creative. `meta-ads upload-video <file>` or `--url`.
- `meta-ads create-campaign --name "..." --objective OUTCOME_SALES [--daily-budget 50]` (with a budget here, Meta
  shares it across the ad sets). Then `create-adset --campaign <id> --name "..." --optimization-goal OFFSITE_CONVERSIONS
  --promoted-object '{"pixel_id":"<pixel>","custom_event_type":"PURCHASE"}' --targeting '{"geo_locations":{"countries":["US"]}}'
  [--daily-budget 20]`, then `create-creative --name "..." --link <url> --image-hash <hash> --message "..." --headline "..." --cta SHOP_NOW`,
  then `create-ad --adset <id> --creative <id> --name "..."`. `--spec` and `--params` take the full Meta JSON
  (or `@file.json`) for anything else.
- `meta-ads create-audience --name "..."` (customer list), then `add-audience-users <id> --emails-file <file>`.
  The helper hashes the values before they leave. Website audiences use `--subtype WEBSITE --rule <JSON>`.
- `meta-ads capi-send --pixel <id> --event Purchase --value 49.90 --currency EUR --email <email> --event-id <order id>`
  sends a Conversions API event. Test first with `--test-code <code from Events Manager>`. Send real events only.
- Add `--dry-run` to see the request and the guard result, or `--validate` to have Meta check the change
  without saving it. Add `--reason "..."` to every change: it goes into the audit log.

### Spend guard and approval

The helper refuses a change that can raise spend (exit code 3) unless you add `--approved`:

- turning on a campaign, ad set or ad (`resume`, `--activate`, or `"status":"ACTIVE"`);
- a daily budget that rises more than 20% in 24 hours (`guard.maxDailyIncreasePercent`), or a lifetime budget
  that rises more than 20%;
- a bid that rises more than 20% (`guard.maxBidIncreasePercent`), or a change to the bid strategy or spend cap;
- a total active daily budget above `guard.dailyBudgetCap`.

Before you add `--approved`, get the person's approval with `openbot.request_decision` (the object, the old and new
value in the options, the amount, and the reason). Atelier's trust policy also checks every spend change at the tool
layer: over a budget, or when the policy asks, the command waits for the owner's approval card; a refusal comes back
as the tool error. Turning an ad on is sandboxed by default: send the ad preview link with `goLive: "ads"` first. In a hands-off channel, where nobody answers, decide yourself within
the person's saved rules and call `openbot.log_decision` once for each such change. Never add `--approved`
without one of these. A weaker guard (`config set guard.* ...`) also needs `--approved`, and only the person
can ask for it. Every change, refusal and error is written to `audit.jsonl`; do not edit that file.

## Routines

### Daily review (or weekly)

1. `meta-ads review`. Report rejected ads and account problems first.
2. `meta-ads insights --level campaign --preset last_3d` and `--preset last_7d`, then `--level adset` for the
   campaigns that need a closer look.
3. Apply the person's rules. Without other rules, use these defaults and say so:
   - **Loser:** spent more than 2 × the target cost per purchase with no purchase, or ROAS below half the target
     for 3 days, after at least the minimum spend. Pause it (no approval needed) and give the reason.
   - **Winner:** ROAS at least 1.3 × the target, or cost per purchase at most 0.75 × the target, for 3 days with
     at least 3 purchases. Flag it and propose a budget increase of at most 20%. Raising the budget needs approval.
4. Post a short summary in the channel: spend, purchases, cost per purchase and ROAS for the account, what you
   paused, the winners, and what needs a decision. Use a few lines, not a table of every ad.

Make it a routine when the user asks, for example daily at 09:00 in the account time zone.

### Budget pacing

Compare today's spend with the daily budgets (`meta-ads campaigns --status ACTIVE` shows `daily_budget_amount`).
Meta can spend up to 75% more than a daily budget on one day and balances it over the week. React only when
spend stays high for several days, or the account total passes the user's monthly plan. Lower budgets yourself
when spend is too high; higher budgets need approval. Change a budget at most once a day, by at most 20%:
large changes restart the learning phase, and Meta allows only 4 budget changes per ad set per hour.

### Creative rotation

Every week, look at `--level ad --preset last_7d`. An ad with a falling click-through rate and a frequency above
about 3 is tired. Make a new creative (new image or text), create the new ad paused in the same ad set, ask for
approval to turn it on, and pause the tired ad after the new one has delivered. Keep 3 to 6 active ads per ad set.

## Event checks

Three event check templates watch Meta without AI between events. Use the openbot-event-checks skill to install
them with `openbot.install_event_check_template`:

- `meta-ads-performance`: cost per purchase above a limit, ROAS below a limit, today's spend above a percent of
  the daily budget, click-through rate below a limit, no purchases in N hours. One breach wakes you once per day.
  Settings: `adAccountId`, `level`, `datePreset`, `maxCostPerPurchase`, `minRoas`, `maxSpendPercentOfBudget`, `minCtr`,
  `noPurchaseHours`, `minSpend`, `minImpressions`, `campaignIds`.
- `meta-ads-review`: an ad becomes DISAPPROVED, WITH_ISSUES or PENDING_BILLING_INFO, a campaign or ad set has
  issues, or the ad account is disabled or under review.
- `meta-lead-forms`: each new lead from the page's lead forms. Settings: `pageId`, `formIds`.

Each check has its own private variable `META_ACCESS_TOKEN`. When the token is already in Secrets
(`openbot.list_api_keys`), link it to each check with `openbot.link_event_check_secret`, with `variable:
"META_ACCESS_TOKEN"` and `secret` set to the key's name in Secrets (it may be named differently). Otherwise the user
pastes it or picks a saved secret in agent settings → Event checks → the check → Private variables (.env). Ask the
user for the limits; never guess them. Test with `openbot.test_event_check`, and enable only when the user asks.

## Errors and limits

- Code 190: the token is not valid. Ask for a new one with `request_api_key`.
- Codes 10, 200 to 299, 294: a permission or an asset assignment is missing. Tell the user which one.
- Code 100: a parameter is wrong. Read `message` and `userMessage`, fix the command and run it again.
- Rate limits (codes 4, 17, 32, 613, 80000 to 80014): the helper waits and tries again. If it still fails, wait
  the minutes that it gives. Do not loop. Prefer one insights call with a level over many calls per object.
- A new API version: when Meta retires the version, set a newer one with `meta-ads config set apiVersion v28.0`.

## Talking to the user

Give numbers in the account currency, with the period: "Last 7 days: spent 412 EUR, 23 purchases, 17.90 EUR per
purchase, ROAS 3.1." Say what you changed and why, and what needs the user's decision. Do not paste raw JSON.
