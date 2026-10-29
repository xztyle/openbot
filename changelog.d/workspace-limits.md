### Added

- Reactions go both ways between a workspace channel and its bridged Discord channel. A reaction of a person in Discord shows in the workspace, and a reaction in the workspace shows as an OpenBot reaction on the Discord post. Custom Discord emoji are not mirrored.
- Discord threads in a bridged channel are workspace threads. The messages of a Discord thread are replies in the thread of its first message, and the workspace replies of that thread go into the Discord thread.
- Artifact cards of sites and apps show a picture of the page. OpenBot makes it on the host at most once a day, and never for a local or private network address.
- The sidebar order and the muted conversations are saved for your account on each server, so they are the same on all your computers and in the web client.

### Changed

- A person shows as typing while they edit a draft, also when the composer does not have the keyboard focus, for example while the emoji picker is open.
- The emoji picker is a list that screen readers read as options, and it says how many emoji a search finds.
- The artifact list opens faster after a restart: the host keeps its index on disk and reads only the new messages.

### Fixed

- When someone deleted a bridged workspace post in Discord, a later edit of that message tried to change the deleted post. Now the workspace keeps the message and the bridge stops calling Discord for it.
