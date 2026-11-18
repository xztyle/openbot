### Changed

- Deleting an agent asks first and then deletes it, on the desktop and on the web. The desktop no longer
  also shows an Undo toast after the confirmation, and the confirmation says that it cannot be undone.
  A failure shows in the confirmation, which stays open.
- On a phone, the create and edit dialogs rise from the bottom as a sheet with a grab handle, as the
  message actions do, and stop under the status bar.
- Add a custom provider, Add a custom ACP agent, the custom provider list and its first step, Add an
  agent from a shared link, the API key dialogs, Chat apps, Saved replies, More providers and the
  vault item form now use the same dialog as the other create and edit flows: a close button, an
  error line, and Cancel before the primary button. "Submit" is now "Add provider".
- Join server shows Cancel (or "Use another invite") before the primary button, as the other dialogs
  do. The sign-in waits of app connections and the hosted server offer have a close button.
- A failed add from a shared agent link shows in the dialog, which stays open, instead of a toast.
- Server settings ask before they lose an unsaved change: another section, Close, Back and Escape now
  all ask, not only leaving the Workspace section. The save bars of General, Workspace and app
  connections are one component.
- Threads, Activity, Between agents, Space agents and Secrets use one row: the same spacing, line
  between rows, unread tint and title. On a computer, row buttons show on hover; on a phone, always.
- Spanish: "Remove" is always "Quitar" and "Delete" always "Eliminar" (before, "Remove member" read as
  "Eliminar miembro"), and "Leave server" is "Salir del servidor", as "Leave channel" is "Salir del
  canal".
