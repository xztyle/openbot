import { agentAutomationAllowed, type MarketplaceSkillDetail } from "@openbot/contracts/ipc";
import { Bell, BookMarked, CalendarClock, Folder, Gauge, Puzzle, Table2, Upload } from "@openbot/ui";
import { SettingsLinkGroup, SettingsLinkRow } from "@openbot/ui/components/SettingsPanel";
import type { AgentProfile } from "@openbot/ui/data";
import SharedAgentSettingsPanel, {
  type AgentSettingsPanelProps as SharedAgentSettingsPanelProps,
} from "@openbot/ui/features/conversation/AgentSettingsPanel";
import { EventChecksSettings } from "@openbot/ui/features/conversation/EventChecksSettings";
import { agentFilesLinkValue } from "@openbot/ui/features/files/AgentFilesView";
import { useText } from "@openbot/ui/text";
import { createEffect, createMemo, createStore, Show, untrack } from "solid-js";
import { createSettingsPanelWidth, saveSettingsPanelWidth } from "../../components/settings-panel-width";
import { agentSkillCalls, skillsPort } from "../../skills-port";
import { type AgentFilesOptions, AgentFilesSettings } from "../files/AgentFilesSettings";
import { createStorageUsage } from "../files/storage-usage";
import { AgentMemoriesModal } from "./AgentMemoriesModal";
import { AgentRoutinesSettings, type RoutineSelectionRequest } from "./AgentRoutinesSettings";
import { AgentSkillsModal, type AgentSkillsMode, assignedSkillCount } from "./AgentSkillsModal";
import { conversationPort, type SharedTableCalls } from "./conversation-port";
import type { ConversationRuntime } from "./conversation-runtime";
import { agentMemoriesPort } from "./memories-port";
import type { EventRoutinesApi } from "./routine-webhooks-api";
import { agentRoutinesPort, eventRoutinesPort } from "./routines-port";
import { SharedTablesModal } from "./SharedTablesModal";

interface AgentSettingsPanelProps
  extends Omit<
    SharedAgentSettingsPanelProps,
    "width" | "onResize" | "onResizeEnd" | "links" | "detailOpen" | "children"
  > {
  remoteClient?: boolean;
  /** The memory cap of an agent on this computer. Absent for a remote agent: its host enforces its own. */
  memoryLimit?: number;
  /** The web client's host calls for the settings that its server supports. */
  adminCalls?: ConversationRuntime["admin"];
  onPublish?: () => void;
  onOpenUsage?: (trigger: HTMLButtonElement) => void;
  onWidthChange: (width: number) => void;
  skillSelectionRequest?: { skillId: string } | null;
  routineSelectionRequest?: RoutineSelectionRequest | null;
  onRoutineSelectionRequestHandled?: (nonce: number) => void;
  onOpenRoutineRun?: (messageId: string) => void;
  skillsMode?: AgentSkillsMode;
  /** The joined server that runs the agent, for the `host` skills mode. */
  skillsServerId?: string | undefined;
  skillsMarketplaceOpen?: boolean;
  /** The shared data lives on the computer that runs the agents. A joined server shows it to an admin only. */
  tablesVisible?: boolean;
  /** Names the agent that keeps each set of records. Threaded like `customProviders`, for the same reason. */
  agents?: readonly AgentProfile[];
  /** Event routine calls for a host that advertises `events-v1`; absent keeps the released schedule API. */
  eventRoutines?: EventRoutinesApi;
  eventChecksAvailable?: boolean;
  apiEventChecksAvailable?: boolean;
  /** Whether the host keeps the delivery setting of a check. */
  eventCheckDeliveryAvailable?: boolean;
  onCreateSkill?: () => void;
  onTrySkill?: (skill: MarketplaceSkillDetail) => void;
  onAddFromMarketplace?: (agentId: string) => void;
  /** The Files row. Left out for a remote server without `storage-v1`. */
  files?: AgentFilesOptions;
}

export type { AgentSkillsMode };

