import { toLogValue } from "@openbot/logging";
import { Effect } from "effect";
import type { AgentService } from "../backend/agent-service";
import type { OwnerAlert, OwnerAwayNotice, OwnerAwayService } from "../backend/owner-away";
import type { WebPushService } from "./web-push";

export interface OwnerAwayWiring {
  ownerAway: OwnerAwayService;
  webPush: Pick<WebPushService, "notifyOwner">;
  service: Pick<AgentService, "sendMessage" | "listAgents">;
  agentName: (agentId: string) => string | undefined;
  timezone: () => string;
  logger: { warn(message: string, ...values: unknown[]): void };
  /** The late handles of the service, which is made before the agent service and the push sender. */
  set: {
    deliver(value: (agentId: string, text: string, key: string) => void): void;
    push(value: (notice: OwnerAwayNotice) => void): void;
    alert(value: (alert: OwnerAlert) => void): void;
  };
}

/**
 * Connects the owner's away state to the rest of the host: an answer to a held request goes to its
 * agent as a message from the owner, a summary and an alert go to the owner's browsers, and the held
 * requests of an agent that is gone leave the list.
 */
export function wireOwnerAway(wiring: OwnerAwayWiring): void {
  const { ownerAway, webPush, service, logger } = wiring;
  wiring.set.deliver((agentId, text, key) => {
    if (!service.listAgents().some((agent) => agent.id === agentId)) {
      ownerAway.forgetAgent(agentId);
      return;
    }
    Effect.runFork(
      service
        .sendMessage({ agentId, text, clientMessageId: `owner-held:${key}` }, undefined, wiring.timezone())
        .pipe(
          Effect.catch((failure) =>
            Effect.sync(() => logger.warn("A held answer could not reach its agent:", toLogValue(failure.cause))),
          ),
        ),
    );
  });
  wiring.set.push((notice) => {
    webPush.notifyOwner({
      kind: "summary",
      agentId: notice.agentId ?? "",
      view: "activity",
      urgent: true,
      text: (t) =>
        notice.kind === "held-bundle"
          ? {
              title: t("notification.away.bundleTitle"),
              body: t("notification.away.heldBody", { count: notice.held }),
            }
          : {
              title: t("notification.away.digestTitle"),
              body: [
                t("notification.away.digestBody", { count: notice.count }),
                notice.held > 0 ? t("notification.away.heldBody", { count: notice.held }) : "",
              ]
                .filter(Boolean)
                .join(" "),
            },
    });
  });
  wiring.set.alert((alert) => {
    const amount =
      alert.amountUsd === undefined
        ? null
        : new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(
            Math.abs(alert.amountUsd),
          );
    webPush.notifyOwner({
      kind: "alert",
      agentId: alert.agentId,
      view: "agent",
      urgent: alert.urgent,
      text: (t) => ({
        title: wiring.agentName(alert.agentId) ?? "Atelier",
        body:
          alert.category === "money"
            ? amount
              ? t("notification.alert.money", { amount })
              : t("notification.alert.moneyNoAmount")
            : t(alert.category === "outage" ? "notification.alert.outage" : "notification.alert.security"),
      }),
    });
  });
}
