### Added

- Install ready-made event checks from the new **Event checks** tab in Marketplace. Install the same
  template for several agents and several accounts. Each install has its own settings, private
  variables, schedule and history. New checks start paused, so you can test them first.
- See which template an event check came from, and move it to a newer template version. An update
  gives the check a fresh baseline.
- Nine event check templates ship with the host: Linear, GitHub, any git server, Slack, Discord,
  Gmail, Proton Mail, Render and PostHog.
- Let agents list, install, update, link, enable and pause event check templates with native tools.
  An agent can fill in the settings, but private values such as API keys stay for you to add.
- Show true or false template settings as toggles, and mark optional settings in the install form.
- Fix: Claude agents had no `openbot` tools after the template tools shipped. One tool's schema
  could not be converted, and that removed the whole tool set. The install tool now takes its
  settings as a list, and a test keeps such schemas out.
- Show agents the real reason when an event check or template action is refused, such as an update
  that needs your approval, instead of a generic "app check failed" message.
