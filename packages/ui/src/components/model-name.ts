import type { ClientAgentModelOption } from "@openbot/contracts/ipc";

/** A model's name as the model picker shows it: without a leading separator, or the id when it has none. */
export function displayModelName(name: string | undefined, fallback: string): string {
  return name?.replace(/^[\s:–—-]+/, "") || fallback;
}

/** The name that the picker shows for `model` of `provider`, or undefined when the options do not list it. */
export function modelNameOf(
  options: readonly ClientAgentModelOption[],
  provider: string,
  model: string,
): string | undefined {
  const option = options.find((candidate) => candidate.provider === provider && candidate.id === model);
  return option ? displayModelName(option.name, model) : undefined;
}
