import type { AvatarImageInput, CentralAuthUser } from "@openbot/contracts/ipc";
import { Button, Field, FormDialog, ImageRemoveButton, Input, Pencil, UserAvatar } from "@openbot/ui";
import { createSignal, Show } from "solid-js";
import { useText } from "../../text";
import { blobDataUrl } from "./ProfileShareDialog";
import type { SettingsProfileStore } from "./stores/profile-store";

/** A new photo, or `null` to remove the photo. `undefined` keeps the saved photo. */
interface PhotoDraft {
  image: AvatarImageInput | null;
  url: string | null;
}

/**
 * The photo and the display name, saved together. The caller resets the store's name draft and
 * photo error before it opens the dialog, so each open starts again from the saved profile.
 */
export function ProfileEditDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  store: SettingsProfileStore;
  account: CentralAuthUser;
}) {
  const { t, errorMessage } = useText();
  const [photo, setPhoto] = createSignal<PhotoDraft | undefined>();
  const [photoBusy, setPhotoBusy] = createSignal(false);
  const [photoError, setPhotoError] = createSignal<string | null>(null);
  let photoInput: HTMLInputElement | undefined;
  const close = () => props.onOpenChange(false);

  const preview = () => {
    const draft = photo();
    return draft === undefined ? props.account : { ...props.account, avatarUrl: draft.url };
  };
  const busy = () => photoBusy() || props.store.state.avatar.busy || props.store.state.profile.busy;

  async function pickPhoto(file: File | undefined) {
    if (!file) return;
    setPhotoBusy(true);
    setPhotoError(null);
    try {
      const image = await props.store.processAvatarFile(file);
      setPhoto({ image, url: await blobDataUrl(new Blob([image.bytes.slice()], { type: image.mimeType })) });
    } catch (cause) {
      setPhotoError(errorMessage(cause, t("settings.profile.photo.processFailed")));
    } finally {
      setPhotoBusy(false);
      if (photoInput) photoInput.value = "";
    }
  }

  async function save() {
    if (busy()) return;
    // The name saves first: a new photo refreshes the account, and the refresh resets the name draft.
    await props.store.saveName();
    if (props.store.visibleNameError()) return;
    const draft = photo();
    if (draft !== undefined) {
      await props.store.updateAvatar(draft.image);
      if (props.store.state.avatar.error) return;
      setPhoto(undefined);
    }
    close();
  }

  return (
    <FormDialog
      open={props.open}
      size="sm"
      onOpenChange={(open) => {
        if (!open) {
          // Each open starts again from the saved profile.
          setPhoto(undefined);
          setPhotoError(null);
        }
        props.onOpenChange(open);
      }}
      title={t("settings.profile.edit.title")}
      error={photoError() ?? props.store.state.avatar.error}
      busy={busy()}
      submitLabel={t("common.save")}
      onSubmit={() => void save()}
    >
      <div class="profile-edit-photo">
        <div class="settings-identity-image-picker ui-removable-image">
          <Button
            type="button"
            variant="outline"
            size="icon-lg"
            class="settings-identity-image-trigger settings-modal-profile-photo-trigger profile-edit-photo-trigger"
            aria-label={preview().avatarUrl ? t("settings.profile.photo.edit") : t("settings.profile.photo.add")}
            disabled={busy()}
            onClick={() => photoInput?.click()}
          >
            <UserAvatar user={preview()} class="settings-modal-avatar profile-edit-avatar" decorative />
            <span class="profile-edit-photo-badge" aria-hidden="true">
              <Pencil />
            </span>
          </Button>
          <Show when={preview().avatarUrl && !busy()}>
            <ImageRemoveButton
              label={t("settings.profile.photo.remove")}
              onClick={() => setPhoto({ image: null, url: null })}
            />
          </Show>
        </div>
        <Input
          ref={(element) => {
            photoInput = element;
          }}
          class="sr-only"
          type="file"
          aria-label={t("settings.profile.photo.upload")}
          accept="image/png,image/jpeg,image/gif,image/webp"
          onChange={(event) => void pickPhoto(event.currentTarget.files?.[0])}
        />
      </div>
      <Field
        label={t("settings.profile.name.title")}
        description={t("settings.profile.name.description")}
        error={props.store.visibleNameError() ?? undefined}
      >
        <Input
          ref={(element) => props.store.registerNameInput(element)}
          value={props.store.state.profile.name}
          autocomplete="name"
          onValueChange={props.store.updateName}
          onBlur={props.store.markTouchedIfDirty}
        />
      </Field>
    </FormDialog>
  );
}
