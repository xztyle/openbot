import {
  parseAnswerChatCardInput,
  parseChatCardIds,
  parseImportTemplateInput,
  parsePortfolioAgentInput,
  parsePortfolioSpaceInput,
  parseQualityInput,
  parseRateOutcomeInput,
  parseRealityInput,
  parseSaveSuiteInput,
  parseTemplateImportDecision,
} from "@openbot/contracts/portfolio";
import { isDynamicRecord } from "@openbot/contracts/runtime-values";
import { AGENT_EFFICIENCY_CAPABILITY } from "@openbot/contracts/team-protocol/agent-efficiency-v1";
import { PORTFOLIO_ROUTES } from "@openbot/contracts/team-protocol/portfolio-v1";
import { sourceText } from "@openbot/i18n/source";
import { Effect, Result } from "effect";
import type { TeamApiAgents } from "./dependencies";
import { HttpError } from "./http-error";
import type { RouteOutcome, TeamApiRequestContext } from "./request-context";
import { memberSender, readJson, requireAdmin } from "./request-helpers";

function parsed<T>(parse: (value: unknown) => T, value: unknown): T {
  try {
    return parse(value);
  } catch {
    throw new HttpError(400, "Invalid request.");
  }
}

/** Runs the effect; a failure, or the error that a typed failure wraps, answers 409 with its text. */
async function refused<A>(effect: Effect.Effect<A, unknown>): Promise<A> {
  let failure: unknown;
  try {
    const result = await Effect.runPromise(Effect.result(effect));
    if (Result.isSuccess(result)) return result.success;
    failure = result.failure;
  } catch (error) {
    failure = error;
  }
  if (failure instanceof HttpError) throw failure;
  const inner = isDynamicRecord(failure) && failure.cause instanceof Error ? failure.cause : failure;
  const message = inner instanceof Error ? inner.message : String(inner);
  throw new HttpError(409, message.slice(0, 500) || "The request was refused.");
}

/**
 * The portfolio routes of this fork (`portfolio-v1.ts`, under `fork-host-v1`): each agent's test suite
 * and live score, the space templates with their validation stage, the value of each space and agent,
 * the weekly reality check and the interactive cards. Owners and admins.
 */
export async function routePortfolio(
  context: TeamApiRequestContext,
  agents: TeamApiAgents,
  hiddenAgentIds: ReadonlySet<string>,
): Promise<RouteOutcome> {
  const { method, url, capabilities, member, request, json } = context;
  if (method !== "POST" || !Object.values(PORTFOLIO_ROUTES).some((route) => route === url.pathname)) return "unmatched";
  const portfolio = agents.portfolio;
  if (!capabilities.has(AGENT_EFFICIENCY_CAPABILITY) || !portfolio)
    throw new HttpError(400, sourceText("error.team.workspaceUnsupported"));
  requireAdmin(member);
  const body = await readJson(request);
  const requireVisible = (agentId: string) => {
    if (hiddenAgentIds.has(agentId) || !agents.listAgents().some((agent) => agent.id === agentId))
      throw new HttpError(404, "Unknown agent.");
  };
  switch (url.pathname) {
    case PORTFOLIO_ROUTES.suites: {
      const input = parsed(parsePortfolioAgentInput, body);
      requireVisible(input.agentId);
      return json(200, await refused(portfolio.suites.page(input.agentId)));
    }
    case PORTFOLIO_ROUTES.saveSuite: {
      const input = parsed(parseSaveSuiteInput, body);
      requireVisible(input.agentId);
      return json(200, await refused(portfolio.suites.save(input)));
    }
    case PORTFOLIO_ROUTES.runSuite: {
      const input = parsed(parsePortfolioAgentInput, body);
      requireVisible(input.agentId);
      const run = await refused(portfolio.suites.run(input.agentId, "manual", "Run by the owner"));
      if (!run) throw new HttpError(409, "The agent has no test scenarios yet.");
      return json(200, { run });
    }
    case PORTFOLIO_ROUTES.draftSuite: {
      const input = parsed(parsePortfolioAgentInput, body);
      requireVisible(input.agentId);
      return json(200, { scenarios: await refused(portfolio.suites.draft(input.agentId)) });
    }
    case PORTFOLIO_ROUTES.quality: {
      const input = parsed(parseQualityInput, body);
      const ids = agents
        .listAgents()
        .map((agent) => agent.id)
        .filter((agentId) => !hiddenAgentIds.has(agentId));
      return json(200, await refused(portfolio.quality.page(input.settings, ids)));
    }
    case PORTFOLIO_ROUTES.templates:
      return json(200, {
        starters: portfolio.templates.starters(),
        imports: await refused(portfolio.templates.imports()),
      });
    case PORTFOLIO_ROUTES.exportTemplate: {
      const input = parsed(parsePortfolioSpaceInput, body);
      if (!input.spaceId) throw new HttpError(400, "Invalid request.");
      return json(200, { template: await refused(portfolio.templates.export(input.spaceId)) });
    }
    case PORTFOLIO_ROUTES.importTemplate: {
      const input = parsed(parseImportTemplateInput, body);
      return json(200, { import: await refused(portfolio.templates.import(input)) });
    }
    case PORTFOLIO_ROUTES.decideImport: {
      const input = parsed(parseTemplateImportDecision, body);
      return json(200, { import: await refused(portfolio.templates.decide(input.importId, input.decision)) });
    }
    case PORTFOLIO_ROUTES.value: {
      const days = isDynamicRecord(body) && typeof body.days === "number" ? Math.round(body.days) : 30;
      return json(200, await refused(portfolio.value(Math.min(Math.max(days, 7), 90))));
    }
    case PORTFOLIO_ROUTES.rate: {
      const input = parsed(parseRateOutcomeInput, body);
      if (input.agentId) requireVisible(input.agentId);
      await refused(portfolio.ledger.rate(input));
      return json(200, await refused(portfolio.value(30)));
    }
    case PORTFOLIO_ROUTES.reality: {
      const input = parsed(parseRealityInput, body);
      return json(200, await refused(portfolio.reality.page(input)));
    }
    case PORTFOLIO_ROUTES.runReality: {
      const input = parsed(parsePortfolioSpaceInput, body);
      if (!input.spaceId) throw new HttpError(400, "Invalid request.");
      const report = await refused(portfolio.reality.run(input.spaceId));
      if (!report) throw new HttpError(404, "Unknown space.");
      return json(200, { report });
    }
    case PORTFOLIO_ROUTES.cards: {
      const input = parsed(parseChatCardIds, body);
      const cards = await refused(portfolio.cards.get(input.cardIds));
      return json(200, { cards: cards.filter((card) => !hiddenAgentIds.has(card.agentId)) });
    }
    default: {
      const input = parsed(parseAnswerChatCardInput, body);
      const person = memberSender(member) ?? { id: member.id, name: "Owner" };
      return json(200, { card: await refused(portfolio.cards.answer(input.cardId, input.answer, person)) });
    }
  }
}
