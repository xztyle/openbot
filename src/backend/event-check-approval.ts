import { createHash } from "node:crypto";
import type { EventCheckApiSource } from "@openbot/contracts/event-checks";

// A setting that decides where a program sends its private values. A reviewed program with an
// address setting is still a way to send a token anywhere, so a change here needs the user too.
const DESTINATION_NAME = /(?:url|uri|host|endpoint|server|domain|origin|proxy|port|security|base)/iu;
const ADDRESS_VALUE = /^[a-z][a-z0-9+.-]*:\/\//iu;

/**
 * A fingerprint of what the program is told besides its code: its fixed arguments, its paging
 * argument, and the settings that name an address. Settings such as a list of repositories are not
 * part of it, so an agent can tune them without the user.
 */
export function eventCheckDestination(source: EventCheckApiSource): string {
  const addresses = source.configuration
    .filter((field) => DESTINATION_NAME.test(field.name) || ADDRESS_VALUE.test(field.value.trim()))
    .map((field) => [field.name, field.value] as const)
    .sort(([left], [right]) => left.localeCompare(right));
  return createHash("sha256")
    .update(JSON.stringify({ arguments: source.argumentsJson, cursor: source.cursorArgument, addresses }))
    .digest("hex");
}

/** The program and the destination that the user approved when the private values were last set. */
export interface EventCheckApproval {
  digest: string;
  destination: string;
}
