import type { GuardrailPause, GuardrailsView } from "@openbot/contracts/guardrails";
import { Button } from "@openbot/ui";
import { ComposerNotice } from "@openbot/ui/features/conversation/ComposerNotice";
import { useText } from "@openbot/ui/text";
import { createMemo, createSignal, Show } from "solid-js";
import { useOptionalWorkspace } from "../workspace/workspace-context";
import type { WorkspaceController } from "../workspace/workspace-controller";
import { useGuardrails } from "../workspace/workspace-host-feeds";

/** The guardrails pause that holds this agent's own work: its own, else its space's. */
export function guardrailPauseOf(
  view: GuardrailsView | null,
  agentId: string,
  spaceId: string | null,
): GuardrailPause | null {
  if (!view) return null;
  return (
    view.pauses.find((pause) => pause.scope === "agent" && pause.id === agentId) ??
    (spaceId ? view.pauses.find((pause) => pause.scope === "space" && pause.id === spaceId) : undefined) ??
    null
  );
}

/**
 * Above an agent's message box, on the computer, the web and the phone: the guardrails pause that
 * holds the agent's own work, in plain words, with Resume for the owner and the admins. The owner's
 * own messages still start a turn; only the agents' routines, teammates' messages and Motion wakes
 * wait. Nothing shows outside a workspace or for a reader who may not read the guardrails.
 */
export function GuardrailPauseNotice(props: { agentId: string | null | undefined }) {
  const ws = useOptionalWorkspace();
  return <Show when={ws}>{(controller) => <PauseNotice ws={controller()} agentId={props.agentId} />}</Show>;
}

function PauseNotice(props: { ws: WorkspaceController; agentId: string | null | undefined }) {
  const { t, format } = useText();
  const guardrails = useGuardrails(props.ws);
  const [resuming, setResuming] = createSignal(false);
  const [failed, setFailed] = createSignal(false);
  const pause = createMemo(() => {
    const agentId = props.agentId;
    if (!agentId) return null;
    return guardrailPauseOf(guardrails.value(), agentId, props.ws.spaces.agentSpace(agentId) ?? null);
  });
  const body = (current: GuardrailPause): string => {
    if (current.reason === "loop") return t("composer.guardrailPause.loop");
    if (current.reason !== "turns") return t("composer.guardrailPause.budget");
    const row = guardrails.value()?.usage.find((entry) => entry.scope === current.scope && entry.id === current.id);
    const limit = row?.limits.turnsPerDay;
    if (!row || limit === null || limit === undefined) return t("composer.guardrailPause.budget");
    return t("composer.guardrailPause.turns", { used: format.number(row.turns), limit: format.number(limit) });
  };
  const title = (current: GuardrailPause): string =>
    current.scope === "space"
      ? t("composer.guardrailPause.spaceTitle")
      : t("composer.guardrailPause.agentTitle", {
          name: props.ws.env.agents().find((agent) => agent.id === current.id)?.name ?? "",
        });
  async function resume(current: GuardrailPause) {
    const calls = props.ws.env.trust?.();
    if (!calls) return;
    setResuming(true);
    setFailed(false);
    try {
      guardrails.set(await calls.guardrails.resume(current.scope, current.id));
    } catch {
      setFailed(true);
    } finally {
      setResuming(false);
    }
  }
  return (
    <Show when={pause()} keyed>
      {(current) => (
        <ComposerNotice
          title={title(current)}
          body={failed() ? `${body(current)} ${t("composer.guardrailPause.resumeFailed")}` : body(current)}
          action={
            <Show when={props.ws.isAdmin() && props.ws.env.trust?.()}>
              <Button
                variant="ghost"
                size="sm"
                type="button"
                disabled={resuming()}
                onClick={() => void resume(current)}
              >
                {t("trust.guardrails.resume")}
              </Button>
            </Show>
          }
        />
      )}
    </Show>
  );
}
