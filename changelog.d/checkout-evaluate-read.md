### Fixed

- An agent that only reads a checkout page, such as the offer in a pay.hotmart.com link, no longer asks the owner to approve a payment. A read-only `evaluate` (the address, its query, the title, the text or an attribute of an element) runs with no card. A script that clicks, submits, sends, writes or navigates still asks, as does every click, key, typed text and card fill there.
- The approval card of an action on a payment page says what the agent wants to do there, such as "wants to act on a payment page (pay.hotmart.com): click …", and says "unknown amount" in the reader's language instead of "pay ? USD".
