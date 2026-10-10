import type { AgentMessage } from "@openbot/ui/data";
import { createRoot, createSignal, createStore, flush } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatSearchMatch } from "../chat-search";
import { createSearchStore } from "./search-store";

const reply = (id: string, body: string): AgentMessage => ({
  id,
  author: "agent",
  body,
  time: "09:00",
  createdAt: "2026-09-20T09:00:00.000Z",
});

function setup(options: { open: boolean; query: string; matches?: ChatSearchMatch[] }) {
  const [open, setOpen] = createSignal(options.open);
  const [query, setQuery] = createSignal(options.query);
  const [matches, setMatches] = createSignal<ChatSearchMatch[]>(options.matches ?? []);
  const [ids, setIds] = createSignal<string[]>([]);
  const [activeIndex, setActiveIndex] = createSignal(-1);
  const [state, setState] = createStore({ messages: [reply("a", "alpha"), reply("b", "beta")] });
  const calls = { matches: 0, ids: 0, scrollElement: 0 };
  const dispose = createRoot((disposeRoot) => {
    createSearchStore({
      props: {
        get messages() {
          return state.messages;
        },
      },
      chatSearchOpen: open,
      chatSearchQuery: query,
      activeChatSearchIndex: activeIndex,
      scrollElement: () => {
        calls.scrollElement += 1;
        return undefined;
      },
      revealMatch: () => {},
      setChatSearchOpen: setOpen,
      setChatSearchQuery: setQuery,
      chatSearchMatches: matches,
      setChatSearchMatches: (next) => {
        calls.matches += 1;
        setMatches(next);
      },
      chatSearchMessageIds: ids,
      setChatSearchMessageIds: (next) => {
        calls.ids += 1;
        setIds(next);
      },
      setChatSearchTotal: () => {},
      setActiveChatSearchIndex: setActiveIndex,
    });
    return disposeRoot;
  });
  flush();
  const stream = (delta: string) => {
    setState((draft) => {
      const message = draft.messages.at(-1);
      if (message) message.body += delta;
    });
    flush();
  };
  return { calls, stream, matches, setOpen, setQuery, dispose };
}

/** One animation frame of the test environment. */
const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

afterEach(() => vi.restoreAllMocks());

describe("chat search store", () => {
  it("does not read the messages or write the search state for a delta while the search is closed", async () => {
    const search = setup({ open: false, query: "" });
    await frame();
    const before = { ...search.calls };
    for (let index = 0; index < 20; index += 1) search.stream(" more");
    await frame();
    expect(search.calls).toEqual(before);
    search.dispose();
  });

  it("clears stale matches once and then leaves the state alone", async () => {
    const stale: ChatSearchMatch[] = [{ range: document.createRange(), message: document.createElement("div") }];
    const search = setup({ open: false, query: "", matches: stale });
    expect(search.matches()).toEqual([]);
    const after = search.calls.matches;
    for (let index = 0; index < 5; index += 1) search.stream(" more");
    expect(search.calls.matches).toBe(after);
    search.dispose();
  });

  it("searches again for a delta while a search with a query is open", async () => {
    const search = setup({ open: true, query: "beta" });
    await frame();
    const before = search.calls.scrollElement;
    expect(before).toBeGreaterThan(0);
    search.stream(" more");
    await frame();
    expect(search.calls.scrollElement).toBeGreaterThan(before);
    search.dispose();
  });

  it("starts to follow the messages when the search opens", async () => {
    const search = setup({ open: false, query: "beta" });
    await frame();
    expect(search.calls.scrollElement).toBe(0);
    search.setOpen(true);
    flush();
    await frame();
    const opened = search.calls.scrollElement;
    expect(opened).toBeGreaterThan(0);
    search.stream(" more");
    await frame();
    expect(search.calls.scrollElement).toBeGreaterThan(opened);
    search.dispose();
  });
});
