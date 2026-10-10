import { supportedAttachmentExtensions } from "@openbot/contracts/attachment-files";
import { accountUsageCoversModel, canPreviewAttachment } from "@openbot/contracts/ipc";
import {
  TEAM_EML_ATTACHMENTS_CAPABILITY,
  TEAM_MEDIA_ATTACHMENTS_CAPABILITY,
  TEAM_TEXT_ATTACHMENTS_CAPABILITY,
} from "@openbot/contracts/team-protocol/current";
import {
  ArrowUp,
  Button,
  ConfirmDialog,
  DropdownMenu,
  File,
  Image,
  ImageRemoveButton,
  Input,
  LoaderCircle,
  Mic,
  Plus,
  Puzzle,
} from "@openbot/ui";
import { fileBadge } from "@openbot/ui/features/conversation/AttachmentCards";
import { attachmentReferenceTone } from "@openbot/ui/features/conversation/AttachmentReference";
import { AwaitingReplies } from "@openbot/ui/features/conversation/AwaitingReplies";
import { ComposerEditor } from "@openbot/ui/features/conversation/ComposerEditor";
import { ComposerErrorBanner } from "@openbot/ui/features/conversation/ComposerErrorBanner";
import {
  ComposerSignInNotice,
  ComposerUpdateNotice,
  ComposerUsageLimitNotice,
} from "@openbot/ui/features/conversation/ComposerNotice";
import { CloseIcon, StopIcon } from "@openbot/ui/features/conversation/ConversationIcons";
import { keepComposerFocusOnSendPress } from "@openbot/ui/features/conversation/composer-focus";
import { RichMessageText } from "@openbot/ui/features/conversation/RichMessageText";
import { SavedReplies } from "@openbot/ui/features/conversation/SavedReplies";
import { VoiceRecordingMorph } from "@openbot/ui/features/conversation/VoiceRecordingMorph";
import { useText } from "@openbot/ui/text";
import { createEffect, createMemo, createSignal, For, Loading, lazy, onCleanup, Show } from "solid-js";
import { reportErrorBanner, reportNotification } from "../../error-reports";
import { deviceSendShortcut, sendShortcutAriaKey, sendShortcutHintKey } from "../../send-shortcut-preference";
import { useConversationViewScope } from "./conversation-scope";
import { defaultSavedReplies, readSavedReplies, SAVED_REPLIES_STORAGE_KEY, writeSavedReplies } from "./saved-replies";
import { voiceButtonLabel, voiceSupported } from "./voice-status";

