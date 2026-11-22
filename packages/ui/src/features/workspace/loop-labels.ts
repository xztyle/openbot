import type { LoopExperimentStatus, LoopGateKind, LoopOutcome } from "@openbot/contracts/ipc";
import type { AppTextKey } from "@openbot/i18n";

// The keys are literals so that the i18n check and a search find them.

export const LOOP_GATE_LABEL = {
  money: "workspace.loops.gate.money",
  publish: "workspace.loops.gate.publish",
  decision: "workspace.loops.gate.decision",
} as const satisfies Record<LoopGateKind, AppTextKey>;

export const LOOP_OUTCOME_LABEL = {
  done: "workspace.loops.outcome.done",
  won: "workspace.loops.outcome.won",
  lost: "workspace.loops.outcome.lost",
  killed: "workspace.loops.outcome.killed",
} as const satisfies Record<LoopOutcome, AppTextKey>;

export const LOOP_EXPERIMENT_LABEL = {
  proposed: "workspace.loops.experiment.proposed",
  approved: "workspace.loops.experiment.approved",
  running: "workspace.loops.experiment.running",
  done: "workspace.loops.experiment.done",
  rejected: "workspace.loops.experiment.rejected",
  cancelled: "workspace.loops.experiment.cancelled",
} as const satisfies Record<LoopExperimentStatus, AppTextKey>;
