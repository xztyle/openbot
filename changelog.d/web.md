### Added

- The web app shows inline previews of image files in a chat. An image of 3 MB or less loads when it scrolls into view. Before, every image was a file card that you had to open.
- The web app shows unread counts and the "replied" mark in the sidebar, and shows the number of agents that need you in the browser tab title. Before, the sidebar never showed unread messages in the web app.
- The web app can send push notifications to your phone or browser, also when the page is closed. Turn it on in Account settings > Preferences > Push notifications. Your own computer sends the notification straight to the push service of your browser, encrypted. It holds the name of the agent and the kind of event, never message text. OpenBot accounts do not see it. A host needs the new version of OpenBot for this.
- You can install the web app on your phone or computer. `/app` has its own manifest and icons, and works behind Cloudflare Access.
- Agent settings in the web app show Memories, as the desktop app does.
- On a phone, the back button goes from a chat to the list of agents. The list tab is now called Agents and shows a dot when an agent needs you.

### Changed

- When you return to the web app page, it ends the wait before the next reconnect attempt and tries at once. When the network comes back, it also renews the open connection. Before, a connection that looked online could stay dead.

### Fixed

- "Mark all as read" in the web app sidebar is now available only when a chat has unread messages. Before, it was always available.
