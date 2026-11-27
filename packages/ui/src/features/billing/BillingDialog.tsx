import { FormDialog } from "@openbot/ui";
import type { JSX } from "@solidjs/web";
import { useText } from "../../text";
import type { SettingsHostedServersStore } from "../settings/stores/hosted-servers-store";
import { BillingPanel } from "./BillingPanel";
import type { BillingStore } from "./billing-store";

export interface BillingDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  store: BillingStore;
  /** The hosted servers of the account. A server whose plan ended is renewed or deleted here. */
  hostedServers?: SettingsHostedServersStore | undefined;
  /** The License part, above the server plans. */
  license?: JSX.Element;
}

/**
 * The Billing panel in the shared form dialog, for the web client, which has no Billing settings. It
 * has no footer: each plan acts from its own row.
 */
export function BillingDialog(props: BillingDialogProps): JSX.Element {
  const { t } = useText();
  return (
    <FormDialog
      open={props.open}
      onOpenChange={props.onOpenChange}
      size="lg"
      class="billing-dialog"
      title={t("billing.title")}
      description={t("billing.description")}
    >
      <BillingPanel store={props.store} available hostedServers={props.hostedServers} license={props.license} />
    </FormDialog>
  );
}
