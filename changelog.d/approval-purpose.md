### Changed

- An approval card now says first what the agent wants and why, in the agent's own words. Then it shows the fixed action line (platform and action), the amount when known, and the raw call behind "See technical details". When the agent gives no reason, Atelier writes one plain line and marks it "Atelier's summary". The card text is in the owner's language on desktop, web, phone and Today.
- A Meta ads call that only checks (`--validate`, `--dry-run`, lists, reports, previews) and a Hotmart `--dry-run` run with no approval.
- On a checkout page, only real payment steps ask the owner: the buy button, card, document or billing fields, Enter, or a form submit. Choosing a country, a language or the installments shown, reading, scrolling and waiting run with no card. A step whose target Atelier cannot read is refused with a message to the agent. One approval of a buy step covers that agent and site for 30 minutes; card data asks each time.
