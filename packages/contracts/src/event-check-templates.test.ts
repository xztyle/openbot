import { describe, expect, it } from "vitest";
import {
  decodeEventCheckDiscoverCheckInput,
  decodeEventCheckPickerOptions,
  decodeEventCheckTemplate,
  decodeEventCheckTemplateDiscoverInput,
  EVENT_CHECK_PICKER_MAX_ENTRIES,
  EVENT_CHECK_PICKER_MAX_OPTIONS,
  formatEventCheckPickerValue,
  parseEventCheckPickerValue,
} from "./event-check-templates";
import {
  EVENT_CHECK_TEMPLATES_CAPABILITY,
  EVENT_CHECK_TEMPLATES_CODECS,
  EVENT_CHECK_TEMPLATES_ROUTES,
} from "./team-protocol/event-check-templates-v1";
import { FORK_HOST_CAPABILITY } from "./team-protocol/fork-host-v1";

const picker = {
  optionsFrom: "program",
  modes: [
    { value: "all", label: "All messages" },
    { value: "mentions", label: "Only mentions" },
  ],
} as const;
const pickerField = {
  name: "conversationRules",
  label: "Conversations",
  description: "Pick them.",
  value: "",
  required: false,
  type: "text",
  picker,
};
const template = {
  slug: "slack-activity",
  name: "Slack activity",
  tagline: "t",
  description: "d",
  version: "1.3.0",
  creatorName: "OpenBot",
  iconUrl: null,
  websiteUrl: null,
  app: null,
  program: { file: "slack-activity.mjs", digest: "a".repeat(64) },
  accountLabelHint: "Work",
  variables: [],
  configuration: [pickerField],
  argumentsJson: "{}",
  cursorArgument: "cursor",
  nextCursorPointer: "/cursor",
  selection: { itemsPointer: "/items", idPointer: "/id", revisionPointer: "/revision" },
  actorPointer: "/actor",
  intervalSeconds: 120,
  instruction: "Look.",
};

describe("picker values", () => {
  it("round-trips ID:mode pairs and treats an empty value as no entries", () => {
    expect(parseEventCheckPickerValue("", picker)).toEqual([]);
    expect(parseEventCheckPickerValue(" C012ABCDE:all , D012ABCDE:mentions ", picker)).toEqual([
      { id: "C012ABCDE", mode: "all" },
      { id: "D012ABCDE", mode: "mentions" },
    ]);
    expect(formatEventCheckPickerValue(parseEventCheckPickerValue("C1ABC:all,D1ABC:mentions", picker))).toBe(
      "C1ABC:all,D1ABC:mentions",
    );
  });

  it("refuses a mode the picker does not declare, a repeated ID, a bad ID and a malformed pair", () => {
    for (const value of [
      "C012ABCDE",
      "C012ABCDE:everything",
      "C012ABCDE:all,C012ABCDE:mentions",
      "C012 ABCDE:all",
      ":all",
      "C012ABCDE:all:mentions",
      "C012ABCDE:all,,D1ABC:all",
      `${"C".repeat(65)}:all`,
    ])
      expect(() => parseEventCheckPickerValue(value, picker), value).toThrow();
  });

  it("refuses more entries than the limit", () => {
    const entries = (count: number) => Array.from({ length: count }, (_, index) => `C${1000 + index}:all`).join(",");
    expect(parseEventCheckPickerValue(entries(EVENT_CHECK_PICKER_MAX_ENTRIES), picker)).toHaveLength(
      EVENT_CHECK_PICKER_MAX_ENTRIES,
    );
    expect(() => parseEventCheckPickerValue(entries(EVENT_CHECK_PICKER_MAX_ENTRIES + 1), picker)).toThrow();
  });
});

describe("template picker field", () => {
  it("keeps the field a text field on the wire and carries the picker beside it", () => {
    const decoded = decodeEventCheckTemplate(template);
    const field = decoded.configuration[0];
    expect(field).toMatchObject({ type: "text", picker });
    // The decoder an older client has reads only the fields it knows, so this field is a text box there.
    expect(JSON.parse(JSON.stringify(field))).toMatchObject({ type: "text" });
  });

  it("leaves a field without a picker exactly as before", () => {
    const { picker: _picker, ...plain } = pickerField;
    const decoded = decodeEventCheckTemplate({ ...template, configuration: [plain] });
    expect(decoded.configuration[0]).not.toHaveProperty("picker");
  });

  it("refuses a malformed picker, a picker on a boolean, and a default that is not a valid value", () => {
    const withField = (field: Partial<typeof pickerField> | { picker: unknown; type?: string }) =>
      decodeEventCheckTemplate({ ...template, configuration: [{ ...pickerField, ...field }] });
    expect(() => withField({ picker: { optionsFrom: "url", modes: picker.modes } })).toThrow();
    expect(() => withField({ picker: { optionsFrom: "program", modes: [] } })).toThrow();
    expect(() =>
      withField({
        picker: { optionsFrom: "program", modes: [picker.modes[0], picker.modes[0]] },
      }),
    ).toThrow();
    expect(() =>
      withField({ picker: { optionsFrom: "program", modes: [{ value: "Bad Mode", label: "x" }] } }),
    ).toThrow();
    expect(() => withField({ type: "boolean", value: "true" })).toThrow();
    expect(() => withField({ value: "C012ABCDE:sometimes" })).toThrow();
    expect(withField({ value: "C012ABCDE:all" }).configuration[0]?.value).toBe("C012ABCDE:all");
  });
});

