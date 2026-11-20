import type { SkillConversationEvent } from "@openbot/contracts/ipc";
import { type DynamicRecord, isDynamicRecord } from "@openbot/contracts/runtime-values";
import { Effect } from "effect";
import { type Zippable, zipSync } from "fflate";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type { LearnedSkillDraft, SkillLearner } from "../backend/agent/skill-learning";
import { LocalSkillFailure, type LocalSkillLibrary } from "./local-skill-library";
import type { SkillMarketplaceService } from "./skill-marketplace-service";
import { normalizedFiles } from "./skill-package";

const SKILL_FRONTMATTER = /^---\s*\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u;

/**
 * Saves the skills that the memory reviews learn in the local library, and installs each new revision
 * for the agent that learned it (upstream 0.66). A revision keeps the other files of the skill and its
 * frontmatter, with the new description and instructions.
 */
export function localSkillLearner(skills: SkillMarketplaceService): SkillLearner {
  const library = skills.requireLocalLibrary();
  return {
    read: (skillId) =>
      library.get(skillId).pipe(
        Effect.map((detail) => ({
          description: detail.description,
          instructions: detail.instructions,
          revision: detail.version,
        })),
      ),
    save: (agentId, draft) =>
      Effect.gen(function* () {
        const saved =
          draft.action === "create"
            ? yield* library.createFromBundle(yield* newBundle(draft))
            : yield* library.reviseFromBundle(
                draft.skillId,
                draft.expectedRevision,
                yield* revisedBundle(library, draft),
              );
        yield* skills
          .installLocal({ agentId, skillId: saved.id, revision: saved.version })
          .pipe(Effect.tapError(() => library.withdraw(saved.id, saved.version).pipe(Effect.ignore)));
        const event: SkillConversationEvent = {
          action: draft.action === "create" ? "created" : "revised",
          skillId: saved.id,
          revision: saved.version,
          skillName: saved.name,
        };
        return event;
      }),
  };
}

function newBundle(draft: Extract<LearnedSkillDraft, { action: "create" }>) {
  return bundleSync(() => ({
    "SKILL.md": skillMarkdown({ name: draft.name, description: draft.description }, draft.instructions),
  }));
}

function revisedBundle(library: LocalSkillLibrary, draft: Extract<LearnedSkillDraft, { action: "update" }>) {
  return Effect.gen(function* () {
    const bytes = yield* library.bundle(draft.skillId, draft.expectedRevision);
    return yield* bundleSync(() => {
      const files = normalizedFiles(bytes);
      const skillFile = files["SKILL.md"];
      if (!skillFile) throw new Error("The skill has no SKILL.md to revise.");
      const text = new TextDecoder("utf-8", { fatal: true }).decode(skillFile);
      const metadata = parseYaml(text.match(SKILL_FRONTMATTER)?.[1] ?? "");
      if (!isDynamicRecord(metadata)) throw new Error("The skill has no frontmatter to keep.");
      return {
        ...files,
        "SKILL.md": skillMarkdown({ ...metadata, description: draft.description }, draft.instructions),
      };
    });
  });
}

function skillMarkdown(metadata: DynamicRecord, instructions: string): Uint8Array {
  return new TextEncoder().encode(`---\n${stringifyYaml(metadata)}---\n\n${instructions.trim()}\n`);
}

function bundleSync(files: () => Zippable) {
  return Effect.try({
    try: () => zipSync(files(), { level: 6 }),
    catch: (cause) => new LocalSkillFailure({ cause }),
  });
}
