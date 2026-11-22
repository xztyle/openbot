# Atelier mail Worker

The Cloudflare Email Worker behind agent mailboxes ([docs/agent-mailboxes.md](../../docs/agent-mailboxes.md)).
One Worker serves every agent address of every business domain on the Cloudflare account.

- **Inbound** (`email` handler): Email Routing hands it each message to an agent address. It bounces
  a message over 1 MB, parses it with postal-mime, keeps plain text only (HTML becomes text; images,
  scripts, styles, link targets and hidden characters go), keeps Cloudflare's SPF, DKIM and DMARC
  verdicts, lists attachments by name and size without their content, and posts the result to the
  host's webhook inbox, signed with Atelier's scheme (`X-OpenBot-*`, HMAC-SHA256 with the mail
  secret). When the host does not answer 200 or 202 it rejects the message, so the sender gets a
  bounce: unknown address (404), too large (413), busy (429) or unavailable (5xx, timeout).
- **Outbound** (`fetch` handler, `POST /send`): the host posts one mail signed with the same secret.
  The Worker refuses a sender outside `SENDER_DOMAINS` and sends with the Cloudflare Email Sending
  `send_email` binding, with `In-Reply-To` and `References` for a reply and `List-Unsubscribe` for
  a first contact. It answers `{ messageId }`, or 502 with Cloudflare's error code.
- `GET /health` answers `{ ok: true }`.

The wire shapes and the signature live in `packages/contracts/src/agent-mail.ts`, which the host
shares.

## Settings

| Where | Name | Value |
| --- | --- | --- |
| `wrangler.toml` `[vars]` | `HOST_INBOX_URL` | The mail inbox address from Atelier: **Secrets → Agent mailboxes → Copy inbox address** (`https://connect.delynith.com/hooks/mail_…`). |
| `wrangler.toml` `[vars]` | `SENDER_DOMAINS` | The domains agents send from, such as `aprendivo.com,delynith.com`. Each must be onboarded for Email Sending. |
| Secret | `MAIL_SECRET` | The mail secret from **Secrets → Agent mailboxes → Worker → New secret**. Atelier shows it once. |
| Binding | `EMAIL` (`[[send_email]]`) | Cloudflare Email Sending. |

## Deploy

From the repository, with the Cloudflare login that owns the domains (`wrangler login`):

```sh
cd apps/email-app
# 1. Put the inbox address and the sender domains in wrangler.toml [vars].
# 2. The secret (paste it at the prompt):
bunx wrangler secret put MAIL_SECRET
# 3. Deploy:
bun run deploy            # = wrangler deploy --keep-vars
```

The deploy prints the Worker's address, `https://atelier-mail.<account subdomain>.workers.dev`.
Paste it in **Secrets → Agent mailboxes → Worker address** so the host can send.

Then route mail to it, per address, in the Cloudflare dashboard: the domain → **Email → Email
Routing → Routing rules → Create address**, custom address `ventas`, action **Send to a Worker**,
destination `atelier-mail`. Or a catch-all with the same action: the host answers 404 for an address
it does not know, and the sender gets a bounce.

Check it: `curl https://atelier-mail.<subdomain>.workers.dev/health`, then mail the address from
another account. The agent's chat shows the message; Settings show the time and status of the last
mail.

## Limits

- Without Email Sending onboarding, the `send_email` binding sends only to verified destination
  addresses of the account; a send to anyone else fails with Cloudflare's error code, which the agent
  reads.
- Cloudflare sets `Message-ID` itself, so a customer's answer is threaded by the `References` that
  carry the customer's own ids.
- A signed `/send` request is valid for five minutes. It travels only over HTTPS between the host and
  Cloudflare.
- When the Worker, Email Routing or the host is down, mail bounces; Settings show the last status.