describe("picker options", () => {
  it("cleans text that another party wrote and keeps an ID once", () => {
    const decoded = decodeEventCheckPickerOptions({
      options: [
        { id: "C012ABCDE", label: "#gen\u0000eral‮\n  chat", group: "channel", description: "A\tB" },
        { id: "C012ABCDE", label: "#again", group: "channel" },
        { id: "D012ABCDE", label: "\u0007", group: "dm" },
      ],
      truncated: true,
    });
    expect(decoded).toEqual({
      options: [
        { id: "C012ABCDE", label: "#general chat", group: "channel", description: "A B" },
        { id: "D012ABCDE", label: "D012ABCDE", group: "dm" },
      ],
      truncated: true,
    });
  });

  it("bounds the length of a label and refuses a wrong shape or too many options", () => {
    const long = decodeEventCheckPickerOptions({
      options: [{ id: "C1ABC", label: "x".repeat(500), group: "channel" }],
    });
    expect(Array.from(long.options[0]?.label ?? "")).toHaveLength(120);
    const many = (count: number) => ({
      options: Array.from({ length: count }, (_, index) => ({ id: `C${index}AB`, label: "x", group: "channel" })),
    });
    expect(decodeEventCheckPickerOptions(many(EVENT_CHECK_PICKER_MAX_OPTIONS)).options).toHaveLength(
      EVENT_CHECK_PICKER_MAX_OPTIONS,
    );
    expect(() => decodeEventCheckPickerOptions(many(EVENT_CHECK_PICKER_MAX_OPTIONS + 1))).toThrow();
    for (const bad of [
      null,
      { options: "no" },
      { options: [{ id: "has space", label: "x", group: "channel" }] },
      { options: [{ id: "C1ABC", label: 3, group: "channel" }] },
      { options: [{ id: "C1ABC", label: "x", group: "Bad Group" }] },
      { options: [], truncated: "yes" },
    ])
      expect(() => decodeEventCheckPickerOptions(bad)).toThrow();
  });
});

describe("picker account", () => {
  it("keeps the account of an answer and drops a wrong one without failing the list", () => {
    const options = [{ id: "C1ABC", label: "#general", group: "channel" }];
    expect(
      decodeEventCheckPickerOptions({ options, account: { id: "U012ABCDE", label: " pat\u0007 (Acme) " } }),
    ).toEqual({ options, account: { id: "U012ABCDE", label: "pat (Acme)" } });
    for (const account of ["pat", { id: "has space", label: "x" }, { id: "U1ABC", label: 3 }, null])
      expect(decodeEventCheckPickerOptions({ options, account })).toEqual({ options });
  });

  it("keeps the time of a list and its stale mark, and drops either when it is wrong", () => {
    const options = [{ id: "C1ABC", label: "#general", group: "channel" }];
    const readAt = "2026-10-10T06:00:00.000Z";
    expect(decodeEventCheckPickerOptions({ options, readAt })).toEqual({ options, readAt });
    expect(decodeEventCheckPickerOptions({ options, readAt, stale: true })).toEqual({ options, readAt, stale: true });
    // A mark without a time says nothing a person could use, and a wrong time is no time.
    expect(decodeEventCheckPickerOptions({ options, stale: true })).toEqual({ options });
    expect(decodeEventCheckPickerOptions({ options, readAt: "yesterday", stale: "yes" })).toEqual({ options });
  });
});

