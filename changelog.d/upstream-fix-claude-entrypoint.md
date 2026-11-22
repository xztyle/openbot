### Fixed

- Claude agents on a Claude plan use the plan's 5-hour window about half as fast. Atelier now names
  itself to Claude, so its requests no longer count as SDK requests, which Claude counted about twice
  as heavily. The claude.ai Artifact tools stay off, which saves about 13k tokens per request. A
  Claude agent on an API key keeps the SDK label, so promotional API credit still applies.
