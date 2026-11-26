import type { AgentEvent, ClientAgentSummary } from "@openbot/contracts/ipc";
import { appSoundContext } from "./completion-sound";

const ATTENTION_SOUND_STORAGE_KEY = "openbot:attention-sound-enabled";
/** Two soft notes, a fifth apart: a question, not an alarm. */
const NOTES_HZ = [660, 990] as const;
const NOTE_SECONDS = 0.14;
const NOTE_GAP_SECONDS = 0.09;

type NotificationAgent = Pick<ClientAgentSummary, "id" | "notifications">;
type PreferenceStorage = Pick<Storage, "getItem">;

/** The choice for this page after the browser did not save it. It wins over an older saved value. */
let unsavedPreference: boolean | undefined;

/**
 * The sound is on unless the user turned it off, as the task sound is: Atelier already has a Sounds
 * section, and a card that waits for the owner is what they most want to hear. Reading
 * `window.localStorage` throws when the browser blocks storage, so it is read inside the guard.
 */
export function isAttentionSoundEnabled(storage?: PreferenceStorage): boolean {
  if (unsavedPreference !== undefined) return unsavedPreference;
  try {
    return (storage ?? window.localStorage).getItem(ATTENTION_SOUND_STORAGE_KEY) !== "false";
  } catch {
    return true;
  }
}

export function setAttentionSoundEnabled(enabled: boolean, storage?: Pick<Storage, "setItem">): void {
  try {
    (storage ?? window.localStorage).setItem(ATTENTION_SOUND_STORAGE_KEY, String(enabled));
    unsavedPreference = undefined;
  } catch {
    // Blocked or full storage keeps the switch for this page only.
    unsavedPreference = enabled;
  }
}

/** The agent whose request the event carries, when the event is a request for the owner. */
function requestingAgent(event: AgentEvent): string | null {
  switch (event.type) {
    case "prompt":
      return event.agentId;
    case "approval":
      return event.approval.agentId;
    case "browser-takeover-requested":
      return event.request.agentId;
    default:
      return null;
  }
}

function shouldPlayAttentionSound(
  event: AgentEvent,
  agents: NotificationAgent[],
  storage?: PreferenceStorage,
): boolean {
  const agentId = requestingAgent(event);
  if (agentId === null) return false;
  if (!isAttentionSoundEnabled(storage)) return false;
  return agents.some((agent) => agent.id === agentId && agent.notifications);
}

/** Plays the cue when a card that needs the owner appears: a question, an approval or a browser step. */
export function playAttentionSoundForAgentEvent(
  event: AgentEvent,
  agents: NotificationAgent[],
  storage?: PreferenceStorage,
): void {
  if (!shouldPlayAttentionSound(event, agents, storage)) return;
  void playAttentionSound();
}

/** The cue itself, for the settings page's replay. */
export async function playAttentionSound(): Promise<void> {
  try {
    const context = await appSoundContext();
    const startedAt = context.currentTime;
    NOTES_HZ.forEach((frequency, index) => {
      const at = startedAt + index * (NOTE_SECONDS + NOTE_GAP_SECONDS);
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.type = "sine";
      oscillator.frequency.setValueAtTime(frequency, at);
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.exponentialRampToValueAtTime(0.12, at + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + NOTE_SECONDS);
      oscillator.connect(gain);
      gain.connect(context.destination);
      oscillator.addEventListener(
        "ended",
        () => {
          oscillator.disconnect();
          gain.disconnect();
        },
        { once: true },
      );
      oscillator.start(at);
      oscillator.stop(at + NOTE_SECONDS);
    });
  } catch {
    // No audio output here: the card still shows.
  }
}
