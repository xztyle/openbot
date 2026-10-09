### Added

- Choose what each agent's chat may do with each app account from the app's page in Marketplace:
  Off, Read only or Allow changes. After you connect an app, the page asks once what the open chat's
  agent may do with the new account. It stays Off until you press a mode. Nothing grants access
  from a link, an agent or a default.
- Turn an app account on or off, rename it, check that it works, and sign in again or change its key
  from the app's page. The account keeps its connection, so its chat access stays. Before, a dead
  sign-in meant you had to disconnect the account and add it again.
- Update an app to the version of its server that the listing names today. Accounts keep their
  names, sign-ins and chat access. OpenBot also moves rows from an earlier release to the new
  version when it starts, only when the row still has the exact words of that release.
- See which skills have a newer version on the skill cards, filter the Skills tab by **Updates
  available**, and update them all at once. A skill that you changed is never replaced.
- Filter apps by category, search apps by their description and category, and see how many
  accounts an app has on its card.
- See the event checks that read an app on the app's own page.
- Install the skills of an app on several agents from the app's page.

### Changed

- Show an app whose accounts are all turned off as **Disabled** and not as **Connected**.
- Show on the chat card of a suggested app whether the app is connected, turned off, or not allowed
  in this chat yet. The card offers **Allow in this chat** and opens the app's page, where you
  choose the access. The web client now opens the app from the card.
- Tell agents that a plugin may also need your permission for each chat. Before, the instructions
  said that an enabled plugin works for every agent.
- Check at build time that the Slack listing names the server that read-only mode was reviewed for.
  Before, a version change could make read-only mode block every Slack tool.