/** @internal Stable HMR boundary for conversation composer. */
export function ConversationComposer() {
  const {
    agentReady,
    providerUpdateRequired,
    attachmentAction,
    attachmentBusy,
    awaitingReplies,
    cancelQueuedMessageEdit,
    dismissAwaitingReplies,
    composerFocusRequest,
    composerHasContent,
    currentChatConversationKey,
    currentChatError,
    currentDraft,
    dismissCurrentChatErrors,
    installedSkills,
    installedSkillsLoadFailed,
    mcpServers,
    editQueuedMessage,
    editingDeliveryId,
    editingPendingSave,
    openAttachmentPicker,
    openAttachmentPickerFromKey,
    openExternalMessageUrl,
    presentedQueueDeliveries,
    previewAttachment,
    props,
    queuePanelVisible,
    removeAttachment,
    reorderPresentedQueue,
    replyTarget,
    sendSavedReply,
    setComposerFocusRequest,
    setAttachmentPickerElement,
    setShowComposerActions,
    showComposerActions,
    startVoiceRecording,
    stopVoiceRecording,
    cancelVoiceRecording,
    submitComposer,
    submitting,
    unreferencedDraftAttachments,
    updateCurrentDraft,
    updateTeamTyping,
    voiceElapsedSeconds,
    voiceLevels,
    voiceLiveText,
    voicePhase,
    voiceModelProgress,
  } = useConversationViewScope();
  const { t, format } = useText();
  const messageLabel = () =>
    props.agent?.name
      ? t("composer.placeholder.message", { name: props.agent.name })
      : t("composer.placeholder.messageAgent");
  const [pickerOpen, setPickerOpen] = createSignal(false);
  const [skillPickerRequest, setSkillPickerRequest] = createSignal(0);
  let skillPickerChosen = false;
  // A pending Save keeps its exact request for retry. Block changes until retry or cancel.
  const savePending = () => Boolean(editingDeliveryId() && editingPendingSave());
  const [deleteQueuedOpen, setDeleteQueuedOpen] = createSignal(false);
  /**
   * Save with nothing left to save cannot succeed, and failing without a word looks like a dead
   * button. It asks whether the person means to delete the queued message instead.
   */
  const submit = () => {
    const draft = currentDraft();
    const emptyEdit = !draft.text.trim() && draft.attachments.length === 0;
    if (editingDeliveryId() && !savePending() && voicePhase() === "idle" && emptyEdit) {
      setDeleteQueuedOpen(true);
      return;
    }
    submitComposer();
  };
  // The mention picker grows out of the same edge as the queue, so only one of them holds it.
  const queueVisible = () => queuePanelVisible() && !pickerOpen();
  const awaitingVisible = () => awaitingReplies().length > 0 && !pickerOpen();
  const slotOpen = () => queueVisible() || awaitingVisible();
  const voiceAvailable = () => !props.runtime && voiceSupported(props.platform);
  // The person's own list, or null while they keep the shipped replies. Another tab can change it.
  const [customReplies, setCustomReplies] = createSignal(readSavedReplies());
  const savedReplies = () => customReplies() ?? defaultSavedReplies(t);
  const syncSavedReplies = (event: StorageEvent) => {
    if (event.key === null || event.key === SAVED_REPLIES_STORAGE_KEY) setCustomReplies(readSavedReplies());
  };
  window.addEventListener("storage", syncSavedReplies);
  onCleanup(() => window.removeEventListener("storage", syncSavedReplies));
  const saveReplies = (replies: string[] | null) => {
    writeSavedReplies(replies);
    setCustomReplies(replies);
  };
  /** Send replaces Stop once the composer holds something; Stop then stands beside it instead. */
  const stopBesideSend = () => Boolean(editingDeliveryId()) || composerHasContent();
  /**
   * The messages "Stop and clear queue" cancels. The queue is cleared before the turn is stopped: the
   * turn that stops starts the next queued message as it ends, so a message left in the queue would
   * start the moment the user stopped the agent.
   */
  const stopAndClearQueue = async () => {
    const queued = presentedQueueDeliveries().filter((delivery) => delivery.status === "queued");
    await Promise.allSettled(queued.map((delivery) => props.onCancelQueuedMessage(delivery.id)));
    void props.onStop();
  };
  /**
   * The provider status is the only source of truth for a signed-out provider, so the notice and the
   * model picker's "Sign in required" label can never disagree, and the notice is shown before the
   * user sends rather than only after a request comes back 401.
   */
  const signInRequired = createMemo(() => {
    const provider = props.agent?.provider;
    if (!provider || !props.onSignInProvider) return null;
    // OpenCode is signed in by pasting a key in settings, not by a login this button can start, so
    // its notice would carry a button that does nothing. Every other provider opens its own OAuth.
    if (provider === "opencode") return null;
    const status = props.agentStatus.providers?.find((item) => item.id === provider);
    return status?.state === "sign-in-required" ? status : null;
  });
  /**
   * A window that ended gives the quota back, and the reading that named it stays as it was until
   * something asks the provider again. So the clock is part of the state, not only the percentage.
   */
  const [now, setNow] = createSignal(Date.now());
  /**
   * The first plan window that is spent and has not ended yet. `usedPercent` is what the provider
   * reports, so it can pass 100 slightly; anything at or over the line refuses the next turn.
   */
  const usageExhausted = createMemo(() => {
    const provider = props.agent?.provider;
    if (!provider || signInRequired() || !accountUsageCoversModel(provider, props.agent?.model)) return null;
    for (const limit of props.accountUsage?.limits ?? []) {
      if (limit.id !== provider) continue;
      for (const plan of [limit.primary, limit.secondary]) {
        if (!plan || plan.usedPercent < 100) continue;
        if (plan.resetsAt !== null && plan.resetsAt * 1_000 <= now()) continue;
        return { provider, resetsAt: plan.resetsAt };
      }
    }
    return null;
  });
  // The card has to leave on its own. Nothing else reads usage again until the next turn, and the
  // user waiting for the reset is the one least likely to send one.
  createEffect(
    () => usageExhausted()?.resetsAt ?? null,
    (resetsAt) => {
      if (resetsAt === null) return;
      const timer = window.setTimeout(() => setNow(Date.now()), Math.max(0, resetsAt * 1_000 - Date.now()));
      onCleanup(() => window.clearTimeout(timer));
    },
  );
  const attachmentAccept = () => {
    const server = props.server;
    const local = server?.kind !== "remote";
    const capabilities = server?.compatibility?.capabilities ?? [];
    return supportedAttachmentExtensions({
      eml: local || capabilities.includes(TEAM_EML_ATTACHMENTS_CAPABILITY),
      media: local || capabilities.includes(TEAM_MEDIA_ATTACHMENTS_CAPABILITY),
      text: local || capabilities.includes(TEAM_TEXT_ATTACHMENTS_CAPABILITY),
    })
      .map((extension) => `.${extension}`)
      .join(",");
  };
  /** Why the message box is off while the agent is not ready. The same words show as its placeholder. */
  const notReadyReason = () => {
    if (agentReady()) return undefined;
    if (props.agentsConnecting) return t("common.connecting");
    if (!props.runtime) return t("composer.placeholder.cliSetup");
    if (props.server?.state === "online") return t("composer.placeholder.hostSetup");
    if (props.server?.hostedSleep === "sleeping") return t("composer.placeholder.hostSleeping");
    if (props.server?.hostedSleep === "waking") return t("composer.placeholder.hostWaking");
    return t("composer.placeholder.connectHost");
  };
  /** Send, or Stop while the agent works and the message box is empty. */
  const SendControl = () => (
    <Show
      when={props.activeTurnId && !editingDeliveryId() && !composerHasContent() && voicePhase() !== "recording"}
      fallback={
        <Button
          variant="ghost"
          type="button"
          class="voice-button"
          aria-label={
            editingDeliveryId()
              ? t("composer.send.saveQueued")
              : voicePhase() === "recording"
                ? t("composer.send.voice")
                : t("composer.send.message")
          }
          aria-keyshortcuts={
            voicePhase() === "recording" ? undefined : sendShortcutAriaKey(deviceSendShortcut(props.platform))
          }
          title={
            voicePhase() === "recording"
              ? undefined
              : t(sendShortcutHintKey(deviceSendShortcut(props.platform), editingDeliveryId() ? "save" : "send"))
          }
          data-cuelume-emphasis="normal"
          disabled={
            attachmentBusy() ||
            submitting() ||
            !agentReady() ||
            Boolean(providerUpdateRequired()) ||
            voicePhase() === "preparing" ||
            voicePhase() === "requesting" ||
            voicePhase() === "transcribing"
          }
          onPointerDown={keepComposerFocusOnSendPress}
          onClick={submit}
        >
          <Show when={submitting()} fallback={<ArrowUp aria-hidden="true" />}>
            <LoaderCircle class="composer-spinner" aria-hidden="true" />
          </Show>
        </Button>
      }
    >
      <Button
        variant="ghost"
        type="button"
        class="voice-button voice-button-active"
        aria-label={t("composer.send.stop")}
        data-cuelume-tap="close"
        onClick={props.onStop}
      >
        <StopIcon />
      </Button>
    </Show>
  );
  return (
    <Show when={!props.approval && !props.browserTakeover}>
      <div class="composer-wrap">
        <div
          class="agent-queue-slot"
          data-open={slotOpen() ? "true" : "false"}
          aria-hidden={slotOpen() ? undefined : "true"}
          inert={slotOpen() ? undefined : true}
        >
          <div class="agent-queue-slot-inner">
            <Show when={awaitingVisible()}>
              <AwaitingReplies items={awaitingReplies()} onDismiss={dismissAwaitingReplies} />
            </Show>
            <Show when={queueVisible()}>
              <Loading>
                <QueuePanel
                  deliveries={presentedQueueDeliveries()}
                  // Only for an agent that is waiting. When the channel work is this agent's own,
                  // the activity line above already shows it working, and naming it twice reads as
                  // two different waits.
                  hold={props.queue?.hold?.agentId === props.agent?.id ? null : props.queue?.hold}
                  agents={props.agents}
                  skills={installedSkills()}
                  editingDeliveryId={editingDeliveryId()}
                  canSteer={Boolean(props.activeTurnId)}
                  onSteer={props.onSteerQueuedMessage}
                  onCancel={props.onCancelQueuedMessage}
                  onStopAndClear={props.activeTurnId ? stopAndClearQueue : undefined}
                  onEdit={editQueuedMessage}
                  onReorder={reorderPresentedQueue}
                />
              </Loading>
            </Show>
          </div>
        </div>
        <Show when={editingDeliveryId()}>
          <div class="composer-queue-edit">
            <p role="status">{t("composer.queueEdit.label")}</p>
            <Button
              variant="ghost"
              size="xs"
              type="button"
              aria-label={t("composer.queueEdit.cancelLabel")}
              disabled={submitting()}
              onClick={() => {
                void cancelQueuedMessageEdit();
                setComposerFocusRequest((current) => current + 1);
              }}
            >
              {t("common.cancel")}
            </Button>
          </div>
        </Show>
        <Show when={replyTarget()}>
          {(message) => (
            <div class="composer-reply-preview">
              <div>
                <span>{t(message().author === "you" ? "composer.reply.toYou" : "composer.reply.toAgent")}</span>
                <p>
                  <RichMessageText
                    body={message().body || t("composer.reply.attachment")}
                    agents={props.agents}
                    skills={installedSkills()}
                    attachments={message().attachments}
                    onSelectAgent={props.onSelectAgent}
                    onOpenLink={(url) => void openExternalMessageUrl(url)}
                    onOpenAttachment={(attachment) => void previewAttachment(attachment)}
                  />
                </p>
              </div>
              <Button
                variant="ghost"
                type="button"
                aria-label={t("composer.reply.cancel")}
                disabled={voicePhase() === "transcribing"}
                onClick={() => updateCurrentDraft({ replyToMessageId: null })}
              >
                <CloseIcon />
              </Button>
            </div>
          )}
        </Show>
        <Show when={providerUpdateRequired()}>
          {(status) => (
            <ComposerUpdateNotice
              provider={status().id}
              onUpdate={
                props.providerRuntimeStatuses?.[status().id]?.availableVersion ? props.onDownloadProvider : undefined
              }
              updating={
                props.providerRuntimeStatuses?.[status().id]?.phase === "downloading" ||
                props.providerRuntimeStatuses?.[status().id]?.phase === "finishing"
              }
            />
          )}
        </Show>
        <Show when={signInRequired()}>
          {(status) => (
            <ComposerSignInNotice
              provider={status().id}
              onShown={() =>
                reportNotification({
                  operation: "provider",
                  source: "provider",
                  cause_code: "authentication",
                  severity: "warning",
                  presentation: "banner",
                  provider: status().id,
                })
              }
              signingIn={status().connectionState === "connecting"}
              onSignIn={(provider) => props.onSignInProvider?.(provider)}
            />
          )}
        </Show>
        <Show when={usageExhausted()}>
          {(spent) => (
            <ComposerUsageLimitNotice
              provider={spent().provider}
              resetsAt={spent().resetsAt}
              onShown={() =>
                reportNotification({
                  operation: "turn",
                  source: "provider",
                  cause_code: "usage_limit",
                  severity: "error",
                  presentation: "banner",
                  provider: spent().provider,
                })
              }
            />
          )}
        </Show>
        <Show
          when={
            currentChatError() && currentChatError() !== providerUpdateRequired()?.message ? currentChatError() : null
          }
        >
          {(message) => (
            <ComposerErrorBanner
              message={message()}
              onShown={() => reportErrorBanner(message(), "turn")}
              conversationKey={currentChatConversationKey()}
              onDismiss={() => {
                dismissCurrentChatErrors();
                setComposerFocusRequest((current) => current + 1);
              }}
            />
          )}
        </Show>
        {/* One tap sends a reply, so the row shows only where Send would work: an idle agent chat with an empty message box. */}
        <Show
          when={
            props.agent &&
            agentReady() &&
            !composerHasContent() &&
            !editingDeliveryId() &&
            voicePhase() === "idle" &&
            !signInRequired() &&
            !providerUpdateRequired() &&
            !usageExhausted() &&
            !pickerOpen()
          }
        >
          <SavedReplies
            replies={savedReplies()}
            disabled={submitting() || attachmentBusy()}
            onSend={(reply) => void sendSavedReply(reply)}
            onChange={(replies) => saveReplies(replies)}
            onReset={customReplies() === null ? undefined : () => saveReplies(null)}
          />
        </Show>
        <div
          class="composer"
          data-compact={
            currentDraft().text.includes("\n") || unreferencedDraftAttachments().length > 0 ? undefined : ""
          }
          data-has-attachments={unreferencedDraftAttachments().length > 0 ? "" : undefined}
          onPointerDown={(event) => {
            if (!(event.target instanceof Element)) return;
            if (event.target.closest("button, .composer-editor-surface")) return;
            event.preventDefault();
            setComposerFocusRequest((current) => current + 1);
          }}
        >
          <Show when={unreferencedDraftAttachments().length > 0}>
            <div class="composer-attachments">
              <For each={unreferencedDraftAttachments()}>
                {(attachment) => {
                  // An image with no preview (the web client) shows as a file, with its name.
                  const chip = () => (attachment.kind === "image" && attachment.previewUrl ? "image" : "file");
                  return (
                    <div class="composer-attachment ui-removable-image" data-kind={chip()}>
                      <span
                        class="composer-attachment-preview"
                        data-file-tone={chip() === "file" ? attachmentReferenceTone(attachment.name) : undefined}
                      >
                        <Show when={chip() === "image"} fallback={fileBadge(attachment)}>
                          <img src={attachment.previewUrl ?? ""} alt="" />
                        </Show>
                      </span>
                      <Show when={chip() === "file"}>
                        <span class="composer-attachment-copy">
                          <strong title={attachment.name}>{attachment.name}</strong>
                          <small>{format.fileSize(attachment.size)}</small>
                        </span>
                      </Show>
                      <ImageRemoveButton
                        label={t("composer.attachment.remove", { name: attachment.name })}
                        disabled={voicePhase() === "transcribing" || savePending()}
                        onClick={() => removeAttachment(attachment.id)}
                      />
                    </div>
                  );
                }}
              </For>
            </div>
          </Show>
          <div
            class="composer-input-label"
            data-live-transcript={voiceLiveText() ? (currentDraft().text.trim() ? "append" : "replace") : undefined}
          >
            <ComposerEditor
              agentId={props.agent?.id}
              agents={props.agents}
              skills={installedSkills()}
              skillsLoadFailed={installedSkillsLoadFailed()}
              mcpServers={mcpServers()}
              attachments={currentDraft().attachments}
              value={currentDraft().text}
              disabled={submitting() || voicePhase() === "transcribing" || !agentReady() || savePending()}
              placeholder={notReadyReason() ?? (replyTarget() ? t("composer.placeholder.reply") : messageLabel())}
              disabledReason={notReadyReason()}
              ariaLabel={messageLabel()}
              focusRequest={composerFocusRequest()}
              skillPickerRequest={skillPickerRequest()}
              onValueChange={(text) => {
                updateCurrentDraft({ text });
                updateTeamTyping(text);
              }}
              onSubmit={submit}
              sendShortcut={deviceSendShortcut(props.platform)}
              onPickerOpenChange={setPickerOpen}
              onPasteFiles={(files) => {
                if (props.runtime?.importFiles) void props.runtime.importFiles(files);
              }}
              onOpenAttachment={(attachment) =>
                canPreviewAttachment(attachment)
                  ? void previewAttachment(attachment)
                  : attachmentAction(attachment, "open")
              }
            />
            <Show when={voiceLiveText()}>
              {(text) => (
                <p
                  class="voice-live-transcript"
                  aria-live="polite"
                  data-final={voicePhase() === "transcribing" ? "" : undefined}
                >
                  {text()}
                </p>
              )}
            </Show>
          </div>
          <div class="composer-toolbar">
            <Input
              ref={setAttachmentPickerElement}
              type="file"
              accept={attachmentAccept()}
              multiple
              hidden
              tabindex={-1}
              data-openbot-attachment-picker={props.runtime ? undefined : "true"}
              onChange={(event) => {
                if (props.runtime?.importFiles)
                  void props.runtime.importFiles(Array.from(event.currentTarget.files ?? []));
              }}
            />
            <DropdownMenu.Root
              open={showComposerActions()}
              onOpenChange={(open) => {
                setShowComposerActions(open);
                const chosen = skillPickerChosen;
                skillPickerChosen = false;
                if (open || !chosen) return;
                // The menu gives the focus back to its trigger two frames after it closes; open the picker after that.
                requestAnimationFrame(() =>
                  requestAnimationFrame(() =>
                    requestAnimationFrame(() => setSkillPickerRequest((current) => current + 1)),
                  ),
                );
              }}
              placement="top-start"
              gutter={8}
              modal={false}
            >
              <DropdownMenu.Trigger
                class="composer-button"
                aria-label={t("composer.add.label")}
                disabled={
                  attachmentBusy() || submitting() || voicePhase() === "transcribing" || !agentReady() || savePending()
                }
              >
                <Plus aria-hidden="true" />
              </DropdownMenu.Trigger>
              <DropdownMenu.Portal>
                <DropdownMenu.Content aria-label={t("composer.add.label")}>
                  <DropdownMenu.Item
                    disabled={attachmentBusy()}
                    onPointerDown={(event) => {
                      if (event.button === 0) openAttachmentPicker();
                    }}
                    onKeyDown={(event) => openAttachmentPickerFromKey(event)}
                  >
                    <Image aria-hidden="true" />
                    <span>{t("composer.add.image")}</span>
                  </DropdownMenu.Item>
                  <DropdownMenu.Item
                    onPointerDown={(event) => {
                      if (event.button === 0) skillPickerChosen = true;
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") skillPickerChosen = true;
                    }}
                  >
                    <Puzzle aria-hidden="true" />
                    <span>{t("composer.add.skill")}</span>
                  </DropdownMenu.Item>
                  <DropdownMenu.Item
                    disabled={attachmentBusy()}
                    onPointerDown={(event) => {
                      if (event.button === 0) openAttachmentPicker();
                    }}
                    onKeyDown={(event) => openAttachmentPickerFromKey(event)}
                  >
                    <File aria-hidden="true" />
                    <span>{t("composer.add.context")}</span>
                  </DropdownMenu.Item>
                </DropdownMenu.Content>
              </DropdownMenu.Portal>
            </DropdownMenu.Root>
            <div class="composer-primary-actions">
              <Show when={attachmentBusy() && props.runtime?.cancelImportFiles} keyed>
                {(cancelImportFiles) => (
                  <Button variant="ghost" type="button" onClick={() => void cancelImportFiles()}>
                    {t("composer.upload.cancel")}
                  </Button>
                )}
              </Show>
              <Show when={voiceAvailable() && voicePhase() === "preparing"}>
                <span class="voice-model-progress" role="status">
                  {t("composer.voice.progress", { progress: voiceModelProgress() ?? 0 })}
                </span>
              </Show>
              <Show when={props.activeTurnId && voicePhase() !== "recording" && stopBesideSend()}>
                {/* Stop stays reachable while the user types a steering message, next to Send. */}
                <Button
                  variant="ghost"
                  type="button"
                  class="voice-button voice-button-active"
                  aria-label={t("composer.send.stop")}
                  data-cuelume-tap="close"
                  onClick={props.onStop}
                >
                  <StopIcon />
                </Button>
              </Show>
              <Show when={voiceAvailable()} fallback={<SendControl />}>
                <VoiceRecordingMorph
                  recording={voicePhase() === "recording"}
                  levels={voiceLevels()}
                  elapsedSeconds={voiceElapsedSeconds()}
                  onCancel={cancelVoiceRecording}
                  onFinish={stopVoiceRecording}
                  send={<SendControl />}
                >
                  <Button
                    variant="ghost"
                    type="button"
                    class="dictation-button"
                    aria-label={t(voiceButtonLabel(voicePhase()))}
                    disabled={
                      voicePhase() === "requesting" ||
                      voicePhase() === "preparing" ||
                      voicePhase() === "transcribing" ||
                      (voicePhase() === "idle" && (!props.agent || !agentReady()))
                    }
                    onClick={() => void startVoiceRecording()}
                  >
                    <Show
                      when={
                        voicePhase() === "preparing" || voicePhase() === "requesting" || voicePhase() === "transcribing"
                      }
                      fallback={<Mic aria-hidden="true" />}
                    >
                      <LoaderCircle class="composer-spinner" aria-hidden="true" />
                    </Show>
                  </Button>
                </VoiceRecordingMorph>
              </Show>
            </div>
          </div>
        </div>
        <ConfirmDialog
          open={deleteQueuedOpen()}
          onCancel={() => setDeleteQueuedOpen(false)}
          onConfirm={() => {
            const deliveryId = editingDeliveryId();
            setDeleteQueuedOpen(false);
            if (deliveryId) void props.onCancelQueuedMessage(deliveryId);
          }}
          title={t("composer.queueEdit.deleteTitle")}
          description={t("composer.queueEdit.deleteBody")}
          confirmLabel={t("common.delete")}
          cancelLabel={t("composer.queueEdit.keep")}
          initialFocus="cancel"
        />
      </div>
    </Show>
  );
}

const QueuePanel = lazy(() =>
  import("@openbot/ui/features/conversation/QueuePanel").then((module) => ({ default: module.QueuePanel })),
);
