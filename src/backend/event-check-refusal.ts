import { isDynamicRecord } from "@openbot/contracts/runtime-values";

/**
 * A refusal the caller should read, such as a credential in a field or a program nobody approved.
 * Its message is localized text that names a field or a step and never holds a value.
 */
export class EventCheckRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EventCheckRefusal";
  }
}

/** The message of a refusal inside a typed failure, or null for any other failure. */
export function refusalMessage(failure: unknown): string | null {
  const cause = isDynamicRecord(failure) && "cause" in failure ? failure.cause : failure;
  return cause instanceof EventCheckRefusal ? cause.message : null;
}
