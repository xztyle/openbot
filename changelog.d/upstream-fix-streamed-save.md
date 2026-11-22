### Fixed

- When the server could not write to the Atelier database for a moment (busy, locked, disk error or
  disk full) while an agent wrote a reply, the error escaped from a timer and that part of the live
  reply was lost. Now Atelier keeps the reply text and saves it again a moment later.
