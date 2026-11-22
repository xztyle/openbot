### Fixed

- Secrets > Agent mailboxes: "New mail secret" asks first when a secret is already set, because the
  Worker's secret stops working at once and mail is refused until the Worker has the new one.
  Before, one tap replaced it.
- Secrets > Agent mailboxes: when the host refuses to remove an address, the question stays open
  with the reason. Before, nothing happened and the address stayed without a word.
- Secrets > Chat apps: revoking an access link says "Link revoked", where the notice read "Revoke".
- Quiet hours and focus: an urgent money amount above 1,000,000 or with cents says what to enter,
  under the field. Before, Save was greyed out with no reason, or the host refused the amount and
  the dialog only said that the settings could not be saved.
- Settings > Connections & secrets, and a link to a server settings section such as
  `?page=server-settings&section=connections`, open the server settings. Before, the web client
  stopped answering: no tap, view or message updated until a reload.
