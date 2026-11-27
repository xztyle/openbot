import {
  type SecretAccess,
  type SecretActor,
  type SecretHealth,
  type SecretKind,
  secretScopeKind,
} from "@openbot/contracts/ipc";
import type { AppTextKey } from "@openbot/i18n";
import type { JSX } from "@solidjs/web";
import { Badge } from "../../badge";
import { Asterisk, KeyRound, LockKeyhole, RectangleEllipsis, Ticket } from "../../icons";
import { useText } from "../../text";
import type { WorkspaceMember } from "../workspace/workspace-types";
import { agoParts } from "./secrets-vault-model";

const TYPE_KEYS = {
  key: "secrets.type.key",
  password: "secrets.type.password",
  token: "secrets.type.token",
  code: "secrets.type.code",
  other: "secrets.type.other",
} as const satisfies Record<SecretKind, AppTextKey>;

const HEALTH = {
  expired: { key: "secrets.status.expired", variant: "destructive-light" },
  expiring: { key: "secrets.status.expiring", variant: "warning-light" },
  "rotate-due": { key: "secrets.status.rotateDue", variant: "warning-light" },
  "rotate-soon": { key: "secrets.status.rotateSoon", variant: "info-light" },
  unused: { key: "secrets.status.unused", variant: "secondary" },
  ok: { key: "secrets.status.ok", variant: "success-light" },
} as const satisfies Record<SecretHealth, { key: AppTextKey; variant: string }>;

/** The words of the screen that more than one part needs: types, scopes, people and times. */
export function useSecretText() {
  const { t } = useText();
  return {
    type: (type: SecretKind) => t(TYPE_KEYS[type]),
    scope(
      scope: string,
      access: SecretAccess | undefined,
      agents: readonly WorkspaceMember[],
      spaces: readonly { id: string; name: string }[],
    ): string {
      const kind = secretScopeKind(scope);
      if (kind === "shared")
        return access && !access.everyone ? t("secrets.scope.sharedListed") : t("secrets.scope.shared");
      if (kind === "space") {
        const space = spaces.find((candidate) => `space:${candidate.id}` === scope);
        return space ? t("secrets.scope.space", { name: space.name }) : t("secrets.scope.unknownSpace");
      }
      const agent = agents.find((candidate) => candidate.id === scope);
      return agent ? t("secrets.scope.agent", { name: agent.name }) : t("secrets.scope.unknownAgent");
    },
    actor(actor: SecretActor | undefined, agents: readonly WorkspaceMember[]): string {
      if (!actor) return t("secrets.who.host");
      if (actor.kind === "agent") {
        const agent = agents.find((candidate) => candidate.id === actor.id);
        return agent?.name ?? actor.name ?? t("secrets.who.agent");
      }
      if (actor.kind === "owner") return actor.name ?? t("secrets.who.owner");
      if (actor.kind === "person") return actor.name ?? t("secrets.who.person");
      if (actor.kind === "routine") return actor.name ?? t("secrets.who.routine");
      return t("secrets.who.host");
    },
    ago(at: number, now = Date.now()): string {
      const { unit, count } = agoParts(at, now);
      if (unit === "now") return t("secrets.ago.now");
      if (unit === "minutes") return t("secrets.ago.minutes", { count });
      if (unit === "hours") return t("secrets.ago.hours", { count });
      if (unit === "days") return t("secrets.ago.days", { count });
      if (unit === "months") return t("secrets.ago.months", { count });
      return t("secrets.ago.years", { count });
    },
  };
}

/** The kind of a key as a small tinted tile. */
export function SecretTypeIcon(props: { type: SecretKind; size?: "md" | "lg" }): JSX.Element {
  return (
    <span class="sv-type-icon" data-type={props.type} data-size={props.size ?? "md"} aria-hidden="true">
      {props.type === "password" ? (
        <RectangleEllipsis />
      ) : props.type === "token" ? (
        <Ticket />
      ) : props.type === "code" ? (
        <Asterisk />
      ) : props.type === "other" ? (
        <LockKeyhole />
      ) : (
        <KeyRound />
      )}
    </span>
  );
}

/** The one state a key shows, the most urgent first. */
export function StatusBadge(props: { health: SecretHealth }): JSX.Element {
  const { t } = useText();
  return (
    <Badge class="sv-status" variant={HEALTH[props.health].variant} data-health={props.health}>
      {t(HEALTH[props.health].key)}
    </Badge>
  );
}
