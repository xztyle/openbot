### Added

- Agent mailboxes. A business address such as `ventas@aprendivo.com` goes to one agent: Cloudflare
  Email Routing hands each mail to the new mail Worker (`apps/email-app`), which strips HTML and
  remote content, keeps Cloudflare's SPF, DKIM and DMARC verdicts and posts the mail, signed, to the
  host's connector gateway. The mail arrives in the agent's chat as a note from Atelier, threaded by
  Message-ID and References, and as a card in the space's customer inbox loop when the space has one.
  A mail the host does not take bounces, so the sender knows.
- `email_reply` answers a mail as that address, in the same thread. `email_send` writes first, only
  from an address the owner set to "may write first". A reply sends at once; a first contact waits for
  the owner's OK in Needs you and ends with an opt-out line and `List-Unsubscribe`, an
  opt-out reply stops later first mails, and each agent sends at most 20 mails an hour, 100 a day and
  10 first contacts a day.
- Mail counts as untrusted content for the injection monitor, and a mail tool is a send: after a turn
  read a mail, each reply passes the monitor's check first.
- Secrets → Agent mailboxes: add an address, pick the agent and the mode, link the mail Worker and make
  its secret. See docs/agent-mailboxes.md.
