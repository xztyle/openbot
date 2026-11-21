/*
 * Server settings > Workspace > Integrations · Motion events: whether the ticket events of the Motion
 * board wake the agents, which due-date warnings reach them, who hears of an overdue ticket, the Needs
 * you item of a ticket that waits on the owner, the quiet hours and the burst window.
 */
import { MOTION_WARN_HOURS, type WorkspaceMotionEventsSettings } from "@openbot/contracts/ipc";
import { useText } from "@openbot/ui/text";
import { ChoiceRow } from "./settings-choice-row";

const WARN_PRESETS = ["24,2", "48,24,2", "24", "2", "none"] as const;
const QUIET_PRESETS = ["off", "22-7", "23-7", "0-8", "21-8"] as const;
const BURST_PRESETS = [5, 15, 30, 60] as const;

export function sameMotionEvents(left: WorkspaceMotionEventsSettings, right: WorkspaceMotionEventsSettings): boolean {
  return (
    left.enabled === right.enabled &&
    left.warnHours.join(",") === right.warnHours.join(",") &&
    left.overdueToManager === right.overdueToManager &&
    left.waitingToNeedsYou === right.waitingToNeedsYou &&
    left.quietHours.enabled === right.quietHours.enabled &&
    left.quietHours.start === right.quietHours.start &&
    left.quietHours.end === right.quietHours.end &&
    left.burstMinutes === right.burstMinutes
  );
}

function warnValue(settings: WorkspaceMotionEventsSettings): string {
  return settings.warnHours.length ? settings.warnHours.join(",") : "none";
}

function quietValue(settings: WorkspaceMotionEventsSettings): string {
  return settings.quietHours.enabled ? `${settings.quietHours.start}-${settings.quietHours.end}` : "off";
}

function hourText(hour: number): string {
  return `${String(hour).padStart(2, "0")}:00`;
}

export function MotionEventsRows(props: {
  settings: WorkspaceMotionEventsSettings;
  disabled: boolean;
  menuMount: HTMLElement | undefined;
  onChange: (change: (settings: WorkspaceMotionEventsSettings) => void) => void;
}) {
  const { t } = useText();
  const off = () => props.disabled || !props.settings.enabled;
  const withCurrent = (presets: readonly string[], value: string) => [...new Set([...presets, value])];
  const warnLabel = (value: string) =>
    value === "none"
      ? t("server.settings.motionWarnNone")
      : t("server.settings.motionWarnHours", { hours: value.split(",").join(" h, ") });
  const quietLabel = (value: string) => {
    if (value === "off") return t("server.settings.motionQuietOff");
    const [start, end] = value.split("-").map(Number);
    return `${hourText(start ?? 0)}–${hourText(end ?? 0)}`;
  };
  return (
    <>
      <ChoiceRow
        id="server-settings-motion-events"
        title={t("server.settings.motionEvents")}
        hint={t("server.settings.motionEventsHint")}
        options={["on", "off"]}
        value={props.settings.enabled ? "on" : "off"}
        label={(value) => (value === "on" ? t("server.settings.motionOn") : t("server.settings.motionOff"))}
        disabled={props.disabled}
        menuMount={props.menuMount}
        onChange={(value) =>
          props.onChange((settings) => {
            settings.enabled = value === "on";
          })
        }
      />
      <ChoiceRow
        id="server-settings-motion-warn"
        title={t("server.settings.motionWarn")}
        hint={t("server.settings.motionWarnHint")}
        options={withCurrent(WARN_PRESETS, warnValue(props.settings))}
        value={warnValue(props.settings)}
        label={warnLabel}
        disabled={off()}
        menuMount={props.menuMount}
        onChange={(value) =>
          props.onChange((settings) => {
            settings.warnHours =
              value === "none"
                ? []
                : value
                    .split(",")
                    .map(Number)
                    .filter((hours) => MOTION_WARN_HOURS.some((allowed) => allowed === hours));
          })
        }
      />
      <ChoiceRow
        id="server-settings-motion-overdue"
        title={t("server.settings.motionOverdue")}
        hint={t("server.settings.motionOverdueHint")}
        options={["manager", "assignee"]}
        value={props.settings.overdueToManager ? "manager" : "assignee"}
        label={(value) =>
          value === "manager" ? t("server.settings.motionOverdueManager") : t("server.settings.motionOverdueAssignee")
        }
        disabled={off()}
        menuMount={props.menuMount}
        onChange={(value) =>
          props.onChange((settings) => {
            settings.overdueToManager = value === "manager";
          })
        }
      />
      <ChoiceRow
        id="server-settings-motion-waiting"
        title={t("server.settings.motionWaiting")}
        hint={t("server.settings.motionWaitingHint")}
        options={["on", "off"]}
        value={props.settings.waitingToNeedsYou ? "on" : "off"}
        label={(value) => (value === "on" ? t("server.settings.motionWaitingOn") : t("server.settings.motionOff"))}
        disabled={off()}
        menuMount={props.menuMount}
        onChange={(value) =>
          props.onChange((settings) => {
            settings.waitingToNeedsYou = value === "on";
          })
        }
      />
      <ChoiceRow
        id="server-settings-motion-quiet"
        title={t("server.settings.motionQuiet")}
        hint={t("server.settings.motionQuietHint")}
        options={withCurrent(QUIET_PRESETS, quietValue(props.settings))}
        value={quietValue(props.settings)}
        label={quietLabel}
        disabled={off()}
        menuMount={props.menuMount}
        onChange={(value) =>
          props.onChange((settings) => {
            const [start, end] = value.split("-").map(Number);
            settings.quietHours =
              value === "off"
                ? { ...settings.quietHours, enabled: false }
                : { enabled: true, start: start ?? 23, end: end ?? 7 };
          })
        }
      />
      <ChoiceRow
        id="server-settings-motion-burst"
        title={t("server.settings.motionBurst")}
        hint={t("server.settings.motionBurstHint")}
        options={withCurrent(BURST_PRESETS.map(String), String(props.settings.burstMinutes))}
        value={String(props.settings.burstMinutes)}
        label={(value) => t("server.settings.motionBurstMinutes", { minutes: value })}
        disabled={off()}
        menuMount={props.menuMount}
        onChange={(value) =>
          props.onChange((settings) => {
            settings.burstMinutes = Number(value);
          })
        }
      />
    </>
  );
}
