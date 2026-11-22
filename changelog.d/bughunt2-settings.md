### Fixed

- Secrets > Agent mailboxes: "New mail secret" asks first when a secret is already set, because the
  Worker's secret stops working at once and mail is refused until the Worker has the new one.
  Before, one tap replaced it.
- Secrets > Agent mailboxes: when the host refuses to remove an address, the question stays open
  with the reason. Before, nothing happened and the address stayed without a word.
- Secrets > Chat apps: revoking an access link says "Link revoked", where the notice read "Revoke".
