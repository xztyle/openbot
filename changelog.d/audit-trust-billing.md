### Changed

- Trust & audit: the rules by role are one group per role and one group for who approves. Each
  switch is a settings row, and its label turns it. The guardrails show the subscription meter and
  the recent events as rows. Remove, Close, Retry and Open chat are real buttons.
- Billing: the server plans are a settings section with one row for each plan, and Manage payment
  is beside the section title. In the web client, Billing opens in the standard dialog.
- Connectors: Disconnect GitHub asks first in the standard confirmation. The danger zone is a
  settings row with a real button. The GitHub account, the repositories and the Bitwarden form are
  settings groups, and each field has a label.
- The dialogs that connect an app (with a key, an app on this computer, or a sign-in) and the connect
  steps of GitHub, Slack, Discord and Telegram use the standard dialog: Cancel is in the footer, and
  a failure shows above it. In a chat's apps, each app has a list with Off, Read and Write.

### Fixed

- On a phone, the connect dialogs of Slack, Discord and Telegram, and the Remove dialog of a marketplace app, fit the screen: long steps wrap and two buttons stack instead of running off the edge.
