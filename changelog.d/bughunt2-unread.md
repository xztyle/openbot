### Fixed

- Workspace: opening a channel or a DM marks it read again, and a new message in the open one stays
  read. Since the agent chat stopped counting as read under a workspace view, channels and DMs on the
  web stayed bold with their badges, the Space rail dot and the tab title count until Mark as read.
- Workspace: the Activity badge (and the phone's Activity count) goes when you read the DM or channel
  of its mention, here or on another device, instead of staying until Activity was opened.
- Workspace: a reply that comes into the open thread while the window is in the background is read
  when you come back to it, so Threads and the thread's badge no longer keep it as new.
- Workspace: an agent you have not written to lately that writes to you shows its DM row with the
  unread count again. Its messages had no row, so the sidebar, the Space rail, the phone's Chat tab
  and the tab title all left them out.
- Web and desktop: a mention in a conversation whose bell is set to Nothing counts once in the tab
  title and the Dock badge, as on the Space rail, instead of twice.
