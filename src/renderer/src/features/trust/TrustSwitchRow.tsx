import { SettingsRow, Switch } from "@openbot/ui";

/**
 * A choice of the Trust view that the save bar stores with the rest of its policy: a settings row
 * whose label turns the switch.
 */
export function TrustSwitchRow(props: {
  id: string;
  label: string;
  description?: string | undefined;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <SettingsRow layout="inline" label={props.label} description={props.description} controlId={props.id}>
      <Switch id={props.id} aria-label={props.label} checked={props.checked} onChange={props.onChange} />
    </SettingsRow>
  );
}
