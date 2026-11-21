### Changed

- The browser view looks like a browser: the page fills the view at its own size, the tab row shows
  the tabs of this agent with site marks, titles and close buttons ("All agents' tabs" and "Close
  inactive tabs" are in its menu, with "N more" for tabs out of view), the address bar has a lock and
  a loading line, and a phone gets one compact bar. A person who has the page sees "You're in
  control" and "Hand back".
- While an agent acts on a tab, the view holds your clicks and keys and shows "Agent is using this
  tab" with Take over.

### Fixed

- The live view no longer says "Reconnecting to the page…" again and again on a slow connection.
  The server now sends the next picture only when the view has drawn the last ones, so a slow path
  shows fewer pictures instead of falling behind and closing.
- A sign-in popup or a new tab that a page opens now shows in the view, and the view goes back to the
  page when the popup closes. Before, a button such as "Continue with Facebook" seemed to do nothing.
