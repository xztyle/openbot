# Agent mailboxes per business (design, not built)

Goal: a customer-facing agent has its own address on the business's domain (for example
`ventas@aprendivo.com`). Mail to it becomes work in that agent's thread, and the agent answers as
that address. State on 2026-11-22, from a read-only check of the production server.

## What exists

- No mail server on the host or in a container, nothing listens on 25/465/587/993, and the firewall
  allows only SSH, nginx and TURN. Outbound 25 and 587 connect.
- The server's reverse DNS is OVH's generic name. Mail sent straight from it would land in spam.
- Both domains are on Cloudflare DNS. `delynith.com` already uses Cloudflare Email Routing (MX and
  SPF, no DMARC). `aprendivo.com` has no MX, SPF or DMARC; its web records point at Render.
- The host's Cloudflare login (wrangler OAuth) has the `email_routing:write` and
  `email_sending:write` scopes, but not `dns:write`.
- In the product: the "customer-inbox" Loop template has no mail feed behind it; the account
  service sends sign-in mail through upstream's SMTP account, which is not the owner's; the Discord
  and Slack apps are Worker-to-host connectors to copy.

## Proposed path (no new external account)

1. **Inbound.** Cloudflare Email Routing on the business domain sends `ventas@`, `soporte@` (or a
   catch-all) to an Email Worker, `apps/email-app`, built like `apps/discord-app`. The Worker parses
   the message (postal-mime), caps its size, and posts it to the host's webhook inbox
   (`/hooks/<route id>`, [connector gateway](../connector-gateway.md)) signed with Atelier's scheme.
   It rejects the message (a bounce) when the host does not take it, so a sender knows.
2. **Host.** A table binds an address to an agent or a channel. Each message becomes a
   customer-inbox Loop card and a message in the agent's thread, threaded by `Message-ID` and
   `References`, with the original as an attachment. The text is marked as data from a stranger.
3. **Outbound.** An `email.reply` tool goes to the Worker, which sends with Cloudflare Email Sending
   (the `send_email` binding). The older binding sends only to verified addresses; mail to any
   customer needs the newer Email Sending feature, which the token scope suggests but which is not
   confirmed for this account. Without it, the fallback is SMTP of a mailbox the owner has, or a new
   provider: both break "no new account".
4. Do not run postfix on the host: no reputation, a generic PTR and a shared IP.

## What the owner must do

- In Cloudflare: turn on Email Routing for `aprendivo.com` (it adds MX and SPF; the host's token
  cannot write DNS), and onboard the domain for Email Sending (DKIM and SPF records).
- Add DMARC to both domains, starting with `p=none` and a report address.
- Say which address goes to which agent, and whether agents may write first or only reply.
- Re-run `wrangler login` on the host if its refresh token has expired.

## Risks

- Deliverability of a new sending domain: start with replies only and low volume.
- Spain's LSSI and GDPR for outreach: consent records and an opt-out link before any first message;
  agents reply only until the owner says otherwise.
- Prompt injection: inbound mail is untrusted. Strip HTML and remote images, never follow links or
  open attachments without a check, and keep money, refunds and secrets with the owner. Use
  Cloudflare's SPF and DKIM verdicts and treat a failure as suspect. Limit outbound mail per agent
  and ask the owner before the first mail to a new recipient.
- One dependency: when the Worker or Cloudflare is down, mail bounces. Show that to the owner.

Not built in this stream: it needs the owner's Cloudflare steps first, and Email Sending must be
confirmed for the account.
