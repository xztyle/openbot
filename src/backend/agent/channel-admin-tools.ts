import { randomUUID } from "node:crypto";
import { INPUT_LIMITS } from "@openbot/contracts/input-limits";
import {
  type AgentSummary,
  CHANNEL_ANSWER_MODES,
  CHANNEL_DESCRIPTION_LIMIT,
  CHANNEL_FOCUS_LIMIT,
  CHANNEL_GROUP_LIMIT,
  CHANNEL_NAME_MAX,
  CHANNEL_ROUTINGS,
  CHANNEL_TOPIC_LIMIT,
  CHANNEL_VISIBILITIES,
  type Channel,
  type ChannelCommand,
  type ChannelMember,
  type ChannelMessage,
  channelKind,
  channelRouting,
  channelVisibility,
  GENERAL_SPACE_ID,
  isChannelThreadReply,
  slugChannelName,
} from "@openbot/contracts/ipc";
import { sourceText } from "@openbot/i18n/source";
import { Effect } from "effect";
import { z } from "zod";
import type { ChannelService } from "../channel-service";
import { openBotToolFailure, openBotToolResult } from "./routine-tools";

// The tools an agent manages channels with from its own chat, as a person does in the channel
// settings. They run the same `ChannelService` commands as the desktop and the Team API, as the host
// user of this computer (the owner of the server), so every check, event and change of the workspace
// is the same. The rules of an agent come first: it sees and changes only channels of its own space,
// changes only a channel it is a member of or made, and adds only agents of its own space.

const channelId = z.string().min(1).max(INPUT_LIMITS.identifier).describe("The channel id from list_channels.");
const agentId = z.string().min(1).max(INPUT_LIMITS.identifier).describe("An agent id from openbot.list_agents.");
const answerMode = z
  .enum(CHANNEL_ANSWER_MODES)
  .describe(
    "When the agent answers people's messages in the channel. mention: only when a message mentions it, replies to it, or is in a thread it takes part in. always: it considers each message, and the gate model decides if it answers. always-no-gate: it answers each message. lead: the coordinator of the channel (with routing coordinator, the lead gives each message to one owner).",
  );
const focus = z
  .string()
  .max(CHANNEL_FOCUS_LIMIT)
  .describe("A short note of what this agent cares about in this channel. The gate reads it.");
const member = z.strictObject({ agentId, answerMode: answerMode.optional(), focus: focus.optional() });
const memberList = z.array(member).max(INPUT_LIMITS.agents);
const routing = z
  .enum(CHANNEL_ROUTINGS)
  .describe(
    "responders: each member answers by its own answer mode. coordinator: the lead agent gives each person's message to one owner; only a mentioned agent answers directly.",
  );
const name = z
  .string()
  .trim()
  .min(1)
  .max(CHANNEL_NAME_MAX)
  .describe("The channel name. OpenBot writes it as Slack does: lower case, words joined with -.");
const topic = z.string().max(CHANNEL_TOPIC_LIMIT).describe("One line that the channel header shows.");
const description = z.string().max(CHANNEL_DESCRIPTION_LIMIT).describe("What the channel is for.");
const instructions = z
  .string()
  .max(INPUT_LIMITS.agentDescription)
  .describe("Instructions that every member agent gets for its work in this channel. Empty removes them.");

