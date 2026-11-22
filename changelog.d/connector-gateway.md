### Added

- Reach your agents from Claude or ChatGPT. Under Secrets, make an access link and add it as a
  custom connector: the chat app can list your agents, send one an order, read its answer and see
  what waits for you. Text only; approvals and money stay in Atelier. Each link can be revoked.
- Let Stripe, Hotmart and YouTube wake an agent. Under Secrets, each webhook routine of the space
  shows its own address; pick the sender and paste its signing secret (Stripe), hottok (Hotmart) or
  WebSub secret (YouTube). Atelier checks the signature, hides buyer contact details, and starts the
  routine with the same filters and limits as other webhook events. The server operator turns the
  address on with `OPENBOT_CONNECTOR_LISTEN` behind HTTPS; see `docs/connector-gateway.md`.
