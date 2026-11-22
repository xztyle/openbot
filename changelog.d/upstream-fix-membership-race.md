### Fixed

- A member that one admin removes stays removed when another admin changes that member's role at
  the same time. Before, the stale role change made the removed member active again. The second
  admin now sees "Someone changed this member at the same time".