export const listChannelsToolSchema = z.strictObject({
  includeArchived: z.boolean().optional().describe("Also list archived channels. The default is false."),
});
export const readChannelToolSchema = z.strictObject({
  channelId,
  messages: z
    .number()
    .int()
    .min(0)
    .max(50)
    .optional()
    .describe("How many of the latest channel messages to include, 0-50. The default is 10."),
});
export const createChannelToolSchema = z.strictObject({
  name: name
    .optional()
    .describe("The channel name. Required for kind channel; a group takes the names of its members."),
  kind: z
    .enum(["channel", "group"])
    .optional()
    .describe(
      `channel (the default): a named channel. group: a group conversation of the user and 2 to ${CHANNEL_GROUP_LIMIT - 1} agents, with no name, topic or settings.`,
    ),
  visibility: z
    .enum(CHANNEL_VISIBILITIES)
    .optional()
    .describe("public (the default): every person of the team sees it. private: only its people see it."),
  topic: topic.optional(),
  description: description.optional(),
  instructions: instructions.optional(),
  members: memberList
    .optional()
    .describe(
      "The agents of your space to add. A member without answerMode or focus gets the agent's channel defaults from its settings, else the workspace default.",
    ),
  includeSelf: z.boolean().optional().describe("Add yourself as a member. The default is true."),
  routing: routing.optional(),
  leadAgentId: agentId.optional().describe("The lead agent, a member. Needed for routing coordinator."),
});
export const updateChannelToolSchema = z.strictObject({
  channelId,
  name: name.optional(),
  topic: topic.optional().describe("One line that the channel header shows. Empty removes it."),
  description: description.optional().describe("What the channel is for. Empty removes it."),
  instructions: instructions.optional(),
  visibility: z.enum(CHANNEL_VISIBILITIES).optional(),
  routing: routing.optional(),
  leadAgentId: agentId.optional().describe("The new lead agent, a member."),
  archived: z.boolean().optional().describe("true archives the channel and stops its work; false restores it."),
});
export const updateChannelMembersToolSchema = z.strictObject({
  channelId,
  add: memberList.optional().describe("Agents of your space to add."),
  remove: z
    .array(agentId)
    .max(INPUT_LIMITS.agents)
    .optional()
    .describe("Member agents to remove. Their work here stops."),
  update: z
    .array(
      z.strictObject({
        agentId,
        answerMode: answerMode.nullable().optional().describe("The new answer mode; null returns to the default."),
        focus: focus.nullable().optional().describe("The new focus; null or empty removes it."),
      }),
    )
    .max(INPUT_LIMITS.agents)
    .optional()
    .describe("New settings of members."),
});
export const postChannelMessageToolSchema = z.strictObject({
  channelId,
  text: z.string().trim().min(1).max(INPUT_LIMITS.messageText),
  assignAgentIds: z
    .array(agentId)
    .max(8)
    .optional()
    .describe("Member agents that each get this message as a task to work on. Absent: the message starts no work."),
  threadRootId: z.string().min(1).max(INPUT_LIMITS.identifier).optional().describe("Post as a reply in this thread."),
});
export const deleteChannelToolSchema = z.strictObject({
  channelId,
  userAsked: z
    .literal(true)
    .describe("true only when the user asked you in this conversation to delete this channel. Else archive it."),
});

export const CHANNEL_ADMIN_TOOL_DEFINITIONS: readonly { name: string; description: string; shape: z.ZodRawShape }[] = [
  {
    name: "list_channels",
    description:
      "List the workspace channels of your space that you can see: public channels, and private channels and groups that you are a member of or made. Each has its id, name, kind, visibility, topic, members, and whether you may change it. Read-only.",
    shape: listChannelsToolSchema.shape,
  },
  {
    name: "read_channel",
    description:
      "Read one channel of your space: its settings (name, topic, description, instructions, visibility, routing, lead), its members with their answer mode and focus, its people, and its latest messages. Read-only.",
    shape: readChannelToolSchema.shape,
  },
  {
    name: "create_channel",
    description:
      "Create a workspace channel (or a group conversation) in your space when the user asks for one, with its topic, description, instructions, visibility and member agents with their answer modes. The user is always one of its people, so it shows in their sidebar; you are a member unless includeSelf is false. List channels first: a channel with the same name in your space is not created again.",
    shape: createChannelToolSchema.shape,
  },
  {
    name: "update_channel",
    description:
      "Change a channel of your space that you are a member of or made: rename it, change its topic, description, instructions, visibility, routing or lead, archive it, or restore it. Fields you leave out keep their values.",
    shape: updateChannelToolSchema.shape,
  },
  {
    name: "update_channel_members",
    description:
      "Add agents of your space to a channel that you are a member of or made, remove members, or change how each member answers (answer mode) and its focus, as the channel settings do.",
    shape: updateChannelMembersToolSchema.shape,
  },
  {
    name: "post_channel_message",
    description:
      "Post a message as yourself in a channel that you are a member of or made, such as the first brief of a channel you made. With assignAgentIds, each named member gets the message as a task and answers in the channel. In a channel task, answer that channel in your reply or with channel_assign instead.",
    shape: postChannelMessageToolSchema.shape,
  },
  {
    name: "delete_channel",
    description:
      "Delete a channel of your space that you are a member of or made, with all its messages and work. This cannot be undone. Only when the user asked for the deletion; otherwise archive the channel with update_channel.",
    shape: deleteChannelToolSchema.shape,
  },
];

