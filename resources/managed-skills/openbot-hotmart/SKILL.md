---
name: openbot-hotmart
description: Read the user's Hotmart sales, refunds, chargebacks, commissions, subscriptions, products and coupons through the Hotmart Developers API with the hotmart helper, send approved Hotmart purchases to Meta as Conversions API events, refund sales and cancel subscriptions with the person's approval, and set up Hotmart event checks. Use when the user asks about Hotmart sales, revenue, refunds, chargebacks, subscribers or churn.
---

# Hotmart

You read and manage the user's Hotmart account with `hotmart.mjs`, a helper that ships with OpenBot. It calls
the Hotmart Developers API (`https://developers.hotmart.com`, version `v1` endpoints) and prints JSON. Hotmart's
own numbers are the truth for sales and refunds.

## The helper

On the OpenBot server the helper is `/opt/OpenBot/app/resources/managed-skills/openbot-hotmart/hotmart.mjs`.
Start each command with these lines. The loop also finds the helper in the desktop app.
The three `<path>` values are the paths of the shared keys `HOTMART_CLIENT_ID`, `HOTMART_CLIENT_SECRET` and
`HOTMART_BASIC` from `openbot.list_api_keys`. If a value is saved under another name, such as
`HOTMART_CLIENT_TOKEN` for the Basic value, use that key's path:

```bash
for H in /opt/OpenBot/app/resources /Applications/OpenBot.app/Contents/Resources /opt/OpenBot/resources; do
  H="$H/managed-skills/openbot-hotmart/hotmart.mjs"; [ -f "$H" ] && break; done
[ -f "$H" ] || H=$(find / -maxdepth 8 -path '*/managed-skills/openbot-hotmart/hotmart.mjs' 2>/dev/null | head -n 1)
export HOTMART_CLIENT_ID_FILE='<path>' HOTMART_CLIENT_SECRET_FILE='<path>' HOTMART_BASIC_FILE='<path>'
export HOTMART_ACTOR='<your name>'
node "$H" help
```

In the examples below `hotmart` means `node "$H"`. The helper reads the credentials from the files and never
prints them. Do not print, copy or pass them in any other way. It signs in with OAuth client credentials and
keeps the access token (valid about 48 hours) in `.token-cache.json` (mode 600) next to the settings, so most
commands need no new sign-in. A new credential never reuses the cache. `--no-token-cache` turns the cache off.

The settings and the audit log are in `hotmart/` in the shared directory of your space (on the
server `/data/OpenBot/Spaces/<space>/Shared/hotmart/`). `hotmart config show` shows the folder. Every
agent of your space uses the same files; another space has its own.

