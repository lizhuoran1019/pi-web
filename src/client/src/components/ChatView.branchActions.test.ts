// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionTreeSnapshot } from "../api";
import { ChatView } from "./ChatView";
import type { ChatLine } from "./shared";

const editLabel = "Edit from here — rewind this session to before this message";
const shownAsk: ChatLine = { role: "user", parts: [{ type: "text", text: "ask 1" }], entryId: "ask-1" };
const tree: SessionTreeSnapshot = {
  nodes: [
    { id: "root", parentId: null, kind: "assistant", summary: "root" },
    { id: "ask-1", parentId: "root", kind: "user", summary: "ask 1" },
    { id: "reply-1", parentId: "ask-1", kind: "assistant", summary: "reply 1" },
    { id: "ask-2", parentId: "root", kind: "user", summary: "ask 2" },
    { id: "reply-2", parentId: "ask-2", kind: "assistant", summary: "reply 2" },
  ],
  activeLeafId: "reply-1",
  activePathIds: ["root", "ask-1", "reply-1"],
};

afterEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
});

describe("ChatView edit-from-here wiring", () => {
  it("rewinds to the entry the activated line came from", async () => {
    const onEditFromHere = vi.fn<(entryId: string) => Promise<void>>(() => Promise.resolve());
    const view = await renderView({ onEditFromHere });

    requiredButton(view, editLabel).click();

    expect(onEditFromHere).toHaveBeenCalledExactlyOnceWith("ask-1");
  });

  it("runs one rewind at a time", async () => {
    let settle = (): void => undefined;
    const onEditFromHere = vi.fn<(entryId: string) => Promise<void>>(() => new Promise<void>((resolve) => { settle = resolve; }));
    const view = await renderView({ onEditFromHere });
    const button = requiredButton(view, editLabel);

    button.click();
    button.click();

    expect(onEditFromHere).toHaveBeenCalledOnce();
    settle();
    await Promise.resolve();
  });

  it("omits the action entirely when no rewind handler is wired", async () => {
    const view = await renderView();

    expect(findButton(view, editLabel)).toBeUndefined();
  });
});

describe("ChatView branch switcher wiring", () => {
  it("shows the neighbouring branch by its own navigable entry", async () => {
    const onShowBranch = vi.fn<(targetId: string) => Promise<void>>(() => Promise.resolve());
    const view = await renderView({ onShowBranch, sessionTree: tree });

    requiredButton(view, "Show newer branch").click();

    expect(onShowBranch).toHaveBeenCalledExactlyOnceWith("reply-2");
  });

  it("runs one navigation at a time", async () => {
    let settle = (): void => undefined;
    const onShowBranch = vi.fn<(targetId: string) => Promise<void>>(() => new Promise<void>((resolve) => { settle = resolve; }));
    const view = await renderView({ onShowBranch, sessionTree: tree });
    const button = requiredButton(view, "Show newer branch");

    button.click();
    button.click();

    expect(onShowBranch).toHaveBeenCalledOnce();
    settle();
    await Promise.resolve();
  });

  it("omits the switcher when no navigation handler is wired", async () => {
    const view = await renderView({ sessionTree: tree });

    expect(view.shadowRoot?.querySelector(".branch-switcher")).toBeNull();
  });
});

async function renderView(options: {
  onEditFromHere?: (entryId: string) => Promise<void>;
  onShowBranch?: (targetId: string) => Promise<void>;
  sessionTree?: SessionTreeSnapshot;
} = {}): Promise<ChatView> {
  const view = new ChatView();
  view.sessionId = "session-1";
  view.messages = [shownAsk];
  view.messageEnd = 1;
  view.messageTotal = 1;
  if (options.onEditFromHere !== undefined) view.onEditFromHere = options.onEditFromHere;
  if (options.onShowBranch !== undefined) view.onShowBranch = options.onShowBranch;
  if (options.sessionTree !== undefined) view.sessionTree = options.sessionTree;
  document.body.append(view);
  await view.updateComplete;
  return view;
}

function findButton(view: ChatView, label: string): HTMLButtonElement | undefined {
  return [...(view.shadowRoot?.querySelectorAll<HTMLButtonElement>("button") ?? [])]
    .find((button) => button.getAttribute("aria-label") === label);
}

function requiredButton(view: ChatView, label: string): HTMLButtonElement {
  const button = findButton(view, label);
  if (button === undefined) throw new Error(`Expected button with aria-label ${label}`);
  return button;
}