const TOOL_NAMES = new Set(CHANNEL_ADMIN_TOOL_DEFINITIONS.map((tool) => tool.name));

export function isChannelAdminTool(tool: string): boolean {
  return TOOL_NAMES.has(tool);
}

/** What the channel tools of an agent read and change besides the channel service. */
export interface ChannelAdminPorts {
  channels: ChannelService;
  /** Every agent of the server. */
  agents(): readonly AgentSummary[];
  sameSpace(agentId: string, otherAgentId: string): boolean;
  /** Whether the channel is in the space of the agent. */
  seesChannel(agentId: string, channel: Channel): boolean;
  agentSpace(agentId: string): { id: string; name: string };
  /** The host user of this computer, the owner of the server: the person of a channel that an agent makes. */
  host(): { id: string; name: string };
  /** Puts a channel that does not exist yet in a space, and tells the readers. */
  placeChannel(channelId: string, spaceId: string): void;
}

export interface ChannelAdminCaller {
  agentId: string;
  turnId: string;
  callId: string;
  /** The channel whose task this call runs in, or null for the agent's own chat and other work. */
  channelTaskId: string | null;
}

class Refusal extends Error {}

function refuse(message: string): never {
  throw new Refusal(message);
}

function isMember(channel: Channel, agentId: string): boolean {
  return channel.members.some((item) => item.agentId === agentId);
}

function isCreator(channel: Channel, agentId: string): boolean {
  return channel.createdBy?.kind === "agent" && channel.createdBy.id === agentId;
}

/**
 * Whether the agent sees the channel: a channel of its space that is public, or that it is a member
 * of or made. A DM or a group shows only to its members.
 */
export function agentMaySeeChannel(ports: Pick<ChannelAdminPorts, "seesChannel">, agentId: string, channel: Channel) {
  if (!ports.seesChannel(agentId, channel)) return false;
  if (isMember(channel, agentId) || isCreator(channel, agentId)) return true;
  return channelKind(channel) === "channel" && channelVisibility(channel) === "public";
}

/** Whether the agent may change the channel: it sees it and is a member of it or made it. A DM is fixed. */
function agentMayChange(channel: Channel, agentId: string): boolean {
  return channelKind(channel) !== "dm" && (isMember(channel, agentId) || isCreator(channel, agentId));
}

/**
 * Runs one channel tool of an agent. Null when `tool` is not one of them. A refusal or a failed
 * command is a tool failure with its reason, which the model reads.
 */
export const handleChannelAdminTool = Effect.fn("ChannelAdminTools.handle")(function* (
  tool: string,
  args: unknown,
  caller: ChannelAdminCaller,
  ports: ChannelAdminPorts,
) {
  if (!isChannelAdminTool(tool)) return null;
  const run = new ChannelAdminRun(caller, ports);
  return yield* run.handle(tool, args).pipe(
    Effect.catch((failure) => Effect.succeed(openBotToolFailure(failureText(failure.cause)))),
    Effect.catchDefect((defect) =>
      defect instanceof Refusal || defect instanceof z.ZodError
        ? Effect.succeed(openBotToolFailure(failureText(defect)))
        : Effect.die(defect),
    ),
  );
});

