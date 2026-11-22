import type {
  AgentSuitePage,
  ChatCard,
  ChatCardAnswer,
  ImportTemplateInput,
  QualityPage,
  QualitySettings,
  RateOutcomeInput,
  RealityPage,
  RealityReport,
  RealitySettings,
  SaveSuiteInput,
  SpaceTemplate,
  SpaceTemplateSummary,
  SuiteRun,
  SuiteScenario,
  TemplateImport,
  ValueReport,
} from "@openbot/contracts/portfolio";
import { isDynamicRecord } from "@openbot/contracts/runtime-values";
import { PORTFOLIO_ROUTES } from "@openbot/contracts/team-protocol/portfolio-v1";
import { decodeTeamProtocolV2Json, type TeamProtocolV2Json } from "@openbot/contracts/team-protocol/v2";
import type { TeamApiRequest } from "@openbot/team-client/team-api-requests";

/** The portfolio calls of a host, for an owner or an admin (portfolio-v1). */
export interface PortfolioCalls {
  suite(agentId: string): Promise<AgentSuitePage>;
  saveSuite(input: SaveSuiteInput): Promise<AgentSuitePage>;
  runSuite(agentId: string): Promise<SuiteRun>;
  draftSuite(agentId: string): Promise<SuiteScenario[]>;
  quality(settings?: Partial<QualitySettings>): Promise<QualityPage>;
  templates(): Promise<{ starters: SpaceTemplateSummary[]; imports: TemplateImport[] }>;
  exportTemplate(spaceId: string): Promise<SpaceTemplate>;
  importTemplate(input: ImportTemplateInput): Promise<TemplateImport>;
  decideImport(importId: string, decision: "build" | "stop"): Promise<TemplateImport>;
  value(days: number): Promise<ValueReport>;
  rate(input: RateOutcomeInput): Promise<ValueReport>;
  reality(input: { spaceId?: string; settings?: Partial<RealitySettings> }): Promise<RealityPage>;
  runReality(spaceId: string): Promise<RealityReport>;
  cards(cardIds: readonly string[]): Promise<ChatCard[]>;
  answerCard(cardId: string, answer: ChatCardAnswer): Promise<ChatCard>;
}

// The route codecs of portfolio-v1 check each answer on the way in; these only name its type.
const isSuitePage = (value: unknown): value is AgentSuitePage => isDynamicRecord(value) && Array.isArray(value.runs);
const isRun = (value: unknown): value is SuiteRun => isDynamicRecord(value) && Array.isArray(value.results);
const isScenarios = (value: unknown): value is SuiteScenario[] => Array.isArray(value);
const isQuality = (value: unknown): value is QualityPage => isDynamicRecord(value) && Array.isArray(value.agents);
const isTemplates = (value: unknown): value is { starters: SpaceTemplateSummary[]; imports: TemplateImport[] } =>
  isDynamicRecord(value) && Array.isArray(value.starters) && Array.isArray(value.imports);
const isTemplate = (value: unknown): value is SpaceTemplate => isDynamicRecord(value) && Array.isArray(value.agents);
const isImport = (value: unknown): value is TemplateImport => isDynamicRecord(value) && typeof value.id === "string";
const isValue = (value: unknown): value is ValueReport =>
  isDynamicRecord(value) && Array.isArray(value.spaces) && Array.isArray(value.agents);
const isReality = (value: unknown): value is RealityPage => isDynamicRecord(value) && Array.isArray(value.reports);
const isReport = (value: unknown): value is RealityReport => isDynamicRecord(value) && Array.isArray(value.claims);
const isCard = (value: unknown): value is ChatCard => isDynamicRecord(value) && typeof value.id === "string";
const isCards = (value: unknown): value is ChatCard[] => Array.isArray(value) && value.every(isCard);

function decoder<T>(guard: (value: unknown) => value is T): (value: unknown) => T {
  return (value) => {
    if (!guard(value)) throw new Error("Invalid answer.");
    return value;
  };
}

/** The list or record under `key` of an answer that the route codec already checked. */
function field<T>(key: string, guard: (value: unknown) => value is T): (value: unknown) => T {
  return (value) => {
    const inner = isDynamicRecord(value) ? value[key] : undefined;
    if (!guard(inner)) throw new Error("Invalid answer.");
    return inner;
  };
}

/** What a request of this port sends. */
type PortfolioBody =
  | SaveSuiteInput
  | ImportTemplateInput
  | RateOutcomeInput
  | ChatCardAnswer
  | { settings?: Partial<QualitySettings> }
  | { spaceId?: string; settings?: Partial<RealitySettings> };

/** A plain JSON copy of a value for the request body: absent fields drop out. */
function plain(value: PortfolioBody): TeamProtocolV2Json {
  return decodeTeamProtocolV2Json(JSON.parse(JSON.stringify(value)));
}

export function hostPortfolioCalls(request: () => TeamApiRequest): PortfolioCalls {
  const suitePage = decoder(isSuitePage);
  const value = decoder(isValue);
  return {
    suite: (agentId) => request()("POST", PORTFOLIO_ROUTES.suites, suitePage, { agentId }),
    saveSuite: (input) => request()("POST", PORTFOLIO_ROUTES.saveSuite, suitePage, plain(input)),
    runSuite: (agentId) => request()("POST", PORTFOLIO_ROUTES.runSuite, field("run", isRun), { agentId }),
    draftSuite: (agentId) =>
      request()("POST", PORTFOLIO_ROUTES.draftSuite, field("scenarios", isScenarios), { agentId }),
    quality: (settings) =>
      request()("POST", PORTFOLIO_ROUTES.quality, decoder(isQuality), plain(settings ? { settings } : {})),
    templates: () => request()("POST", PORTFOLIO_ROUTES.templates, decoder(isTemplates), {}),
    exportTemplate: (spaceId) =>
      request()("POST", PORTFOLIO_ROUTES.exportTemplate, field("template", isTemplate), { spaceId }),
    importTemplate: (input) =>
      request()("POST", PORTFOLIO_ROUTES.importTemplate, field("import", isImport), plain(input)),
    decideImport: (importId, decision) =>
      request()("POST", PORTFOLIO_ROUTES.decideImport, field("import", isImport), {
        importId,
        decision,
      }),
    value: (days) => request()("POST", PORTFOLIO_ROUTES.value, value, { days }),
    rate: (input) => request()("POST", PORTFOLIO_ROUTES.rate, value, plain(input)),
    reality: (input) => request()("POST", PORTFOLIO_ROUTES.reality, decoder(isReality), plain(input)),
    runReality: (spaceId) => request()("POST", PORTFOLIO_ROUTES.runReality, field("report", isReport), { spaceId }),
    cards: (cardIds) => request()("POST", PORTFOLIO_ROUTES.cards, field("cards", isCards), { cardIds: [...cardIds] }),
    answerCard: (cardId, answer) =>
      request()("POST", PORTFOLIO_ROUTES.answerCard, field("card", isCard), {
        cardId,
        answer: plain(answer),
      }),
  };
}
