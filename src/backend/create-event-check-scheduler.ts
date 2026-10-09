import type { AgentServiceOptions } from "./agent-service";
import { EventCheckScheduler, type EventCheckSchedulerOptions } from "./event-check-scheduler";
import { EventCheckStore } from "./event-check-store";
import type { OpenBotDatabase } from "./openbot-database";

export function createEventCheckScheduler(
  database: OpenBotDatabase,
  readers: Pick<AgentServiceOptions, "eventCheckReader" | "eventCheckApiReader">,
  options: Omit<EventCheckSchedulerOptions, "store" | "reader" | "apiReader">,
) {
  return new EventCheckScheduler({
    ...options,
    store: new EventCheckStore(database),
    reader: readers.eventCheckReader,
    apiReader: readers.eventCheckApiReader,
  });
}
