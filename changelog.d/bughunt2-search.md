### Fixed

- Search: "Show more" no longer spins for good when you start a new search while the next page of
  the last one loads.
- Jump to: with words that name no conversation, the first row searches the messages. Before,
  "Create #…" came first, so Enter (the Search key of a phone's keyboard) opened the form of a new
  channel named after your search.
- Ctrl+F (⌘F) in a DM or a group searches that conversation (`in:@name`). Before, it wrote
  `in:#dm-…`, which matched nothing and showed "Nothing matches a filter".
- Search's Channels and People tabs match without accents, as Messages does: `jose` finds José and
  `diseno` finds a channel about diseño.
- Recent searches: a tap on the words of a recent search runs it (before, only the small search
  icon did). On a phone, emptying the search field and pressing Search shows the recent searches
  again.
- A search result on one of an agent's working steps ("Checking the release branch…") opens the
  channel at that turn's answer, lit. Before, the step has no row of its own, so the channel opened
  with nothing lit, and in a long channel it loaded older pages looking for it.