Exit codes: 0 done, 1 error (JSON on standard error, with Hotmart's `error`, `message` and a `hint`), 2 wrong
command, 3 refused (the change needs `--approved`), 4 rate limited for longer than `--max-wait` seconds (default 120).

## One-time setup

Do these steps with the user once. The user does the steps in Hotmart; you do the OpenBot steps.

1. **Credential.** In Hotmart, open **Tools → Developer Credentials** (`https://app-vlc.hotmart.com/tools/credentials`)
   and choose **Create Credential**. Give it a name. Leave **Sandbox** off for the real account. Hotmart shows
   three values: **Client ID**, **Client Secret** and **Basic**. The credential must be created by the account
   that owns the products (the producer).
2. **Save the three values.** Call `openbot.request_api_key` three times, with `shared: true` so every agent can
   use them: `name: "HOTMART_CLIENT_ID"`, `name: "HOTMART_CLIENT_SECRET"` and `name: "HOTMART_BASIC"`. The Basic
   value can keep or drop the word `Basic`. Never ask for the values in chat. If the user pastes one in chat,
   do not repeat it, and ask again with `request_api_key`. Only the server owner or an admin can answer the form,
   and not in a Slack, Discord or Telegram chat.
3. **Check.** `hotmart whoami` shows the Hotmart user and the commission currency. Then `hotmart products`.
4. **Time zone.** `hotmart config set timezone America/Sao_Paulo` (use the user's time zone, or the `time_zone`
   from `whoami`). Calendar periods such as `--preset today` use it.
5. **Sandbox (optional).** For tests, the user makes a second credential with **Sandbox** on. Use `--sandbox` on a
   command, or `hotmart config set sandbox true`. Sandbox data is not real, and a sandbox credential does not work
   on the real account (or the reverse).
6. **Rules.** Ask the person what to do on a refund, a chargeback and a cancellation, and whether to send purchases
   to Meta. Save the answers in your memory and in `hotmart/rules.md` in the shared folder.

## Reading

- `hotmart sales --days 7` lists the sales and gives `totals`: the count and value for each status and currency,
  `paid_by_currency` (APPROVED and COMPLETE) and `refunded_by_currency` (REFUNDED, PARTIALLY_REFUNDED and
  CHARGEBACK). The value is what the buyer paid. Filters: `--status APPROVED,REFUNDED` (or the groups `paid`,
  `refunds`, `all`; the default is `paid`), `--product <id>`, `--buyer-email <email>`, `--transaction <code>`,
  `--offer <code>`, `--payment-type PIX`, `--src <code>`. Periods: `--days N`, `--preset today|yesterday|last_7d|last_30d|this_month|last_month`,
  or `--since 2026-11-01 --until 2026-11-14`. The dates filter by order date.
- `hotmart sale <transaction>`: one sale in any status, with its price details (base, VAT, fees, coupon), the
  commissions of each participant and the participants (buyer, producer, affiliates). `--full` adds documents
  and the full address.
- `hotmart summary --preset this_month [--status APPROVED]`: the commission totals of the credential's user
  per currency, as Hotmart reports them (your earnings, not what the buyer paid).
- `hotmart commissions`, `hotmart price-details`, `hotmart participants` take the same filters and periods.
- `hotmart subscriptions --status ACTIVE,DELAYED [--product <id>] [--subscriber <code>] [--email <email>]`
  lists every subscription (not only the last 30 days) with `by_status` counts and
  `active_monthly_value_by_currency` (the active prices brought to 30 days). `--cancelled-since 2026-11-01`
  lists the cancellations from that date. `hotmart subscription-summary` (Hotmart updates it up to 24 hours late),
  `hotmart subscription-purchases <subscriber code>`.
- `hotmart products [--status ACTIVE]`, `hotmart coupons <product id>`, `hotmart audit --tail 20`.

Sale statuses: APPROVED (paid), COMPLETE (paid and the guarantee period is over), REFUNDED, PARTIALLY_REFUNDED,
CHARGEBACK, PROTESTED (the buyer opened a complaint or refund request), CANCELLED (the payment was refused or
cancelled), WAITING_PAYMENT, PRINTED_BILLET, UNDER_ANALISYS, BLOCKED, EXPIRED, OVERDUE, NO_FUNDS, STARTED,
PRE_ORDER, PROCESSING_TRANSACTION. Hotmart answers only APPROVED and COMPLETE when no status is given, so the
helper asks for each status separately. Sales of the last hours can still change status.

Buyer data (email, phone, address, documents) is personal data. Use it for the task; do not paste it into
public channels.

## Changing

Every change needs `--approved` (exit code 3 without it), and goes to `audit.jsonl` with the actor and `--reason`.
`--dry-run` shows the request and sends nothing.

- `hotmart refund <transaction>`: refunds an APPROVED or COMPLETE sale. The buyer gets the money back and loses
  access. It cannot be undone. Hotmart refuses trial, SEPA and BACS purchases and sales past the refund period.
- `hotmart cancel-subscription <subscriber code>... [--send-mail]`: stops the charges and the access.
- `hotmart reactivate-subscription <subscriber code>... [--charge]`: Hotmart emails the subscriber a link (valid
  3 days) to accept; with `--charge` it charges them again.
- `hotmart create-coupon <product id> --code BLACK10 --discount 10 [--start 2026-11-20 --end 2026-11-30] [--offer-ids a,b]`
  and `hotmart delete-coupon <coupon id>`.

Before you add `--approved`, get the person's approval with `openbot.request_decision` (the sale or subscriber,
the product, the value in `amount`, and the reason). Atelier's trust policy also checks refunds, coupons and
cancellations at the tool layer. In a hands-off channel, where nobody answers, decide yourself
only within the person's saved rules and call `openbot.log_decision` once for each change. Never refund or cancel
without one of these. Do not edit `audit.jsonl`.

## Recipes

### Daily sales summary

Make it a routine when the user asks, for example every day at 09:00 in their time zone:

1. `hotmart sales --preset yesterday --status all`.
2. Post a short message in the channel: the paid sales (count and value per currency), refunds and chargebacks
   (count and value), and the top products. For a week, use `--preset last_7d` and compare with the week before
   (`--since`/`--until`). Use a few lines, not a table of every sale.
3. If Meta ads run, add the Meta spend of the same day (`meta-ads insights --level account --preset yesterday`)
   and the revenue per spend from Hotmart's paid value.

### Refund or chargeback follow-up

When a sale becomes REFUNDED, PARTIALLY_REFUNDED, CHARGEBACK or PROTESTED (the `hotmart-sales` event check wakes you):

