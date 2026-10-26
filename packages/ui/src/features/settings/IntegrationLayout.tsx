/**
 * The parts that every integration page shares: the logo on its tile, the status pill, the page
 * header, the danger zone, and the connect dialog with OpenBot and the other app side by side.
 * GitHub, Slack, Discord and Telegram use them.
 */

import { AppLogo } from "@openbot/brand";
import type { AppTextKey } from "@openbot/i18n";
import {
  Alert,
  AlertActions,
  AlertContent,
  AlertDescription,
  AlertIcon,
  AlertTitle,
  Badge,
  Button,
  Check,
  ConfirmDialog,
  Dialog,
  Heading,
  IconButton,
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle,
  SettingsSection,
  Text,
  TriangleAlert,
  X,
} from "@openbot/ui";
import type { JSX } from "@solidjs/web";
import { createSignal, For, Show } from "solid-js";
import { useText } from "../../text";

/** A logo on a quiet square. `size` "lg" is the page header. */
export function LogoTile(props: { children: JSX.Element; size?: "md" | "lg" }) {
  return (
    <span class="integration-logo-tile" data-size={props.size ?? "md"}>
      {props.children}
    </span>
  );
}

/** `connecting` is a sign-in that waits for the user, in a browser or another app. */
export type IntegrationStatus = "connected" | "attention" | "connecting" | "idle" | "unavailable";

const STATUS_VARIANT = {
  connected: "success-light",
  attention: "warning-light",
  connecting: "secondary",
  idle: "secondary",
  unavailable: "outline",
} as const satisfies Record<IntegrationStatus, string>;

export function StatusPill(props: { status: IntegrationStatus; label: string }) {
  return (
    <Badge class="integration-status" variant={STATUS_VARIANT[props.status]} data-status={props.status}>
      <span class="integration-status-dot" aria-hidden="true" />
      {props.label}
    </Badge>
  );
}

/**
 * The status of a connection that OpenBot could not read. It is not "Not set up": the connection can
 * be there. The page says why the read failed and has Retry.
 */
export const UNKNOWN_STATUS = {
  status: "attention",
  label: "connector.statusUnknown",
} as const satisfies { status: IntegrationStatus; label: AppTextKey };

/** A read of a connection that failed: why, and Retry. `message` is the reason in the reader's language. */
export function ReadFailedAlert(props: { message: string; onRetry?: (() => void) | undefined }) {
  const { t } = useText();
  const title = () => t("connector.readFailed");
  return (
    <Alert tone="warning" role="alert">
      <AlertIcon>
        <TriangleAlert />
      </AlertIcon>
      <AlertContent>
        <AlertTitle>{title()}</AlertTitle>
        <Show when={props.message !== title()}>
          <AlertDescription>{props.message}</AlertDescription>
        </Show>
      </AlertContent>
      <Show when={props.onRetry}>
        {(retry) => (
          <AlertActions>
            <Button type="button" size="sm" variant="outline" onClick={() => retry()()}>
              {t("common.retry")}
            </Button>
          </AlertActions>
        )}
      </Show>
    </Alert>
  );
}

/** The top of an integration page: the logo, the name with its status, what it gives, and its action. */
export function DetailHeader(props: {
  logo: JSX.Element;
  name: string;
  status: IntegrationStatus;
  statusLabel: string;
  subtitle: JSX.Element;
  actions?: JSX.Element;
}) {
  return (
    <div class="integration-detail-header">
      <LogoTile size="lg">{props.logo}</LogoTile>
      <div class="integration-detail-copy">
        <div class="integration-detail-title">
          <Heading as="h3" size="md">
            {props.name}
          </Heading>
          {/* An empty label is a page with no status to claim. */}
          <Show when={props.statusLabel}>
            <StatusPill status={props.status} label={props.statusLabel} />
          </Show>
        </div>
        <Text variant="caption" tone="muted">
          {props.subtitle}
        </Text>
      </div>
      <Show when={props.actions}>
        <div class="integration-detail-actions">{props.actions}</div>
      </Show>
    </div>
  );
}