describe("discovery requests", () => {
  it("reads a draft request with its private values and refuses the wrong shape without echoing a value", () => {
    const input = decodeEventCheckTemplateDiscoverInput({
      slug: "slack-activity",
      field: "conversationRules",
      configuration: { userId: "U012ABCDE" },
      variables: { SLACK_USER_TOKEN: "x" },
    });
    expect(input.variables).toEqual({ SLACK_USER_TOKEN: "x" });
    const secret = "SECRET-VALUE-THAT-MUST-NOT-LEAK";
    for (const bad of [
      { slug: "slack-activity", field: "a b", configuration: {}, variables: {} },
      { slug: "slack-activity", field: "f", configuration: { a: 1 }, variables: {} },
      { slug: "slack-activity", field: "f", configuration: {}, variables: { path: secret } },
      { slug: "slack-activity", field: "f", configuration: {}, variables: { PATH: secret } },
      { slug: "slack-activity", field: "f", configuration: {}, variables: { TOKEN: secret.repeat(1000) } },
      { slug: "Bad Slug", field: "f", configuration: {}, variables: {} },
    ]) {
      let message = "";
      try {
        decodeEventCheckTemplateDiscoverInput(bad);
      } catch (error) {
        message = error instanceof Error ? error.message : "";
      }
      expect(message).not.toBe("");
      expect(message).not.toContain("SECRET");
    }
  });

  it("reads the IDs that a discovery names, and refuses a wrong one or too many", () => {
    const draft = { slug: "slack-activity", field: "conversationRules", configuration: {}, variables: {} };
    expect(decodeEventCheckTemplateDiscoverInput({ ...draft, ids: ["C1ABC", "D2DEF", "C1ABC"] }).ids).toEqual([
      "C1ABC",
      "D2DEF",
    ]);
    expect(decodeEventCheckTemplateDiscoverInput({ ...draft, ids: [] })).not.toHaveProperty("ids");
    expect(decodeEventCheckTemplateDiscoverInput(draft)).not.toHaveProperty("ids");
    const target = { agentId: "chief", id: "c1", field: "conversationRules" };
    expect(decodeEventCheckDiscoverCheckInput({ ...target, ids: ["C1ABC"] })).toEqual({ ...target, ids: ["C1ABC"] });
    for (const bad of [
      ["has space"],
      [3],
      "C1ABC",
      Array.from({ length: EVENT_CHECK_PICKER_MAX_ENTRIES + 1 }, (_, index) => `C${index}AB`),
    ]) {
      expect(() => decodeEventCheckDiscoverCheckInput({ ...target, ids: bad })).toThrow();
      expect(() => decodeEventCheckTemplateDiscoverInput({ ...draft, ids: bad })).toThrow();
    }
  });

  it("reads the request to read the app again", () => {
    const target = { agentId: "chief", id: "c1", field: "conversationRules" };
    expect(decodeEventCheckDiscoverCheckInput({ ...target, refresh: true })).toEqual({ ...target, refresh: true });
    expect(decodeEventCheckDiscoverCheckInput({ ...target, refresh: "yes" })).toEqual(target);
  });

  it("reads the target of an installed check", () => {
    expect(decodeEventCheckDiscoverCheckInput({ agentId: "chief", id: "c1", field: "conversationRules" })).toEqual({
      agentId: "chief",
      id: "c1",
      field: "conversationRules",
    });
    expect(() => decodeEventCheckDiscoverCheckInput({ agentId: "chief", id: "c1", field: "" })).toThrow();
  });
});

describe("discovery routes", () => {
  it("share the fork host capability instead of adding a capability string", () => {
    expect(EVENT_CHECK_TEMPLATES_CAPABILITY).toBe(FORK_HOST_CAPABILITY);
    for (const path of [EVENT_CHECK_TEMPLATES_ROUTES.discover, EVENT_CHECK_TEMPLATES_ROUTES.discoverCheck])
      expect(EVENT_CHECK_TEMPLATES_CODECS.has(path)).toBe(true);
  });

  it("decode the request and the answer, and pass an error envelope through", () => {
    const draft = EVENT_CHECK_TEMPLATES_CODECS.get(EVENT_CHECK_TEMPLATES_ROUTES.discover);
    const check = EVENT_CHECK_TEMPLATES_CODECS.get(EVENT_CHECK_TEMPLATES_ROUTES.discoverCheck);
    if (!draft || !check) throw new Error("Expected both codecs.");
    const request = {
      slug: "slack-activity",
      field: "conversationRules",
      configuration: {},
      variables: { SLACK_USER_TOKEN: "x" },
    };
    expect(draft.request(request)).toEqual(request);
    expect(() => draft.request({ ...request, variables: { lowercase: "x" } })).toThrow();
    expect(check.request({ agentId: "chief", id: "c1", field: "conversationRules" })).toEqual({
      agentId: "chief",
      id: "c1",
      field: "conversationRules",
    });
    const answer = { options: [{ id: "C1ABC", label: "#general", group: "channel" }] };
    expect(draft.response(200, answer)).toEqual(answer);
    expect(() => draft.response(200, { options: "no" })).toThrow();
    expect(draft.response(400, { error: "The app limited the requests." })).toEqual({
      error: "The app limited the requests.",
    });
  });
});