1. `hotmart sale <transaction>` for the product, the value, the payment type and the buyer.
2. Tell the person in one or two sentences. A chargeback takes the money of the sale back through the card company;
   PROTESTED means the buyer complained, and a quick answer can stop a refund. Follow the person's rules; if they keep a list of
   refunds, add the line there.
3. If the sale was sent to Meta as a Purchase, do not delete it; Meta has no undo. Tell the person when many
   refunds come from one campaign.
4. Refund a sale (`hotmart refund`) only with the person's approval.

### Send approved Hotmart purchases to Meta

Use this when the person wants Meta to count Hotmart sales as confirmed purchases. First ask whether the Hotmart
product already sends Purchase events to the same pixel through Hotmart's own tracking pixel settings. If it does,
do not send them too: Meta would count each sale twice, because the two senders use different event IDs. You need the Meta pixel
(dataset) ID and the openbot-meta-ads skill (`meta-ads` means its helper).

For each APPROVED sale (the `hotmart-sales` event check wakes you with `transaction:APPROVED`):

```bash
F="$(mktemp)"
hotmart capi-event <transaction> --out "$F"
meta-ads capi-send --pixel <pixel id> --data @"$F" --reason "Hotmart purchase <transaction>"
rm -f "$F"
```

`capi-event` builds the event from Hotmart's data: `event_name` Purchase, `event_id` the transaction code (Meta
drops a second event with the same ID and name, so a repeat is safe), `event_time` the approval time,
`action_source` website, `custom_data` with the `value` and `currency` that the buyer paid, `order_id` and the
product, and `user_data` with the buyer's email, phone, name, country and Hotmart buyer ID. `meta-ads capi-send`
normalizes and hashes every customer value with SHA-256 before it leaves, as Meta requires. The same event with
flags, when you have only the sale row:

```bash
meta-ads capi-send --pixel <pixel id> --event Purchase --event-id <transaction> --event-time <approved time in seconds> \
  --value <value> --currency <currency> --email '<buyer email>' --action-source website --reason "Hotmart purchase <transaction>"
```

Rules: send only APPROVED or COMPLETE sales (`capi-event` refuses others); Meta refuses website events older than
7 days (`capi-event` warns); test first with `--test-code <code from Events Manager>` on `capi-send`; do not send
refunds as negative purchases.

## Event checks

Two event check templates watch Hotmart without AI between events. Use the openbot-event-checks skill to install
them with `openbot.install_event_check_template`:

- `hotmart-sales`: each sale once per status (item ID `transaction:status`), every 3 minutes, for the sales of the
  last `lookbackDays` (30). Settings: `statuses` (default APPROVED, COMPLETE, REFUNDED, PARTIALLY_REFUNDED,
  CHARGEBACK, CANCELLED, PROTESTED), `productIds`, `lookbackDays`, `sandbox`.
- `hotmart-subscriptions`: cancellations of the last `lookbackDays` (7) and late payments (DELAYED, OVERDUE), every
  5 minutes. Settings: `statuses`, `productIds`, `lookbackDays`, `sandbox`.

Each check has its own private variables `HOTMART_CLIENT_ID`, `HOTMART_CLIENT_SECRET` and `HOTMART_BASIC`. When the
values are already in Secrets (`openbot.list_api_keys`), link each variable with `openbot.link_event_check_secret`.
The Secrets key name may differ: for example, link `variable: "HOTMART_BASIC"` to `secret: "HOTMART_CLIENT_TOKEN"`.
Ask the user when you cannot tell which key holds which value. Otherwise the user pastes the values or picks saved
secrets in agent settings → Event checks → the check → Private variables (.env). OpenBot hides email addresses in event messages; read the buyer with
`hotmart sale <transaction>`. Test with `openbot.test_event_check`, and enable only when the user asks.

## Errors and limits

- 401 (`invalid_token`, `token_expired`): the helper gets a new token and tries once more. If it still fails, the
  credentials are wrong, deleted, or for the other environment (sandbox or production). Ask for new ones with
  `request_api_key`.
- 403 `unauthorized_client`: the credential may not read this; it must belong to the producer account.
- 400 `invalid_parameter` or `invalid_value_parameter`: fix the filter (status names, IDs, dates) and run again.
- 429: Hotmart allows 500 calls a minute. The helper waits and tries again; exit code 4 means wait a minute.
- 502: the query ran longer than 30 seconds at Hotmart. Use a shorter period or `--product`.

## Talking to the user

Give money per currency with the period: "Yesterday: 14 sales, 1,862.00 BRL; 1 refund of 97.00 BRL." Say what you
changed and why, and what needs the user's decision. Do not paste raw JSON or buyer data into public channels.
