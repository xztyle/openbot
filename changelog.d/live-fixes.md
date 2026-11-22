### Fixed

- The independent grader of a Motion card reads the files that the card's agent wrote or that the criteria name, as they are on disk, so a card whose criteria are about a file can pass. Before, it saw only "Write" in the step trail and reopened such cards until they went to the owner. Its hand-offs to the owner are now in the log.
- An order card no longer wakes its assignee twice: Motion's assignment event, which can arrive before the card is made, is held like the order message's own wake.
