import { randomUUID } from "node:crypto";
import { channelKind, GENERAL_SPACE_ID, type RoutineSchedule } from "@openbot/contracts/ipc";
import { createOpenBotLogger, redactSecrets, redactText } from "@openbot/logging";
import { Effect } from "effect";
import type { AgentService } from "../backend/agent-service";
import type { InsightService } from "../backend/insight/insight-service";
import { PortfolioService } from "../backend/portfolio/portfolio-service";
import { localSkillLearner } from "./local-skill-learner";
import type { SkillMarketplaceService } from "./skill-marketplace-service";

const logger = createOpenBotLogger("portfolio-host");
const NOTICE_NAME = "Atelier";

export interface PortfolioHostOptions {
  userData: string;
  service: AgentService;
  insight: InsightService;
  skills: SkillMarketplaceService;
  /** The owner of this host; null while nobody is signed in. */
  owner(): { id: string; name: string } | null;
  timeZone(): string;
  running(): boolean;
}

/**
 * Builds the portfolio service of the host (`backend/portfolio`) on the agent service, the insight
 * service and the skill library, and attaches it to the agent service for its tools and hooks.
 */
export function startPortfolioHost(options: PortfolioHostOptions): PortfolioService {
  const { service, insight, skills } = options;
  const spaces = service.spaces.store;
  const channels = service.channels.store;
  const agentsOf = (spaceId: string) =>
    service.listAgents().filter((agent) => spaces.agentSpaceId(agent.id) === spaceId);
  const channelsOf = (spaceId: string) => {
    const archived = channels.archivedIds();
    return channels
      .ids()
      .filter((channelId) => !archived.has(channelId))
      .map((channelId) => channels.get(channelId))
      .filter((channel) => spaces.channelSpaceId(channel) === spaceId);
  };
  const report = (days: number) =>
    insight.read({ days }).pipe(
      Effect.map((value) => value),
      Effect.orElseSucceed(() => null),
    );
  /** The owner's briefing channel, where the host's own notices go. */
  const notice = (text: string, spaceId: string) => {
    void Effect.runPromise(report(7)).then((value) => {
      const channelId =
        value?.briefing.channelId ?? channelsOf(spaceId).find((channel) => channelKind(channel) === "channel")?.id;
      if (!channelId || !service.channels.postNotice(channelId, NOTICE_NAME, text))
        logger.info("A portfolio notice had no channel to go to.", { spaceId });
    });
  };
  const learner = () => localSkillLearner(skills);

  const portfolio = new PortfolioService({
    userDataPath: options.userData,
    suites: {
      profile: (agentId) => service.sandboxProfile(agentId),
      generateAgent: (agentId, prompt) => service.generateWithoutTools(agentId, redactSecrets(prompt), "own"),
      generateSmall: (agentId, prompt) => service.generateWithoutTools(agentId, redactSecrets(prompt), "small"),
    },
    quality: {
      profile: (agentId) => service.sandboxProfile(agentId),
      generateSmall: (agentId, prompt) => service.generateWithoutTools(agentId, prompt, "small"),
      redact: redactSecrets,
    },
    templates: {
      space: (spaceId) => {
        const space = spaces.list().find((entry) => entry.id === spaceId);
        return space ? { id: space.id, name: space.name, icon: space.icon } : null;
      },
      agentsOf: (spaceId) =>
        agentsOf(spaceId).map((agent) => ({
          id: agent.id,
          name: agent.name,
          title: agent.title,
          instructions: agent.description,
          role: agent.playbookRole ?? null,
          managerId: agent.reportsToAgentId ?? null,
        })),
      skillsOf: (agentId) =>
        skills.listInstalledForChatTags(agentId).pipe(
          Effect.flatMap((installed) =>
            Effect.forEach(installed.slice(0, 10), (skill) =>
              learner()
                .read(skill.skillId)
                .pipe(
                  Effect.map((source) => [
                    { name: skill.name, description: skill.description ?? "", instructions: source.instructions },
                  ]),
                  // A skill of the marketplace has no local text: the template leaves it out.
                  Effect.orElseSucceed(() => []),
                ),
            ),
          ),
          Effect.map((lists) => lists.flat()),
          Effect.orElseSucceed(() => []),
        ),
      routinesOf: (agentId) =>
        service.listRoutines(agentId).map((routine) => ({
          name: routine.name,
          instruction: routine.instruction,
          schedule: routine.trigger.schedule,
        })),
      playbooks: () =>
        service.playbooks.snapshot().pipe(
          Effect.map((snapshot) => snapshot.playbooks),
          Effect.orElseSucceed(() => []),
        ),
      loopsOf: (spaceId) =>
        service.loops.board(spaceId).loops.map((loop) => ({
          templateId: loop.templateId,
          definition: {
            name: loop.name,
            ...(loop.description ? { description: loop.description } : {}),
            stages: loop.stages,
            fields: loop.fields,
          },
        })),
      channelsOf: (spaceId) =>
        channelsOf(spaceId)
          .filter((channel) => channelKind(channel) === "channel")
          .map((channel) => ({
            name: channel.name,
            description: channel.description ?? channel.title,
            agentIds: channel.members.map((member) => member.agentId),
          })),
      redact: redactText,
      createSpace: (name, icon) =>
        service.spaces
          .apply({ kind: "create", name, icon })
          .pipe(
            Effect.flatMap((result) =>
              result.createdSpaceId
                ? Effect.succeed(result.createdSpaceId)
                : Effect.fail(new Error("No space was made.")),
            ),
          ),
      createAgent: (spaceId, agent) =>
        service
          .createAgentProfile({
            name: agent.name,
            description: agent.instructions,
            avatarSeed: randomUUID(),
            avatarHue: null,
            spaceId,
            ...(agent.title ? { title: agent.title } : {}),
          })
          .pipe(
            Effect.tap((created) => Effect.sync(() => service.spaces.place("agent", created.id, spaceId))),
            Effect.tap((created) =>
              agent.role
                ? service.updateAgent({ agentId: created.id, playbookRole: agent.role }).pipe(Effect.ignore)
                : Effect.void,
            ),
            Effect.map((created) => created.id),
          ),
      setManager: (agentId, managerId) =>
        service.updateAgent({ agentId, reportsToAgentId: managerId }).pipe(Effect.asVoid),
      addSkill: (agentId, skill) =>
        learner()
          .save(agentId, { action: "create", ...skill })
          .pipe(Effect.as(true)),
      createRoutine: (agentId, routine) =>
        service.createRoutine({
          agentId,
          name: routine.name,
          instruction: routine.instruction,
          active: false,
          timezone: options.timeZone(),
          schedule: routine.schedule satisfies RoutineSchedule,
        }).id,
      activateRoutine: (agentId, routineId) => {
        service.updateRoutine({ agentId, routineId, active: true });
      },
      savePlaybook: (playbook) =>
        service.playbooks
          .snapshot()
          .pipe(
            Effect.flatMap((snapshot) =>
              snapshot.playbooks.some((entry) => entry.slug === playbook.slug)
                ? Effect.succeed(false)
                : service.playbooks
                    .save(
                      { slug: playbook.slug, roles: [...playbook.roles], content: playbook.content },
                      { kind: "owner" },
                    )
                    .pipe(Effect.as(true)),
            ),
          ),
      createLoop: (spaceId, loop) =>
        Effect.try(() =>
          service.loops.apply(
            loop.templateId
              ? { kind: "create-loop", spaceId, templateId: loop.templateId }
              : { kind: "create-loop", spaceId, definition: loop.definition },
            { kind: "person" },
          ),
        ),
      createChannel: (spaceId, channel) => {
        const owner = options.owner();
        if (!owner) return Effect.fail(new Error("Nobody is signed in."));
        const channelId = randomUUID();
        service.spaces.place("channel", channelId, spaceId);
        return service.channels.command(
          {
            type: "create",
            operationId: randomUUID(),
            channelId,
            kind: "channel",
            visibility: "public",
            name: channel.name,
            description: channel.description,
            humanMemberIds: [owner.id],
            members: channel.agentIds.map((agentId) => ({ agentId })),
          },
          owner,
        );
      },
      send: (agentId, text) => service.sendMessage({ agentId, text }, options.owner() ?? undefined).pipe(Effect.asVoid),
      generate: (prompt) =>
        service.generateCheapText(prompt, Date.now() + 90_000).pipe(Effect.orElseSucceed(() => null)),
      notify: (spaceId, text) => notice(text, spaceId),
    },
    reality: {
      spaces: () => spaces.list().map((space) => ({ id: space.id, name: space.name })),
      agents: (spaceId) =>
        agentsOf(spaceId).map((agent) => ({
          id: agent.id,
          name: agent.name,
          workspacePath: agent.workspacePath ?? null,
        })),
      sharedDirectory: (spaceId) => {
        const space = spaces.list().find((entry) => entry.id === spaceId);
        return space ? spaces.sharedDirectory(space) : null;
      },
      agentMessages: (spaceId, since) =>
        channelsOf(spaceId).flatMap((channel) =>
          channels
            .messages(channel.id, Number.MAX_SAFE_INTEGER, 300)
            .filter(
              (message) => message.author.kind === "agent" && !message.deletedAt && message.message.createdAt >= since,
            )
            .map((message) => ({
              agentId: message.author.id,
              text: message.message.text,
              at: message.message.createdAt,
            })),
        ),
      money: (spaceId, since) =>
        report(7).pipe(
          Effect.map((value) => {
            const rows = (value?.money ?? []).filter(
              (entry) => entry.spaceId === spaceId && entry.kind === "revenue" && entry.date >= since.slice(0, 10),
            );
            return {
              revenue: rows.reduce((sum, entry) => sum + entry.amount, 0),
              sales: rows.reduce((sum, entry) => sum + (entry.sales ?? 0), 0),
            };
          }),
        ),
      generate: (prompt) =>
        service.generateCheapText(prompt, Date.now() + 90_000).pipe(Effect.orElseSucceed(() => null)),
      deliver: (spaceId, spaceName, text) => {
        notice(`Reality check · ${spaceName}\n${text}`, spaceId);
        return null;
      },
      timeZone: options.timeZone,
      running: options.running,
    },
    cards: {
      deliver: (card, text, person) => service.sendMessage({ agentId: card.agentId, text }, person).pipe(Effect.asVoid),
    },
    value: {
      insight: (days) =>
        report(days).pipe(
          Effect.map((value) =>
            value
              ? {
                  costs: value.costs.agents.map((agent) => ({
                    agentId: agent.agentId,
                    spaceId: agent.spaceId,
                    costUsd: agent.costUsd,
                  })),
                  money: value.money,
                }
              : null,
          ),
        ),
      agents: () => service.listAgents().map((agent) => ({ id: agent.id, spaceId: spaces.agentSpaceId(agent.id) })),
      spaces: () =>
        spaces.list().length ? spaces.list().map((space) => ({ id: space.id })) : [{ id: GENERAL_SPACE_ID }],
    },
  });
  service.portfolio = portfolio;
  return portfolio;
}
