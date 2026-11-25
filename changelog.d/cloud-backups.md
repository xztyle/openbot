### Added

- Server settings > Backups has a "Copy in the cloud" section. The owner connects Proton Drive (email,
  password, the 2FA code once, and the mailbox password of two-password accounts) and the server then
  keeps encrypted copies there: every hour by default, or every 15 minutes, every 6 hours or once a
  day. The owner picks what goes in (Atelier's data, agent conversations, agent folders, settings,
  the Motion board, finished work in spaces) and whether to keep every copy (the default: after the first
  copy each one only adds what changed) or "Save space" (all of the last 48 hours, then 14 daily, 8
  weekly and 12 monthly). The password of the copies is shown once, to save in
  a password manager.
- The section shows the last copy, the next one, how long a usual copy takes and how much it sends,
  the drive's free space, and the weekly restore test. "Back up now" and "Test a restore" run at
  once. A failed copy, an ended Proton session, a full drive or no copy for twice the interval sends
  the owner a plain push.
- The owner downloads any copy into its own folder on the server (nothing in use changes), then can
  turn it into a backup that the usual Restore puts back after a safety copy.
- The owner chooses the folder in Proton Drive (default "Atelier Backups/<server name>"), and can
  move the copies to another folder or start in a new one.
- Restore from the drive: the list says what each copy holds; restore the whole copy, some parts, or
  one file or folder into a separate folder, then "Put this copy back" (a safety copy first, then
  Atelier pauses, puts it back and restarts). The same account and the copies' password restore a
  copy on another server.
- A running copy shows a progress bar with the speed and the time left. At 90% full, the owner is
  told to turn on "Save space"; nothing is deleted without it.
