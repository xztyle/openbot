### Fixed

- Keep the text that you typed in the web app when the page reloads, the browser closes the tab or
  your session ends. A message that failed to send comes back in the composer, too. Signing out
  removes the saved text. Before, it was lost.
- Show the update notice while a computer restarts to install an update, and ask it again every few
  seconds. Before, the notice turned into a plain "Reconnecting" after the first failed attempt.
- Check the connection when you return to the web app after a while in the background, so a chat
  that went stale on a phone catches up at once.
- Keep a pending approval or question on screen through a short connection loss. Before, it
  disappeared and came back.
- Show "You are offline" instead of the browser's "Load failed" when the network is gone, and
  end a request that has no answer after 15 seconds so Retry appears. The notice that waits for a
  newer web version has a Reload app button.
- Show a push notification for each push that the web app receives on iPhone, also when the app is
  open, so the browser keeps push notifications on. The web app also gives the host the new
  address when the push service changes it.
- Let the Back button of a phone close a dialog, the settings or the usage report before it leaves
  the chat.
- Read the open chat again only for an event of that chat, not for each event of every agent.
