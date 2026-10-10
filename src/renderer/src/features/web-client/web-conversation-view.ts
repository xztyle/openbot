import type {
  AgentEvent,
  ConversationPage,
  RespondToApprovalInput,
  RespondToPromptInput,
} from "@openbot/contracts/ipc";
import type { AgentMessage, AgentProfile } from "@openbot/ui/data";
import { createEffect, createMemo, createSignal } from "solid-js";
import { createMessageProjector, toAgentMessage } from "../../app-message-projection";
import type { createRemoteAgentAdmin } from "../agents/remote-agent-admin";
import type { WebWorkspace } from "./web-client-context";

type PromptEvent = Extract<AgentEvent, { type: "prompt" }>;

/**
 * The host names attachment previews with the desktop `openbot-attachment:` scheme, which a browser
 * cannot load. A browser preview is a blob URL that the client made from the file's bytes, or null.
 */
function withPreviewUrls(message: AgentMessage, previewUrl: (attachmentId: string) => string | null): AgentMessage {
  if (!message.attachments?.length) return message;
  return {
    ...message,
    attachments: message.attachments.map((attachment) => ({ ...attachment, previewUrl: previewUrl(attachment.id) })),
  };
}

/**
 * `withPreviewUrls` that returns the object it made before while the message and its preview URLs
 * are the same, so a row with a picture does not run again for a delta of another message.
 */
function createPreviewProjector(previewUrl: (attachmentId: string) => string | null) {
  const cache = new WeakMap<AgentMessage, { signature: string; urls: (string | null)[]; value: AgentMessage }>();
  return (message: AgentMessage): AgentMessage => {
    if (!message.attachments?.length) return message;
    // The copies hold the summaries as they were, so a change inside one is a new result too.
    const signature = JSON.stringify(message.attachments);
    const urls = message.attachments.map((attachment) => previewUrl(attachment.id));
    const cached = cache.get(message);
    if (
      cached &&
      cached.signature === signature &&
      cached.urls.length === urls.length &&
      cached.urls.every((url, index) => url === urls[index])
    )
      return cached.value;
    const value = withPreviewUrls(message, previewUrl);
    cache.set(message, { signature, urls, value });
    return value;
  };
}

