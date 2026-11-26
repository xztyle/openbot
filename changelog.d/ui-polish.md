### Changed

- Type, icons and tracking follow the token scales everywhere: every font weight names one of the
  four weight tokens, every line-height a step of the leading scale, every letter-spacing one of
  five tracking tokens, and the conversation and sidebar icons come from the Lucide set at token
  sizes. `check:ui` holds new budgets at zero for font-weight, line-height, letter-spacing and
  Tailwind arbitrary values, with fixtures. `scripts/ui-polish-sweep-e2e.ts` screenshots and measures
  the web client on a computer and an iPhone, light and dark.
