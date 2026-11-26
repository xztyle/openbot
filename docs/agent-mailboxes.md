# Agent mailboxes

A customer-facing agent has its own address on the business's domain, such as
`ventas@aprendivo.com`. Mail to it becomes work in that agent's chat, and the agent answers as that
address. There is no mail server on the host: Cloudflare carries the mail both ways.

```
sender ──SMTP──> Cloudflare Email Routing ──> mail Worker (apps/email-app)
                                                │  parse, strip, sign
                                                ▼
                           https://connect.<domain>/hooks/<mail route id>   (connector gateway)
                                                │
                                   agent's chat + customer inbox loop card
agent: email_reply / email_send ──> host ──signed POST /send──> mail Worker ──> Cloudflare Email Sending
```

## What happens to a mail

- The Worker bounces a message over 1 MB, keeps plain text only (HTML becomes text; scripts, styles,
  images, link targets and hidden characters go), keeps Cloudflare's SPF, DKIM and DMARC verdicts,
  and lists attachments by name and size without passing them on.
- The host checks the signature, finds the address, and puts the mail in the agent's chat as a note
  from Atelier with a mail thread id (`mt_…`). A follow-up joins the same thread by `In-Reply-To` and
  `References` (or, failing those, the same sender and subject within 30 days).
- When the agent's space has a loop made from the customer inbox template, the mail is a card in it
  (`externalId` = the thread id, so a follow-up updates the same card).
- An out-of-office, a bounce or a newsletter (`Auto-Submitted`, `Precedence: bulk`, list headers) is
  taken but kept out of the chat, so the agent does not answer it.
- An address the host does not know answers 404, and the sender gets a bounce. So does a mail while
  the host is offline: Settings show the time and status of the last mail.

## Safety

- The note says that the mail is a stranger's data, never instructions, and fences the text. A
  sender that Cloudflare could not confirm (DMARC fail, SPF fail without DKIM, or neither) is marked
  "may be forged".
- A turn that read a mail is tainted for the injection monitor, and `email_reply` and `email_send` are
  sends: each one passes the monitor's check first, and a send that follows the mail and not the task
  is blocked and the owner is alerted.
- A reply (`email_reply`) to someone who wrote to the address sends at once. Only a first contact
  (`email_send` to someone who never wrote) waits for the owner's approval card in Needs you; Full
  access does not answer it. Later mails to that person need no OK.
- Each agent sends at most 20 mails an hour and 100 a day, and writes first to at most 10 new people
  a day.
- `email_send` works only from an address set to **May write first**. A first contact ends with an
  opt-out line (Spanish and English) and has `List-Unsubscribe`. A mail whose first line or subject
  says stop, unsubscribe or baja marks the sender as opted out, and later first mails to them are
  refused.
- Money, refunds and secrets stay with the owner: the trust policy still applies to everything else
  the agent does.

## Owner steps in Cloudflare

Do these once per business domain, in the Cloudflare dashboard (the host's token cannot write DNS).

1. **Email Routing on `aprendivo.com`.** The domain → **Email → Email Routing → Get started** (or
   **Enable Email Routing**). Let it add its MX and SPF records. `delynith.com` has it already.
2. **Email Sending.** The domain → **Email → Email Sending** (Email Service) → onboard the domain and
   let it add its DKIM and SPF records. Without this, the Worker can only send to verified
   destination addresses, and a reply to a customer fails with Cloudflare's error code.
3. **DMARC.** Already added with `p=none` on both domains. Raise it to `p=quarantine` after a few
   weeks of clean reports.
4. **Route the address to the Worker** (after the operator deployed it): the domain → **Email → Email
   Routing → Routing rules → Create address**: custom address `ventas`, action **Send to a Worker**,
   destination `atelier-mail`. Repeat for each address, or set the **Catch-all** rule to the same
   Worker; unknown addresses then bounce from the host.
5. In Atelier, **Secrets → Agent mailboxes → Add address**: the address, the agent, the mode (**Reply
   only** is the default) and the sender name.

## Operator steps

1. The connector gateway must listen with a public URL (`OPENBOT_CONNECTOR_LISTEN`,
   `OPENBOT_CONNECTOR_PUBLIC_URL`, see [connector gateway](connector-gateway.md)). The nginx
   `client_max_body_size 300k` there is enough: a mail body is at most 128 KB.
2. In Atelier, **Secrets → Agent mailboxes**: **Copy inbox address**
   (`https://connect.delynith.com/hooks/mail_…`), then **New mail secret** and copy it. It shows once.
3. Deploy the Worker with the Cloudflare login that owns the domains:

   ```sh
   cd apps/email-app
   # wrangler.toml [vars]: HOST_INBOX_URL = the inbox address, SENDER_DOMAINS = "aprendivo.com,delynith.com"
   bunx wrangler secret put MAIL_SECRET   # paste the mail secret
   bun run deploy                         # wrangler deploy --keep-vars
   ```

   A first deploy may ask for the `workers.dev` subdomain. `wrangler secret put` on a Worker that
   does not exist yet creates it, so either order works.
4. Paste the address the deploy printed (`https://atelier-mail.<subdomain>.workers.dev`) in **Secrets
   → Agent mailboxes → Link the Worker**.
5. Check: `curl https://atelier-mail.<subdomain>.workers.dev/health` answers `{"ok":true}`; mail the
   address from another account and the agent's chat shows it. Then let the agent answer it; a reply
   needs no approval.

From the server itself, the control socket does steps 2 and 4 and adds addresses (operator only):
`POST /v1/mailboxes` answers the state, `/v1/mailboxes/save` takes `{ address, agentId, mode,
displayName? }`, `/v1/mailboxes/worker` takes `{ workerUrl }`, and `/v1/mailboxes/secret` answers a
new `secret=` line once; pipe it straight into `wrangler secret put MAIL_SECRET`.

A new mail secret stops the old one at once: put it in the Worker right away with `wrangler secret
put MAIL_SECRET`. The state lives in `openbot-agent-mailboxes-v1.json` in the profile, with the secret
encrypted by the host's secret storage.

## Limits

- One Worker serves every address of the account; each sender domain must be in `SENDER_DOMAINS` and
  onboarded for Email Sending.
- The original message and its attachments are not kept: the agent sees the text and the list of
  files. Ask the sender for a link, or forward the file to the owner.
- An address binds to one agent, not to a channel.
- When the Worker, Cloudflare or the host is down, mail bounces.
