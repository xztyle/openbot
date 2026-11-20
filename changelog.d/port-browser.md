### Added

- Agents can do several browser steps that they already know in one call, such as typing a search, pressing Enter and waiting for the results, or paging through a list. They read the page once at the end, so browser work takes fewer turns and fewer tokens.
- A Vault login can keep a two-step (authenticator) setup key, and a CSV import reads the two-step keys of a password manager export. Agents then sign in with the current code and never see the key.
- A saved Secrets key that holds a two-step setup key now fills the current sign-in code when an agent signs in. The first fill of the key on a site waits for your approval. When you ask an agent to turn on two-step verification on a site, it saves the site's setup key in Secrets without reading it.

### Changed

- Agent browser tabs refuse cookie banners automatically. They click only a reject button, never accept. Tabs that you open keep their banners, and the refusal stops when you take control of a tab.
- Before an agent asks you to take over a tab for a Turnstile, reCAPTCHA or hCaptcha check, the browser clicks the check's checkbox once. Many checks pass with this click, and then nobody is asked. An image puzzle still goes to you, and no page data goes to a CAPTCHA service.
- Agents fill a saved authenticator code into more sign-in pages, such as code fields that are named by their label or have no one-time-code mark.
- Agents now finish a checkout when the bank asks for a 3-D Secure code. When the code is in an email or SMS that the agent can read, and the message names the same shop and amount, the agent types it. In other cases the agent still asks you to take over.