export function DangerZone(props: {
  title: string;
  description: string;
  action: string;
  busy?: boolean;
  /** Ask before the action, in a dialog with the same title, description and action. */
  confirm?: boolean;
  onAction: () => void;
}) {
  const { t } = useText();
  const [confirming, setConfirming] = createSignal(false);
  return (
    <SettingsSection title={t("connector.dangerZone")}>
      <ItemGroup class="settings-modal-card">
        <Item class="settings-modal-row">
          <ItemContent>
            <ItemTitle>{props.title}</ItemTitle>
            <ItemDescription>{props.description}</ItemDescription>
          </ItemContent>
          <ItemActions>
            <Button
              type="button"
              size="sm"
              variant="destructive-ghost"
              loading={props.busy ?? false}
              onClick={() => (props.confirm ? setConfirming(true) : props.onAction())}
            >
              {props.action}
            </Button>
          </ItemActions>
        </Item>
      </ItemGroup>
      <Show when={props.confirm}>
        <ConfirmDialog
          open={confirming()}
          initialFocus="cancel"
          title={props.title}
          description={props.description}
          confirmLabel={props.action}
          onCancel={() => setConfirming(false)}
          onConfirm={() => {
            setConfirming(false);
            props.onAction();
          }}
        />
      </Show>
    </SettingsSection>
  );
}

/** Numbered steps. Only the numbers show: the dialog title names the step, and readers hear each label. */
export function Stepper(props: { steps: readonly string[]; current: number; label: string }) {
  return (
    <ol class="integration-stepper" aria-label={props.label}>
      <For each={props.steps}>
        {(step, index) => {
          const state = () => (index() < props.current ? "done" : index() === props.current ? "current" : "next");
          return (
            <li class="integration-step" data-state={state()} aria-current={state() === "current" ? "step" : undefined}>
              <span class="integration-step-index" aria-hidden="true">
                <Show when={state() === "done"} fallback={index() + 1}>
                  <Check size={12} />
                </Show>
              </span>
              <span class="sr-only">{step}</span>
            </li>
          );
        }}
      </For>
    </ol>
  );
}

/** The line between OpenBot and the other app: moving while connecting, solid when done, broken on an error. */
export type WizardLink = "connecting" | "connected" | "broken";

export interface WizardProps {
  logo: JSX.Element;
  link?: WizardLink;
  title: string;
  description: JSX.Element;
  stepper?: JSX.Element;
  children?: JSX.Element;
  footer: JSX.Element;
}

/** The body of a connect dialog. `heading` is the title element, so a dialog can give its own. */
export function WizardContent(props: WizardProps & { heading: JSX.Element }) {
  return (
    <>
      <div class="integration-wizard-head">
        <div class="integration-wizard-logos" data-link={props.link ?? "connecting"} aria-hidden="true">
          <AppLogo variant="production" animation="blink" class="integration-wizard-app" />
          <span class="integration-wizard-link" />
          <span class="integration-wizard-target">
            <LogoTile>{props.logo}</LogoTile>
          </span>
        </div>
        {props.stepper}
        {props.heading}
        <Text variant="body-sm" tone="muted">
          {props.description}
        </Text>
      </div>
      <Show when={props.children}>
        <div class="integration-wizard-body">{props.children}</div>
      </Show>
      <div class="integration-wizard-foot">{props.footer}</div>
    </>
  );
}

/**
 * A connect dialog over the settings window. With `dismissible` false, a click outside does not close
 * it: the user may come back from the browser while a flow runs, and that click must not stop the flow.
 */
export function WizardDialog(
  props: WizardProps & { open: boolean; closeLabel: string; dismissible?: boolean; onClose: () => void },
) {
  return (
    <Dialog.Root
      open={props.open}
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay class="integration-dialog-backdrop" />
        <Dialog.Content
          class="integration-wizard integration-wizard-dialog"
          as="section"
          onInteractOutside={(event) => {
            if (props.dismissible === false) event.preventDefault();
          }}
        >
          <WizardContent
            {...props}
            description={<Dialog.Description as="span">{props.description}</Dialog.Description>}
            heading={
              <Dialog.Title as="h2" class="ui-heading" data-size="md" data-tone="primary">
                {props.title}
              </Dialog.Title>
            }
          />
          <IconButton
            class="integration-dialog-close"
            label={props.closeLabel}
            variant="ghost"
            data-cuelume-tap="close"
            onClick={props.onClose}
          >
            <X />
          </IconButton>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
