### Fixed

- When an agent saves a new password in the Vault for one subdomain, such as billing.example.com,
  Atelier now adds a new login. The login of another subdomain with the same username, such as
  status.example.com, keeps its password. Before, Atelier replaced the password of that login, and
  the old password was lost.
