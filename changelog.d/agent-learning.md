### Added

- Agents keep what they learn from their own chats. After a person writes in an agent's chat, a
  background review on the provider's smaller model adds, updates or forgets memories, every 40
  turns or after a 30-minute pause. Each agent is reviewed at most once in 3 hours, and the server at
  most 40 times a day. Talk between agents, routine runs, channels and idle agents start no review.
- With Skill learning on Automatic, a review that finds a lesson saves it as a new skill of the agent
  or revises one of its own skills. The chat shows "Created skill" or "Revised skill". An agent gets
  at most 5 learned skills; after that the reviews only revise them.
- Server settings > Workspace > Learning sets the memory review (Off, every 20, 40 or 80 turns), skill
  learning (Off or Automatic) and the reviews per day.

### Fixed

- An agent that asked several teammates now reads the answers that came in after its next turn in
  the same chat ends, such as its next routine run, instead of waiting up to 20 minutes for the
  slowest teammate. Its prompt names the teammates that still work.
- "Waiting for replies" shows Replied, not Failed, for a teammate whose turn stopped after it
  answered, and no longer shows a teammate as working after it finished.
