/**
 * Secrets of the host that come in main's environment, such as the signing secret of the Motion
 * events route from the container's environment. Every agent process inherits main's environment, so
 * main takes them out before it starts a child, and only main reads them, from here.
 *
 * This keeps them out of `env` and of the tools that agents run. It is not a boundary against an
 * agent that reads `/proc/<pid>/environ` of main or of PID 1: agents run as the same user. See the
 * agent jail notes in docs/self-hosted-server.md.
 */

const HOST_SECRET_VARIABLES = ["OPENBOT_MOTION_EVENTS_SECRET"] as const;

export type HostSecretName = (typeof HOST_SECRET_VARIABLES)[number];

const taken = new Map<HostSecretName, string>();

/** Moves the host secrets out of the environment. Call it before any child process starts. */
export function takeHostSecretEnvironment(environment: NodeJS.ProcessEnv): void {
  for (const name of HOST_SECRET_VARIABLES) {
    const value = environment[name]?.trim();
    delete environment[name];
    if (value) taken.set(name, value);
  }
}

export function hostSecret(name: HostSecretName): string | null {
  return taken.get(name) ?? null;
}