/** The selected agent's messages, and the prompt and approval that wait for the user. */
export function createWebConversationView(options: {
  workspace: Pick<WebWorkspace, "answer" | "approve"> & {
    state: Pick<WebWorkspace["state"], "approvals" | "prompts" | "selectedId" | "status">;
    selected: () => Pick<AgentProfile, "id" | "threadId"> | undefined;
    conversation: () => { page: ConversationPage | null } | undefined;
  };
  remoteAgentAdmin: Pick<ReturnType<typeof createRemoteAgentAdmin>, "settings" | "update">;
  /** True when the agent form or a channel covers the conversation. */
  hidden: () => boolean;
  /** The blob URL of an image attachment that was fetched. Reads a signal. */
  previewUrl?: (attachmentId: string) => string | null;
}) {
  const { workspace, remoteAgentAdmin } = options;
  const previewUrl = (attachmentId: string) => options.previewUrl?.(attachmentId) ?? null;
  const approval = createMemo(() =>
    workspace.state.approvals.find(
      (item) => item.agentId === workspace.state.selectedId && item.threadId === workspace.selected()?.threadId,
    ),
  );
  /** "Always allow", for an owner or admin whose host answered. The grant is written on the host. */
  const alwaysAllowApproval = createMemo(() => {
    const agent = workspace.selected();
    const item = approval();
    if (!agent || !item || !remoteAgentAdmin.settings()) return undefined;
    return async () => {
      await remoteAgentAdmin.update({ agentId: agent.id, autoApprove: true });
      if (approval()?.requestId !== item.requestId) return false;
      await workspace.approve({ requestId: item.requestId, decision: "accept" });
      return true;
    };
  });
  /**
   * As on desktop: an answered prompt stays until its bubble has shown the answers. After that, a
   * snapshot or page that the host made before it had the answer does not open the prompt again.
   */
  const [answeredPrompt, setAnsweredPrompt] = createSignal<{ prompt: PromptEvent; presented: boolean }>();
  const isAnswered = (turnId: string, requestId: string | number) => {
    const answered = answeredPrompt()?.prompt;
    return answered?.turnId === turnId && String(answered.requestId) === String(requestId);
  };
  // The bubble unmounts with its conversation and then cannot report that it showed the answers.
  createEffect(
    () => ({ agentId: workspace.state.selectedId, hidden: options.hidden() }),
    () => setAnsweredPrompt(undefined),
  );
  const prompt = createMemo<PromptEvent | undefined>(() => {
    if (workspace.state.status !== "online") return;
    const page = workspace.conversation()?.page;
    if (!page?.threadId) return;
    const pending = workspace.state.prompts.find(
      (item) =>
        item.agentId === page.agentId && item.threadId === page.threadId && !isAnswered(item.turnId, item.requestId),
    );
    if (pending) return pending;
    const answered = answeredPrompt();
    if (
      answered &&
      !answered.presented &&
      answered.prompt.agentId === page.agentId &&
      answered.prompt.threadId === page.threadId
    )
      return answered.prompt;
    const activeTurnId = page.activeTurnId;
    const message = page.messages.findLast(
      (item) =>
        item.turnId === activeTurnId &&
        item.questionPrompt &&
        !item.questionPrompt.resolution &&
        !(activeTurnId && isAnswered(activeTurnId, item.questionPrompt.requestId)),
    );
    if (!message?.questionPrompt || !page.activeTurnId) return;
    return {
      type: "prompt",
      agentId: page.agentId,
      threadId: page.threadId,
      turnId: page.activeTurnId,
      requestId: message.questionPrompt.requestId,
      questions: message.questionPrompt.questions,
    };
  });
  // A delta changes one message. The projector keeps the object of every other message, so the
  // rows of those messages do not run again.
  const projectMessages = createMessageProjector();
  const projected = createMemo(() =>
    projectMessages(workspace.conversation()?.page?.messages ?? [], workspace.state.selectedId ?? undefined),
  );
  const withPreviews = createPreviewProjector(previewUrl);
  // A second layer, so a picture that arrives rebuilds only the messages that have attachments.
  const messages = createMemo(() => projected().map(withPreviews));
  /** The replied-to messages that are not on the loaded pages. The host sends them with each page. */
  const messageReferences = createMemo(() => {
    const page = workspace.conversation()?.page;
    if (!page) return {};
    return Object.fromEntries(
      Object.entries(page.references).map(([id, reference]) => [
        id,
        withPreviewUrls(toAgentMessage(reference, page.agentId), previewUrl),
      ]),
    );
  });
  async function answerPrompt(answers: RespondToPromptInput["answers"]): Promise<boolean> {
    const question = prompt();
    if (!question) return false;
    setAnsweredPrompt({ prompt: question, presented: false });
    try {
      await workspace.answer({ requestId: question.requestId, answers });
    } catch (error) {
      setAnsweredPrompt(undefined);
      throw error;
    }
    return true;
  }
  function presentPromptResolution(turnId: string, requestId: string | number): void {
    const answered = answeredPrompt();
    if (answered && isAnswered(turnId, requestId)) setAnsweredPrompt({ ...answered, presented: true });
  }
  async function respondToApproval(decision: RespondToApprovalInput["decision"]): Promise<boolean> {
    const item = approval();
    if (!item) return false;
    await workspace.approve({ requestId: item.requestId, decision });
    return true;
  }
  /** Forgets the answered prompt, for a host change. */
  function reset(): void {
    setAnsweredPrompt(undefined);
  }
  return {
    approval,
    alwaysAllowApproval,
    prompt,
    messages,
    messageReferences,
    answerPrompt,
    presentPromptResolution,
    respondToApproval,
    reset,
  };
}
