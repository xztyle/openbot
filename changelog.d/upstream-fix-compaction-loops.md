### Fixed

- A chat no longer compacts again and again and uses up the plan limit. After two compactions in a
  row that fail, or two that still leave the chat at 70% or more of the model's window, Atelier stops
  compacting that chat by itself and says why once. "Compact now" still works, and a chat that drops
  below the limit compacts by itself again.
