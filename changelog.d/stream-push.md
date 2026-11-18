### Added

- Web push notifications now come for what Slack notifies: a mention of you in a channel, thread or group, a message in a DM or a group, and a reply in a thread that you follow. They follow each conversation's bell (Just mentions, Nothing, mute) and your level for the server. Messages between agents send none.
- A tap on a web push notification opens the exact place: the message in its channel or thread, or the chat with the agent.

### Changed

- Several notifications of one conversation within 20 seconds become one more notification that counts them and replaces the first one without a second sound.
- A conversation set to Just mentions sends questions and approvals of its agent but no finished replies; Nothing and mute send nothing. A finished agent turn in a channel opens that channel.
- With push notifications on, the open web page no longer shows its own notification for a channel reply, so it does not come twice.