function failureText(cause: unknown): string {
  if (cause instanceof z.ZodError)
    return `Invalid arguments: ${cause.issues.map((issue) => `${issue.path.join(".") || "input"}: ${issue.message}`).join("; ")}`;
  return cause instanceof Error ? cause.message : String(cause);
}

class ChannelAdminRun {
  readonly #caller: ChannelAdminCaller;
  readonly #ports: ChannelAdminPorts;
  #step = 0;

  constructor(caller: ChannelAdminCaller, ports: ChannelAdminPorts) {
    this.#caller = caller;
    this.#ports = ports;
  }

  handle(tool: string, args: unknown) {
    return Effect.gen({ self: this }, function* () {
      switch (tool) {
        case "list_channels":
          return openBotToolResult(this.#list(listChannelsToolSchema.parse(args ?? {})));
        case "read_channel": {
          const input = readChannelToolSchema.parse(args);
          return openBotToolResult(this.#view(this.#visible(input.channelId), input.messages ?? 10));
        }
        case "create_channel":
          return openBotToolResult(yield* this.#create(createChannelToolSchema.parse(args)));
        case "update_channel":
          return openBotToolResult(yield* this.#update(updateChannelToolSchema.parse(args)));
        case "update_channel_members":
          return openBotToolResult(yield* this.#members(updateChannelMembersToolSchema.parse(args)));
        case "post_channel_message":
          return openBotToolResult(yield* this.#post(postChannelMessageToolSchema.parse(args)));
        default:
          return openBotToolResult(yield* this.#delete(deleteChannelToolSchema.parse(args)));
      }
    });
  }

  get #self(): { id: string; name: string } {
    const id = this.#caller.agentId;
    return { id, name: this.#agentName(id) };
  }

  #agentName(id: string): string {
    return this.#ports.agents().find((agent) => agent.id === id)?.name ?? id;
  }

  #operationId(): string {
    this.#step += 1;
    return `agent:${this.#caller.agentId}:${this.#caller.turnId}:${this.#caller.callId}:${this.#step}`;
  }

  /** A channel the caller sees, or a refusal that says why not. */
  #visible(id: string): Channel {
    const store = this.#ports.channels.store;
    if (!store.exists(id)) refuse(`${sourceText("error.backend.channelNotFound")} Call list_channels for the ids.`);
    const channel = store.get(id);
    if (!this.#ports.seesChannel(this.#caller.agentId, channel)) refuse(sourceText("error.backend.spaceOtherChannel"));
    if (!agentMaySeeChannel(this.#ports, this.#caller.agentId, channel))
      refuse(`${sourceText("error.backend.channelNotFound")} Call list_channels for the ids.`);
    return channel;
  }

  /** A channel the caller may change. */
  #changeable(id: string): Channel {
    const channel = this.#visible(id);
    if (channelKind(channel) === "dm") refuse(sourceText("error.backend.channelDirectFixed"));
    if (!agentMayChange(channel, this.#caller.agentId))
      refuse(
        "You can change only a channel that you are a member of or made. Ask the user, or a member of the channel, to change it.",
      );
    return channel;
  }

  /** An agent that the caller may put in a channel: one of its own space that is not hidden. */
  #requireAgent(id: string): AgentSummary {
    const agent = this.#ports.agents().find((item) => item.id === id);
    if (!agent) refuse(`No agent has the id ${id}. Get the ids from openbot.list_agents.`);
    if (!this.#ports.sameSpace(this.#caller.agentId, id))
      refuse(sourceText("error.backend.spaceOtherAgent", { agent: agent.name }));
    if (agent.hiddenAt !== undefined) refuse(sourceText("error.backend.recipientHidden"));
    return agent;
  }

  #list(input: z.infer<typeof listChannelsToolSchema>) {
    const store = this.#ports.channels.store;
    const caller = this.#caller.agentId;
    const channels = store
      .ids()
      .map((id) => store.get(id))
      .filter((channel) => (input.includeArchived ?? false) || !channel.archived)
      .filter((channel) => agentMaySeeChannel(this.#ports, caller, channel))
      .map((channel) => ({
        id: channel.id,
        name: channel.name,
        kind: channelKind(channel),
        visibility: channelVisibility(channel),
        ...(channel.topic ? { topic: channel.topic } : {}),
        archived: channel.archived,
        members: channel.members.map((item) => this.#agentName(item.agentId)),
        youAreMember: isMember(channel, caller),
        youMadeIt: isCreator(channel, caller),
        youMayChange: agentMayChange(channel, caller),
      }));
    return { space: this.#ports.agentSpace(caller).name, channels };
  }

  #view(channel: Channel, messageCount = 0) {
    const caller = this.#caller.agentId;
    const person = (id: string) => this.#ports.channels.hooks.person?.(id)?.name ?? id;
    const routingMode = channelRouting(channel);
    const messages =
      messageCount > 0
        ? this.#ports.channels.store
            .messages(channel.id, Number.MAX_SAFE_INTEGER, messageCount * 3)
            .filter((message) => !message.deletedAt && !isChannelThreadReply(message) && message.message.text.trim())
            .slice(-messageCount)
            .map((message) => messageView(message))
        : undefined;
    return {
      id: channel.id,
      name: channel.name,
      kind: channelKind(channel),
      visibility: channelVisibility(channel),
      topic: channel.topic ?? "",
      description: channel.description ?? "",
      instructions: channel.instructions,
      archived: channel.archived,
      createdAt: channel.createdAt,
      ...(channel.createdBy
        ? {
            createdBy:
              channel.createdBy.kind === "agent"
                ? { agentId: channel.createdBy.id, name: this.#agentName(channel.createdBy.id) }
                : { personId: channel.createdBy.id, name: person(channel.createdBy.id) },
          }
        : {}),
      routing: routingMode,
      leadAgentId: channel.leadAgentId,
      members: channel.members.map((item) => ({
        agentId: item.agentId,
        name: this.#agentName(item.agentId),
        answerMode: item.answerMode ?? (channel.leadAgentId === item.agentId ? "lead" : "mention"),
        ...(item.focus ? { focus: item.focus } : {}),
      })),
      people: (channel.humanMemberIds ?? []).map((id) => ({ id, name: person(id) })),
      youAreMember: isMember(channel, caller),
      youMayChange: agentMayChange(channel, caller),
      ...(messages ? { messages } : {}),
    };
  }

  #command(command: ChannelCommand) {
    return this.#ports.channels.command(command, this.#ports.host());
  }

  #note(channelId: string, text: string) {
    return this.#ports.channels.noteAgentChange(channelId, this.#self, text);
  }

  #create(input: z.infer<typeof createChannelToolSchema>) {
    return Effect.gen({ self: this }, function* () {
      const caller = this.#caller.agentId;
      const kind = input.kind ?? "channel";
      const given = input.members ?? [];
      const members: ChannelMember[] = [];
      for (const item of given) {
        this.#requireAgent(item.agentId);
        if (!members.some((existing) => existing.agentId === item.agentId)) members.push(item);
      }
      // A group always holds its maker: it has no creator of its own, and only its members see it.
      if ((kind === "group" || (input.includeSelf ?? true)) && !members.some((item) => item.agentId === caller))
        members.unshift({ agentId: caller });
      if (input.leadAgentId !== undefined && !members.some((item) => item.agentId === input.leadAgentId))
        refuse("leadAgentId must be one of the members.");
      const space = this.#ports.agentSpace(caller);
      const channelId = randomUUID();
      const host = this.#ports.host();
      if (kind === "group") {
        if (members.length < 2 || members.length > CHANNEL_GROUP_LIMIT - 1)
          refuse(`A group has the user and 2 to ${CHANNEL_GROUP_LIMIT - 1} agents.`);
        if (space.id !== GENERAL_SPACE_ID) this.#ports.placeChannel(channelId, space.id);
        const group = yield* this.#command({
          type: "open-dm",
          operationId: this.#operationId(),
          channelId,
          memberIds: [],
          agentIds: members.map((item) => item.agentId),
        }).pipe(Effect.tapError(() => Effect.sync(() => this.#ports.placeChannel(channelId, GENERAL_SPACE_ID))));
        // The group of exactly these members existed already: the new id names nothing.
        if (group.id !== channelId) this.#ports.placeChannel(channelId, GENERAL_SPACE_ID);
        else {
          for (const item of members)
            if (item.answerMode !== undefined || item.focus !== undefined)
              yield* this.#command({
                type: "set-member",
                operationId: this.#operationId(),
                channelId,
                agentId: item.agentId,
                ...(item.answerMode === undefined ? {} : { answerMode: item.answerMode }),
                ...(item.focus === undefined ? {} : { focus: item.focus }),
              });
          yield* this.#note(channelId, sourceText("status.agent.channelCreatedByAgent", { agent: this.#self.name }));
        }
        return { created: group.id === channelId, channel: this.#view(this.#ports.channels.store.get(group.id)) };
      }
      if (input.name === undefined) refuse("Give the channel a name.");
      const slug = slugChannelName(input.name);
      if (!slug) refuse("Give the channel a name with letters or digits.");
      const store = this.#ports.channels.store;
      const same = store
        .ids()
        .map((id) => store.get(id))
        .find(
          (channel) =>
            channelKind(channel) === "channel" &&
            !channel.archived &&
            channel.name === slug &&
            this.#ports.seesChannel(caller, channel),
        );
      if (same)
        refuse(
          `Your space already has the channel #${slug} (id ${same.id}). Use update_channel or update_channel_members to change it.`,
        );
      // The new id goes into the space before the channel exists, as the desktop does for its reader.
      if (space.id !== GENERAL_SPACE_ID) this.#ports.placeChannel(channelId, space.id);
      const created = yield* this.#ports.channels
        .createForAgent(
          {
            type: "create",
            operationId: this.#operationId(),
            channelId,
            kind: "channel",
            visibility: input.visibility ?? "public",
            name: slug,
            ...(input.topic?.trim() ? { topic: input.topic.trim() } : {}),
            ...(input.description?.trim() ? { description: input.description.trim() } : {}),
            ...(input.instructions ? { instructions: input.instructions } : {}),
            humanMemberIds: [host.id],
            members,
            ...(input.leadAgentId ? { leadAgentId: input.leadAgentId } : {}),
          },
          host,
          this.#self,
          sourceText("status.agent.channelCreatedByAgent", { agent: this.#self.name }),
        )
        .pipe(Effect.tapError(() => Effect.sync(() => this.#ports.placeChannel(channelId, GENERAL_SPACE_ID))));
      if (input.routing)
        yield* this.#command({
          type: "set-routing",
          operationId: this.#operationId(),
          channelId: created.id,
          routing: input.routing,
          ...(input.leadAgentId ? { leadAgentId: input.leadAgentId } : {}),
        });
      return { created: true, channel: this.#view(this.#ports.channels.store.get(created.id)) };
    });
  }

  #update(input: z.infer<typeof updateChannelToolSchema>) {
    return Effect.gen({ self: this }, function* () {
      let channel = this.#changeable(input.channelId);
      const id = channel.id;
      const named = channelKind(channel) === "channel";
      const settings =
        input.name !== undefined ||
        input.topic !== undefined ||
        input.description !== undefined ||
        input.instructions !== undefined ||
        input.visibility !== undefined ||
        input.routing !== undefined ||
        input.leadAgentId !== undefined;
      if (!settings && input.archived === undefined) refuse("Give at least one field to change.");
      if (!named && (input.visibility !== undefined || input.routing !== undefined || input.name !== undefined))
        refuse("A group has no name, visibility or routing of its own.");
      if (input.leadAgentId !== undefined && !isMember(channel, input.leadAgentId))
        refuse("leadAgentId must be a member of the channel.");
      const self = this.#self.name;
      if (input.archived === false && channel.archived) {
        channel = yield* this.#command({ type: "restore", operationId: this.#operationId(), channelId: id });
        yield* this.#note(id, sourceText("status.agent.channelRestoredByAgent", { agent: self }));
      } else if (channel.archived && settings) refuse(sourceText("error.backend.channelArchived"));
      if (input.name !== undefined || input.topic !== undefined || input.description !== undefined) {
        const slug = input.name === undefined ? undefined : slugChannelName(input.name);
        if (slug === "") refuse("Give the channel a name with letters or digits.");
        channel = yield* this.#command({
          type: "set-meta",
          operationId: this.#operationId(),
          channelId: id,
          ...(slug === undefined ? {} : { name: slug }),
          ...(input.topic === undefined ? {} : { topic: input.topic }),
          ...(input.description === undefined ? {} : { description: input.description }),
        });
      }
      if (input.instructions !== undefined && input.instructions !== channel.instructions)
        channel = yield* this.#command({
          type: "save",
          operationId: this.#operationId(),
          channelId: id,
          update: true,
          draft: {
            name: channel.name,
            title: channel.title,
            instructions: input.instructions,
            members: channel.members,
            leadAgentId: channel.leadAgentId,
          },
        });
      if (input.visibility !== undefined)
        channel = yield* this.#command({
          type: "set-visibility",
          operationId: this.#operationId(),
          channelId: id,
          visibility: input.visibility,
        });
      if (input.routing !== undefined || input.leadAgentId !== undefined)
        channel = yield* this.#command({
          type: "set-routing",
          operationId: this.#operationId(),
          channelId: id,
          routing: input.routing ?? channelRouting(channel),
          ...(input.leadAgentId === undefined ? {} : { leadAgentId: input.leadAgentId }),
        });
      if (settings) yield* this.#note(id, sourceText("status.agent.channelSettingsChangedByAgent", { agent: self }));
      if (input.archived === true && !channel.archived) {
        if (this.#caller.channelTaskId === id)
          refuse("You cannot archive the channel whose task you work on now. Ask a person to archive it.");
        yield* this.#note(id, sourceText("status.agent.channelArchivedByAgent", { agent: self }));
        channel = yield* this.#command({ type: "archive", operationId: this.#operationId(), channelId: id });
      }
      return { channel: this.#view(this.#ports.channels.store.get(id)) };
    });
  }

  #members(input: z.infer<typeof updateChannelMembersToolSchema>) {
    return Effect.gen({ self: this }, function* () {
      const channel = this.#changeable(input.channelId);
      const id = channel.id;
      if (channel.archived) refuse(sourceText("error.backend.channelArchived"));
      const add = (input.add ?? []).filter((item) => !isMember(channel, item.agentId));
      const remove = [...new Set(input.remove ?? [])];
      const update = input.update ?? [];
      if (!add.length && !remove.length && !update.length)
        refuse("Give agents to add, remove or update. An agent that is already a member is not added again.");
      for (const item of add) this.#requireAgent(item.agentId);
      for (const agentId of remove)
        if (!isMember(channel, agentId)) refuse(`${this.#agentName(agentId)} is not a member of this channel.`);
      if (remove.includes(this.#caller.agentId) && this.#caller.channelTaskId === id)
        refuse("You cannot remove yourself from the channel whose task you work on now. Ask a person to do it.");
      for (const item of update) {
        if (!isMember(channel, item.agentId) && !add.some((added) => added.agentId === item.agentId))
          refuse(`${this.#agentName(item.agentId)} is not a member of this channel. Add it with add.`);
        if (item.answerMode === undefined && item.focus === undefined)
          refuse("Give answerMode or focus for each agent in update.");
      }
      const self = this.#self.name;
      const names = (ids: readonly string[]) => ids.map((agentId) => this.#agentName(agentId)).join(", ");
      if (add.length) {
        yield* this.#command({
          type: "invite",
          operationId: this.#operationId(),
          channelId: id,
          humanMemberIds: [],
          members: add,
        });
        yield* this.#note(
          id,
          sourceText("status.agent.channelMembersAddedByAgent", {
            agent: self,
            members: names(add.map((item) => item.agentId)),
          }),
        );
      }
      for (const item of update)
        yield* this.#command({
          type: "set-member",
          operationId: this.#operationId(),
          channelId: id,
          agentId: item.agentId,
          ...(item.answerMode === undefined ? {} : { answerMode: item.answerMode }),
          ...(item.focus === undefined ? {} : { focus: item.focus }),
        });
      if (update.length)
        yield* this.#note(
          id,
          sourceText("status.agent.channelMembersChangedByAgent", {
            agent: self,
            members: names(update.map((item) => item.agentId)),
          }),
        );
      if (remove.length) {
        // The note comes first: the caller can leave, and a note from a member that left reads better before.
        yield* this.#note(
          id,
          sourceText("status.agent.channelMembersRemovedByAgent", { agent: self, members: names(remove) }),
        );
        yield* this.#command({
          type: "remove",
          operationId: this.#operationId(),
          channelId: id,
          humanMemberIds: [],
          agentIds: remove,
        });
      }
      return { channel: this.#view(this.#ports.channels.store.get(id)) };
    });
  }

  #post(input: z.infer<typeof postChannelMessageToolSchema>) {
    return Effect.gen({ self: this }, function* () {
      const channel = this.#changeable(input.channelId);
      if (this.#caller.channelTaskId === channel.id)
        refuse(
          "You work on a task of this channel now: your reply goes to the channel. Use channel_assign to give work to a member.",
        );
      const recipients = [...new Set(input.assignAgentIds ?? [])];
      for (const agentId of recipients) {
        if (agentId === this.#caller.agentId) refuse("Do not assign the message to yourself.");
        if (!isMember(channel, agentId))
          refuse(`${this.#agentName(agentId)} is not a member of this channel. Add it with update_channel_members.`);
      }
      // A mention shows the people of the channel who gets the work.
      const mentions = recipients
        .filter((agentId) => !input.text.includes(`(agent:${agentId})`))
        .map((agentId) => `@[${this.#agentName(agentId)}](agent:${agentId})`)
        .join(" ");
      const posted = yield* this.#ports.channels.postForAgent({
        channelId: channel.id,
        agent: this.#self,
        text: mentions ? `${mentions} ${input.text}` : input.text,
        recipientAgentIds: recipients,
        threadRootId: input.threadRootId ?? null,
        operationId: this.#operationId(),
      });
      return { posted: true, channelId: channel.id, ...posted };
    });
  }

  #delete(input: z.infer<typeof deleteChannelToolSchema>) {
    return Effect.gen({ self: this }, function* () {
      const channel = this.#changeable(input.channelId);
      if (this.#caller.channelTaskId === channel.id)
        refuse("You cannot delete the channel whose task you work on now. Ask a person to delete it.");
      yield* this.#ports.channels.deleteChannel(channel.id);
      return { deleted: true, channelId: channel.id, name: channel.name };
    });
  }
}

function messageView(message: ChannelMessage) {
  const text = message.message.text;
  return {
    id: message.id,
    author: message.author.name,
    authorKind: message.author.kind === "member" ? "person" : "agent",
    at: message.message.createdAt,
    text: text.length > 1_000 ? `${text.slice(0, 1_000)}…` : text,
    ...(message.threadSummary ? { replies: message.threadSummary.replyCount } : {}),
  };
}
