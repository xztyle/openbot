import type {
  EventCheckTemplate,
  EventCheckTemplateApi,
  EventCheckTemplateInstallInput,
} from "@openbot/contracts/event-check-templates";
import type { EventCheck, EventCheckApi } from "@openbot/contracts/event-checks";
import { createStore } from "solid-js";
import type { MarketplaceAgent, SkillRead } from "./marketplace-model";

/** The event check calls of the host that the Marketplace is for. */
export interface MarketplaceEventChecks {
  templates: EventCheckTemplateApi;
  /** The event checks of an agent. The private variables of an installed check go through this too. */
  checks: EventCheckApi;
}

/** An installed check, with the agent that owns it. */
export interface EventCheckInstance {
  agent: MarketplaceAgent;
  check: EventCheck;
}

type TemplateStatus = "idle" | "loading" | "loaded" | "failed";

interface CatalogState {
  templates: EventCheckTemplate[];
  status: TemplateStatus;
  error: string;
  checks: Record<string, EventCheck[]>;
  read: Record<string, SkillRead>;
}

/** The api check an installed event check is, or undefined for a check that reads an MCP tool. */
export function templateLinkOf(check: EventCheck) {
  return check.source.kind === "api" ? check.source.template : undefined;
}

export function isApiCheck(check: EventCheck): boolean {
  return check.source.kind === "api";
}

/** The account label of an api check: the host keeps it as the name of its connection. */
export function accountLabelOf(check: EventCheck): string {
  return check.source.connectionId;
}

export interface EventCheckCatalog {
  templates: () => readonly EventCheckTemplate[];
  status: () => TemplateStatus;
  /** Why the templates did not load, as a sentence. */
  error: () => string;
  /** Reads the templates, unless they are loaded or loading. */
  load: () => void;
  reload: () => void;
  template: (slug: string) => EventCheckTemplate | undefined;
  /** Reads the checks of each agent that has no answer yet. */
  readChecks: () => void;
  checksRead: (agentId: string) => SkillRead;
  /** The agents whose checks could not be read. */
  unreadAgents: () => MarketplaceAgent[];
  /** Every check made from the template, on every agent that was read. */
  instances: (slug: string) => EventCheckInstance[];
  /** The api checks that no template owns. */
  unlinked: () => EventCheckInstance[];
  /** The latest known copy of a check. */
  check: (agentId: string, id: string) => EventCheck | undefined;
  install: (input: EventCheckTemplateInstallInput) => Promise<EventCheck>;
  update: (target: { agentId: string; id: string }) => Promise<EventCheck>;
  adopt: (target: { agentId: string; id: string; slug: string }) => Promise<EventCheck>;
  /** Reads the checks of one agent again, such as after its private variables changed. */
  refresh: (agentId: string) => Promise<void>;
  /** The check api of the host, for the private variables. */
  checkApi: () => EventCheckApi | undefined;
}

/**
 * The templates of the host and the checks that were made from them. Checks are read for each agent
 * on request, because the host lists them per agent. A host change drops an answer that is on its
 * way. A failed call is thrown to the caller, who says it to the user.
 */
export function createEventCheckCatalog(options: {
  source: () => MarketplaceEventChecks | undefined;
  agents: () => readonly MarketplaceAgent[];
  /** The sentence for a failure. */
  message: (error: unknown) => string;
}): EventCheckCatalog {
  const [state, setState] = createStore<CatalogState>({
    templates: [],
    status: "idle",
    error: "",
    checks: {},
    read: {},
  });
  // A read that ends after the host changed belongs to the old host.
  const current = (api: MarketplaceEventChecks) => options.source() === api;

  function load(force: boolean) {
    const api = options.source();
    if (!api || state.status === "loading" || (!force && state.status === "loaded")) return;
    setState((draft) => {
      draft.status = "loading";
      draft.error = "";
    });
    void api.templates.list().then(
      (templates) => {
        if (!current(api)) return;
        setState((draft) => {
          draft.templates = templates;
          draft.status = "loaded";
        });
      },
      (error: unknown) => {
        if (!current(api)) return;
        setState((draft) => {
          draft.status = "failed";
          draft.error = options.message(error);
        });
      },
    );
  }

  async function refresh(agentId: string) {
    const api = options.source();
    if (!api) return;
    setState((draft) => {
      draft.read[agentId] = "loading";
    });
    try {
      const checks = await api.checks.list({ agentId });
      if (!current(api)) return;
      setState((draft) => {
        draft.checks[agentId] = checks;
        draft.read[agentId] = "loaded";
      });
    } catch {
      if (!current(api)) return;
      setState((draft) => {
        draft.read[agentId] = "failed";
      });
    }
  }

  function merge(check: EventCheck) {
    setState((draft) => {
      const known = draft.checks[check.agentId] ?? [];
      draft.checks[check.agentId] = known.some((entry) => entry.id === check.id)
        ? known.map((entry) => (entry.id === check.id ? check : entry))
        : [...known, check];
    });
  }

  function owned(keep: (check: EventCheck) => boolean): EventCheckInstance[] {
    return options.agents().flatMap((agent) =>
      (state.checks[agent.id] ?? []).filter(keep).map((check) => ({
        agent,
        check,
      })),
    );
  }

  function required(): MarketplaceEventChecks {
    const api = options.source();
    if (!api) throw new Error("Event checks are not available on this host.");
    return api;
  }

  return {
    templates: () => state.templates,
    status: () => state.status,
    error: () => state.error,
    load: () => load(false),
    reload: () => load(true),
    template: (slug) => state.templates.find((template) => template.slug === slug),
    readChecks: () => {
      for (const agent of options.agents()) {
        const read = state.read[agent.id] ?? "idle";
        if (read === "idle" || read === "failed") void refresh(agent.id);
      }
    },
    checksRead: (agentId) => state.read[agentId] ?? "idle",
    unreadAgents: () => options.agents().filter((agent) => state.read[agent.id] === "failed"),
    instances: (slug) => owned((check) => templateLinkOf(check)?.slug === slug),
    unlinked: () => owned((check) => isApiCheck(check) && !templateLinkOf(check)),
    check: (agentId, id) => state.checks[agentId]?.find((entry) => entry.id === id),
    install: async (input) => {
      const check = await required().templates.install(input);
      merge(check);
      return check;
    },
    update: async (target) => {
      const check = await required().templates.update(target);
      merge(check);
      return check;
    },
    adopt: async (target) => {
      const check = await required().templates.adopt(target);
      merge(check);
      return check;
    },
    refresh,
    checkApi: () => options.source()?.checks,
  };
}
