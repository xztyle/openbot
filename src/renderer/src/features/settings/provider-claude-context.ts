import type { ClaudeContextSetting } from "@openbot/contracts/ipc";
import type { ProviderClaudeContext } from "@openbot/ui/features/settings/ProviderSettingsPage";
import { useText } from "@openbot/ui/text";
import { createEffect, createStore, untrack } from "solid-js";
import type { HostPromptCacheTtlCalls, ProviderPromptCacheSource } from "./provider-prompt-cache";

/**
 * The Claude page's context settings of this computer or a joined server (`claude-context-v1`): the
 * user's Claude Code setup and the compaction size. It goes where the prompt cache time goes, as both
 * are admin settings of the host. The host checks the role again. Undefined while `source` is.
 */
export function createProviderClaudeContext(
  source: () => ProviderPromptCacheSource | undefined,
): () => ProviderClaudeContext | undefined {
  const { t, errorMessage } = useText();
  const calls = (): HostPromptCacheTtlCalls => source()?.calls ?? window.openbot.hostAdmin;
  const [state, setState] = createStore<{ value: ClaudeContextSetting | null; pending: boolean; error: string | null }>(
    { value: null, pending: false, error: null },
  );
  /** Bumped for each server, so an answer for an earlier one is dropped. */
  let generation = 0;

  createEffect(
    () => source()?.serverId,
    (serverId) => {
      const current = ++generation;
      setState(() => ({ value: null, pending: false, error: null }));
      if (serverId === undefined) return;
      untrack(calls)
        .getClaudeContext(serverId)
        .then(
          (next) => {
            if (current === generation)
              setState((draft) => {
                draft.value = next;
              });
          },
          (error: unknown) => {
            if (current === generation)
              setState((draft) => {
                draft.error = errorMessage(error, t("provider.settings.claudeContextLoadFailed"));
              });
          },
        );
    },
  );

  async function change(update: Partial<ClaudeContextSetting>): Promise<void> {
    const serverId = source()?.serverId;
    const value = state.value;
    if (serverId === undefined || value === null || state.pending) return;
    const request = generation;
    setState((draft) => {
      draft.pending = true;
      draft.error = null;
    });
    try {
      const next = await calls().setClaudeContext({ ...value, ...update }, serverId);
      if (request === generation)
        setState((draft) => {
          draft.value = next;
        });
    } catch (error) {
      if (request === generation)
        setState((draft) => {
          draft.error = errorMessage(error, t("error.provider.useChangeFailed"));
        });
    } finally {
      if (request === generation)
        setState((draft) => {
          draft.pending = false;
        });
    }
  }

  const context: ProviderClaudeContext = {
    get value() {
      return state.value;
    },
    get pending() {
      return state.pending;
    },
    get error() {
      return state.error;
    },
    onChange: (update) => void change(update),
  };
  return () => (source() ? context : undefined);
}
