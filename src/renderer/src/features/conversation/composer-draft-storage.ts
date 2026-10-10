import { rewriteAttachmentReferences } from "@openbot/contracts/attachment-references";
import { isDynamicRecord, isString } from "@openbot/contracts/runtime-values";
import { createEffect, onCleanup } from "solid-js";
import { EMPTY_DRAFT } from "./composer-draft";
import { composerDraftKey } from "./conversation-keys";
import type { ComposerDraft } from "./conversation-types";

const COMPOSER_DRAFTS_STORAGE_KEY = "openbot:composer-drafts";
const WRITE_DELAY_MS = 300;

/**
 * The storage key of one account in a browser. A browser profile can hold several accounts, so the web
 * client keeps each account's drafts apart from the others and from the desktop key.
 */
export function accountComposerDraftsKey(accountId: string): string {
  return `${COMPOSER_DRAFTS_STORAGE_KEY}:${accountId}`;
}

type Drafts = Record<string, ComposerDraft>;

export interface StoredComposerDrafts {
  agents: Drafts;
  channels: Drafts;
}

interface ComposerDraftOwner {
  drafts: () => Drafts;
  channelDrafts: () => Drafts;
  editingAgentId: () => string | null;
  editingServerId: () => string | null;
  editingDraftBackup: () => ComposerDraft | null;
  /** Messages that left the composer but that the host has not confirmed, per chat, oldest first. */
  unsentTexts: () => Record<string, string[]>;
}

/**
 * Unsent composer text from the last session, so an update mid-message loses nothing.
 *
 * Only the text is kept. The main process deletes draft attachment files at startup, so a restored
 * attachment would point at nothing: its inline reference becomes its name. A reply target is not
 * kept either, because the message it names may not be loaded, and the user could not see or cancel
 * the reply.
 */
export function readStoredComposerDrafts(storageKey = COMPOSER_DRAFTS_STORAGE_KEY): StoredComposerDrafts {
  try {
    return decodeStoredDrafts(JSON.parse(window.localStorage.getItem(storageKey) ?? "null"));
  } catch {
    return { agents: {}, channels: {} };
  }
}

function decodeStoredDrafts(value: unknown): StoredComposerDrafts {
  return isDynamicRecord(value)
    ? { agents: decodeDrafts(value.agents), channels: decodeDrafts(value.channels) }
    : { agents: {}, channels: {} };
}

/**
 * Writes the drafts shortly after each change, and at once when the window goes away.
 *
 * A queue edit stores its own draft (`QUEUE_EDIT_STORAGE_KEY`), so for that conversation this keeps
 * the draft the edit restores when it ends.
 *
 * `discard` removes the stored drafts and stops every later write. Sign-out calls it, so the next
 * person who uses this browser finds no text of the account that left.
 */
export function writeComposerDraftsOnChange(
  owner: ComposerDraftOwner,
  storageKey = COMPOSER_DRAFTS_STORAGE_KEY,
): { discard: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let discarded = false;
  const write = () => {
    clearTimeout(timer);
    timer = undefined;
    if (discarded) return;
    const agents = { ...owner.drafts() };
    const editAgentId = owner.editingAgentId();
    const editServerId = owner.editingServerId();
    if (editAgentId && editServerId)
      agents[composerDraftKey({ agentId: editAgentId, serverId: editServerId })] =
        owner.editingDraftBackup() ?? EMPTY_DRAFT;
    // A failed or waiting message lives only in memory. After a restart its text is back in the
    // composer, before what the user typed later, and nothing sends it again on its own.
    for (const [key, texts] of Object.entries(owner.unsentTexts())) {
      const draft = agents[key] ?? EMPTY_DRAFT;
      agents[key] = { ...draft, text: [...texts, draft.text].filter((text) => text.trim()).join("\n\n") };
    }
    try {
      window.localStorage.setItem(
        storageKey,
        JSON.stringify({ agents: storableDrafts(agents), channels: storableDrafts(owner.channelDrafts()) }),
      );
    } catch {
      // Storage is full or unavailable. The drafts stay in memory for this session.
    }
  };
  createEffect(
    () =>
      [
        owner.drafts(),
        owner.channelDrafts(),
        owner.editingAgentId(),
        owner.editingDraftBackup(),
        owner.unsentTexts(),
      ] as const,
    () => {
      clearTimeout(timer);
      if (!discarded) timer = setTimeout(write, WRITE_DELAY_MS);
    },
    { defer: true },
  );
  const flush = () => {
    if (timer !== undefined) write();
  };
  window.addEventListener("pagehide", flush);
  onCleanup(() => {
    window.removeEventListener("pagehide", flush);
    flush();
  });
  return {
    discard() {
      discarded = true;
      clearTimeout(timer);
      timer = undefined;
      try {
        window.localStorage.removeItem(storageKey);
      } catch {
        // Storage is unavailable, so nothing was stored.
      }
    },
  };
}

function storableDrafts(drafts: Drafts): Record<string, { text: string }> {
  return Object.fromEntries(
    Object.entries(drafts).flatMap(([key, draft]) => {
      const text = rewriteAttachmentReferences(draft.text, () => null);
      return text.trim() ? [[key, { text }]] : [];
    }),
  );
}

function decodeDrafts(value: unknown): Drafts {
  if (!isDynamicRecord(value)) return {};
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, draft]) =>
      isDynamicRecord(draft) && isString(draft.text)
        ? [[key, { text: draft.text, attachments: [], replyToMessageId: null }]]
        : [],
    ),
  );
}
