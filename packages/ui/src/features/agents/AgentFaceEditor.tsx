import { FACE_STYLES, rerollSeed, SKIN_TONES } from "@openbot/brand/faces";
import { AGENT_FACE_SKINS, type AgentFaceSkin, type AgentFaceStyle } from "@openbot/contracts/agent-face";
import type { AppTextKey } from "@openbot/i18n";
import { For, Show } from "solid-js";
import { Button, IconButton } from "../../button";
import { RefreshCw, RotateCcw } from "../../icons";
import { useText } from "../../text";
import { AgentFace } from "./AgentFace";

const FAMILY_TEXT = {
  portrait: "server.settings.facesPortrait",
  sketch: "server.settings.facesSketch",
  flat: "server.settings.facesFlat",
  clay: "server.settings.facesClay",
  character: "server.settings.facesCharacter",
} as const satisfies Record<AgentFaceStyle, AppTextKey>;

export interface AgentFaceChoice {
  faceStyle: AgentFaceStyle | null;
  faceSeed: string | null;
  faceSkin: AgentFaceSkin | null;
}

export interface AgentFaceEditorProps {
  /** The agent's avatar seed: the person of the face. */
  seed: string;
  name: string;
  title?: string | undefined;
  faceStyle?: AgentFaceStyle | undefined;
  faceSeed?: string | undefined;
  faceSkin?: AgentFaceSkin | undefined;
  disabled?: boolean;
  /** Saves a change. `null` returns that part of the face to the workspace default. */
  onChange: (change: Partial<AgentFaceChoice>) => void;
}

/** The number of the re-roll in a face seed of `rerollSeed`, 0 for none. */
function rerollNumber(seed: string, faceSeed: string | undefined): number {
  if (!faceSeed?.startsWith(`${seed}#`)) return 0;
  const value = Number(faceSeed.slice(seed.length + 1));
  return Number.isSafeInteger(value) && value > 0 ? value : 0;
}

/**
 * Change face: the agent's own face family, a new face (a re-roll of the same agent) and its skin
 * tone. Each choice saves at once; Reset returns all of them to the workspace's face.
 */
export function AgentFaceEditor(props: AgentFaceEditorProps) {
  const { t } = useText();
  const custom = () => Boolean(props.faceStyle || props.faceSeed || props.faceSkin);
  return (
    <>
      <div class="avatar-editor-heading">
        <span>{t("agentSettings.face.title")}</span>
        <div class="avatar-editor-actions">
          <Show when={custom()}>
            <IconButton
              variant="outline"
              type="button"
              label={t("agentSettings.face.reset")}
              disabled={props.disabled}
              onClick={() => props.onChange({ faceStyle: null, faceSeed: null, faceSkin: null })}
            >
              <RotateCcw aria-hidden="true" />
            </IconButton>
          </Show>
          <IconButton
            variant="outline"
            type="button"
            label={t("agentSettings.face.newFace")}
            disabled={props.disabled}
            onClick={() =>
              props.onChange({ faceSeed: rerollSeed(props.seed, rerollNumber(props.seed, props.faceSeed) + 1) })
            }
          >
            <RefreshCw aria-hidden="true" />
          </IconButton>
        </div>
      </div>
      <fieldset class="avatar-face-grid" aria-label={t("agentSettings.face.family")}>
        <For each={FACE_STYLES}>
          {(family) => (
            <Button
              variant="ghost"
              type="button"
              class={["avatar-face-choice", { "avatar-choice-selected": props.faceStyle === family }]}
              aria-label={t(FAMILY_TEXT[family])}
              aria-pressed={props.faceStyle === family ? "true" : "false"}
              disabled={props.disabled}
              onClick={() => props.onChange({ faceStyle: props.faceStyle === family ? null : family })}
            >
              <AgentFace
                id={props.seed}
                name={props.name}
                title={props.title}
                faceStyle={family}
                faceSeed={props.faceSeed}
                faceSkin={props.faceSkin}
                class="agent-avatar agent-avatar-face"
              />
            </Button>
          )}
        </For>
      </fieldset>
      <div class="avatar-editor-heading">
        <span>{t("agentSettings.face.skin")}</span>
      </div>
      <fieldset class="avatar-color-grid" aria-label={t("agentSettings.face.skin")}>
        <Button
          variant="ghost"
          type="button"
          class={["avatar-color-choice", { "avatar-choice-selected": !props.faceSkin }]}
          aria-label={t("agentSettings.face.workspaceSkin")}
          aria-pressed={props.faceSkin ? "false" : "true"}
          disabled={props.disabled}
          onClick={() => props.onChange({ faceSkin: null })}
        >
          <span class="avatar-color-swatch avatar-color-swatch-auto">{t("agentSettings.avatar.autoInitial")}</span>
        </Button>
        <For each={AGENT_FACE_SKINS}>
          {(tone, index) => (
            <Button
              variant="ghost"
              type="button"
              class={["avatar-color-choice", { "avatar-choice-selected": props.faceSkin === tone }]}
              aria-label={t("server.settings.skinToneValue", { tone })}
              aria-pressed={props.faceSkin === tone ? "true" : "false"}
              disabled={props.disabled}
              onClick={() => props.onChange({ faceSkin: tone })}
            >
              <span class="avatar-color-swatch" style={{ background: SKIN_TONES[index()] ?? "" }} />
            </Button>
          )}
        </For>
      </fieldset>
    </>
  );
}
