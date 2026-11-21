import type { LoopGateKind } from "@openbot/contracts/ipc";
import type { JSX } from "@solidjs/web";
import { Match, Switch } from "solid-js";
import { CircleDollarSign, Megaphone, ShieldCheck } from "../../icons";

/** The mark of a gate: money, publish or another decision. */
export function GateIcon(props: { kind: LoopGateKind }): JSX.Element {
  return (
    <Switch>
      <Match when={props.kind === "money"}>
        <CircleDollarSign aria-hidden="true" />
      </Match>
      <Match when={props.kind === "publish"}>
        <Megaphone aria-hidden="true" />
      </Match>
      <Match when={props.kind === "decision"}>
        <ShieldCheck aria-hidden="true" />
      </Match>
    </Switch>
  );
}