export default function AgentSettingsPanel(props: AgentSettingsPanelProps) {
  const { t } = useText();
  const [panelWidth, setPanelWidth] = createSettingsPanelWidth();
  const [draft, setDraft] = createStore({
    tables: { count: 0, open: false },
    memories: { count: 0, open: false },
    routines: { count: 0, open: false },
    checks: { count: 0, open: false },
    files: { open: false },
    skills: { count: 0, open: false, reopenAfterMarketplace: false },
  });
  const memoriesPort = createMemo(
    () =>
      props.adminCalls?.memories?.(props.agent.id, props.agent.name) ??
      agentMemoriesPort(props.agent.id, props.agent.name, props.memoryLimit ?? null),
  );
  /** A remote client shows Memories only where it has host calls for them, as the web client does. */
  const memoriesVisible = () => !props.remoteClient || Boolean(props.adminCalls?.memories);
  const legacyRoutinesPort = createMemo(() =>
    agentRoutinesPort(
      props.agent.id,
      props.automationEditable === true && agentAutomationAllowed(props.agent),
      // Set only for the host on this computer, the one place the policy is kept.
      props.automationEditable === true,
    ),
  );
  const checksApi = () =>
    props.remoteClient
      ? props.adminCalls?.eventChecks
      : props.eventChecksAvailable !== false
        ? window.openbot.eventChecks
        : undefined;
  /** The templates of the host, so a setting that a template declares as a picker can be filled from a list. */
  const pickerSource = () =>
    props.remoteClient
      ? props.adminCalls?.eventCheckTemplates
      : props.eventChecksAvailable !== false
        ? window.openbot.eventCheckTemplates
        : undefined;
  const routinesVisible = () => !props.remoteClient || Boolean(props.adminCalls?.routines);
  /**
   * Whether a detail view is on screen. A detail whose capability is momentarily missing renders
   * nothing, so it must not hide the header and the settings under it.
   */
  const detailOpen = () =>
    draft.routines.open || (draft.files.open && Boolean(props.files)) || (draft.checks.open && Boolean(checksApi()));
  const routinesPort = createMemo(() => {
    if (props.adminCalls?.routines) return props.adminCalls.routines(props.agent.id);
    const eventApi = props.eventRoutines ?? props.adminCalls?.eventRoutines;
    return eventApi
      ? eventRoutinesPort({ kind: "agent", id: props.agent.id }, eventApi, legacyRoutinesPort())
      : legacyRoutinesPort();
  });
  const skillsMode = () => props.skillsMode ?? "mutable";
  const tableCalls = (): SharedTableCalls => props.adminCalls?.sharedTables ?? conversationPort().agent;
  const skillCalls = () =>
    props.adminCalls?.skills ?? agentSkillCalls(skillsMode() === "host" ? props.skillsServerId : undefined);
  const storage = createStorageUsage(() => {
    const files = props.files;
    return files ? { serverId: files.serverId, input: { scope: "agent", agentId: props.agent.id } } : null;
  });
  let lastSkillsMarketplaceOpen = untrack(() => props.skillsMarketplaceOpen === true);
  createEffect(
    () => panelWidth(),
    (width) => {
      props.onWidthChange(width);
    },
  );

  createEffect(
    () => props.agent.id,
    (agentId) => {
      setDraft((state) => {
        state.tables.open = false;
        state.memories.open = false;
        state.routines.open = false;
        state.checks.open = false;
        state.files.open = false;
        state.skills.open = false;
        state.skills.reopenAfterMarketplace = false;
      });
      if (untrack(() => !props.remoteClient || props.tablesVisible !== false)) {
        void tableCalls()
          .listTables()
          .catch(() => [])
          .then((items) => {
            setDraft((state) => {
              state.tables.count = items.length;
            });
          });
      }
      void untrack(() => loadSkillsCount(agentId));
      const checks = checksApi();
      if (checks)
        void checks
          .list({ agentId })
          .then((items) =>
            setDraft((draft) => {
              draft.checks.count = items.length;
            }),
          )
          .catch(() => {});
      if (routinesVisible())
        void routinesPort()
          .list()
          .then((items) =>
            setDraft((draft) => {
              draft.routines.count = items.length;
            }),
          )
          .catch(() => {});
      if (memoriesVisible()) {
        void memoriesPort()
          .list()
          .catch(() => [])
          .then((items) => {
            setDraft((state) => {
              state.memories.count = items.length;
            });
          });
      }
    },
  );

  // The count follows a skill change made anywhere, as the dialog does.
  createEffect(
    () => [props.agent.id, skillsMode(), skillCalls()] as const,
    ([agentId, mode, calls]) => {
      if (mode === "hidden" || !calls.onChanged) return;
      return calls.onChanged((changedId) => {
        if (changedId === agentId) void loadSkillsCount(agentId);
      });
    },
  );

  async function loadSkillsCount(agentId: string): Promise<void> {
    if (skillsMode() === "hidden") {
      setDraft((state) => {
        state.skills.count = 0;
      });
      return;
    }
    try {
      const items =
        skillsMode() === "readonly"
          ? await skillsPort().agent.listInstalledSkills(agentId)
          : await skillCalls().listInstalled(agentId);
      setDraft((state) => {
        state.skills.count = assignedSkillCount(items);
      });
    } catch {
      setDraft((state) => {
        state.skills.count = 0;
      });
    }
  }

  createEffect(
    () => props.skillsMarketplaceOpen === true,
    (open) => {
      if (lastSkillsMarketplaceOpen && !open && untrack(() => draft.skills.reopenAfterMarketplace)) {
        setDraft((state) => {
          state.skills.reopenAfterMarketplace = false;
          state.skills.open = true;
        });
      }
      lastSkillsMarketplaceOpen = open;
    },
  );

  createEffect(
    () => ({ request: props.routineSelectionRequest, agentId: props.agent.id }),
    ({ request }) => {
      if (request) {
        setDraft((state) => {
          state.routines.open = true;
        });
      }
    },
  );

  createEffect(
    () => props.skillSelectionRequest,
    (request) => {
      if (request)
        setDraft((state) => {
          state.skills.open = true;
        });
    },
  );

  return (
    <SharedAgentSettingsPanel
      {...props}
      width={panelWidth()}
      onResize={setPanelWidth}
      onResizeEnd={saveSettingsPanelWidth}
      detailOpen={detailOpen()}
      links={
        <>
          <Show when={memoriesVisible() || skillsMode() !== "hidden" || props.tablesVisible !== false || props.files}>
            <SettingsLinkGroup inset title={t("agentSettings.groups.knows")}>
              <Show when={memoriesVisible()}>
                <SettingsLinkRow
                  icon={<BookMarked aria-hidden="true" />}
                  label={t("agentSettings.links.memories")}
                  value={t("agentSettings.links.memoriesCount", { count: draft.memories.count })}
                  onClick={() =>
                    setDraft((state) => {
                      state.memories.open = true;
                    })
                  }
                />
              </Show>
              <Show when={skillsMode() !== "hidden"}>
                <SettingsLinkRow
                  icon={<Puzzle aria-hidden="true" />}
                  label={t("agentSettings.links.skills")}
                  value={t("agentSettings.links.skillsCount", { count: draft.skills.count })}
                  onClick={() =>
                    setDraft((state) => {
                      state.skills.open = true;
                    })
                  }
                />
              </Show>
              <Show when={props.files}>
                <SettingsLinkRow
                  icon={<Folder aria-hidden="true" />}
                  label={t("agentSettings.links.files")}
                  value={storage.state.usage ? agentFilesLinkValue(storage.state.usage.breakdown) : undefined}
                  onClick={() =>
                    setDraft((state) => {
                      state.files.open = true;
                    })
                  }
                />
              </Show>
              <Show when={props.tablesVisible !== false}>
                <SettingsLinkRow
                  icon={<Table2 aria-hidden="true" />}
                  label={t("agentSettings.links.tables")}
                  value={t("agentSettings.links.tablesCount", { count: draft.tables.count })}
                  onClick={() =>
                    setDraft((state) => {
                      state.tables.open = true;
                    })
                  }
                />
              </Show>
            </SettingsLinkGroup>
          </Show>
          <Show
            when={routinesVisible() || checksApi() || (!props.remoteClient && props.onOpenUsage) || props.onPublish}
          >
            <SettingsLinkGroup inset title={t("agentSettings.groups.does")}>
              <Show when={routinesVisible()}>
                <SettingsLinkRow
                  icon={<CalendarClock aria-hidden="true" />}
                  label={t("agentSettings.links.routines")}
                  value={t("agentSettings.links.routinesCount", { count: draft.routines.count })}
                  onClick={() =>
                    setDraft((state) => {
                      state.routines.open = true;
                    })
                  }
                />
              </Show>
              <Show when={checksApi()}>
                <SettingsLinkRow
                  icon={<Bell aria-hidden="true" />}
                  label={t("agentSettings.links.eventChecks")}
                  value={t("agentSettings.links.eventChecksCount", { count: draft.checks.count })}
                  onClick={() =>
                    setDraft((state) => {
                      state.checks.open = true;
                    })
                  }
                />
              </Show>
              <Show when={!props.remoteClient && props.onOpenUsage}>
                <SettingsLinkRow
                  icon={<Gauge aria-hidden="true" />}
                  label={t("agentSettings.links.usage")}
                  onClick={(trigger) => props.onOpenUsage?.(trigger)}
                />
              </Show>
              <Show when={props.onPublish}>
                <SettingsLinkRow
                  icon={<Upload aria-hidden="true" />}
                  label={t("conversation.header.publish")}
                  onClick={() => props.onPublish?.()}
                />
              </Show>
            </SettingsLinkGroup>
          </Show>
        </>
      }
    >
      <Show when={draft.files.open && props.files}>
        {(files) => (
          <AgentFilesSettings
            {...files()}
            agentName={props.agent.name}
            storage={storage}
            onBack={() =>
              setDraft((state) => {
                state.files.open = false;
              })
            }
            onClose={props.onClose}
          />
        )}
      </Show>
      <Show when={draft.checks.open && checksApi()}>
        {(api) => (
          <div class="agent-routines-overlay">
            <EventChecksSettings
              api={api()}
              pickers={pickerSource()}
              apiProgramsAvailable={
                props.remoteClient ? Boolean(api().environment) : (props.apiEventChecksAvailable ?? true)
              }
              deliveryAvailable={
                props.remoteClient
                  ? props.adminCalls?.eventChecks?.deliverySettings === true
                  : (props.eventCheckDeliveryAvailable ?? true)
              }
              agentId={props.agent.id}
              onCountChange={(count) =>
                setDraft((draft) => {
                  draft.checks.count = count;
                })
              }
              onBack={() =>
                setDraft((draft) => {
                  draft.checks.open = false;
                })
              }
              onClose={props.onClose}
            />
          </div>
        )}
      </Show>
      <Show when={draft.routines.open}>
        <div class="agent-routines-overlay">
          <AgentRoutinesSettings
            port={routinesPort()}
            onCountChange={(count) =>
              setDraft((state) => {
                state.routines.count = count;
              })
            }
            onBack={() =>
              setDraft((state) => {
                state.routines.open = false;
              })
            }
            onClose={props.onClose}
            selectionRequest={props.routineSelectionRequest}
            onSelectionRequestHandled={props.onRoutineSelectionRequestHandled}
            onOpenRun={props.onOpenRoutineRun}
          />
        </div>
      </Show>
      <Show when={props.tablesVisible !== false}>
        <SharedTablesModal
          agents={props.agents ?? []}
          calls={props.adminCalls?.sharedTables}
          open={draft.tables.open}
          onOpenChange={(open) =>
            setDraft((state) => {
              state.tables.open = open;
            })
          }
          onCountChange={(count) =>
            setDraft((state) => {
              state.tables.count = count;
            })
          }
        />
      </Show>
      <AgentMemoriesModal
        port={memoriesPort()}
        open={draft.memories.open}
        onOpenChange={(open) =>
          setDraft((state) => {
            state.memories.open = open;
          })
        }
        onCountChange={(count) =>
          setDraft((state) => {
            state.memories.count = count;
          })
        }
      />
      <Show when={skillsMode() !== "hidden"}>
        <AgentSkillsModal
          selectionRequest={props.skillSelectionRequest}
          agentId={props.agent.id}
          agentName={props.agent.name}
          open={draft.skills.open}
          skillsMode={skillsMode()}
          serverId={props.skillsServerId}
          calls={props.adminCalls?.skills}
          catalog={props.remoteClient ? null : undefined}
          onCreateSkill={props.onCreateSkill}
          onTrySkill={props.onTrySkill}
          onAddFromMarketplace={
            props.onAddFromMarketplace
              ? (agentId) => {
                  setDraft((state) => {
                    state.skills.reopenAfterMarketplace = true;
                    state.skills.open = false;
                  });
                  props.onAddFromMarketplace?.(agentId);
                }
              : undefined
          }
          onOpenChange={(open) =>
            setDraft((state) => {
              state.skills.open = open;
            })
          }
          onCountChange={(count) =>
            setDraft((state) => {
              state.skills.count = count;
            })
          }
        />
      </Show>
    </SharedAgentSettingsPanel>
  );
}
