// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionTreeSnapshot } from "../api";
import { ChatView } from "./ChatView";
import type { ChatLine } from "./shared";

const editLabel = "Edit from here — rewrite this message and send it as a new branch";
const rewritingLabel = "Rewriting this message";
const shownAsk: ChatLine = { role: "user", parts: [{ type: "text", text: "ask 1" }], entryId: "ask-1" };
const shownReply: ChatLine = { role: "assistant", parts: [{ type: "text", text: "reply 1" }], entryId: "reply-1" };
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
  it("hands over the entry and the text of the activated line", async () => {
    const onBeginMessageEdit = vi.fn<(entryId: string, text: string) => void>();
    const view = await renderView({ onBeginMessageEdit });

    requiredButton(view, editLabel).click();

    // The text travels with the entry id because nothing asks the server for it:
    // arming a rewrite must not move the session.
    expect(onBeginMessageEdit).toHaveBeenCalledExactlyOnceWith("ask-1", "ask 1");
  });

  it("reports the message it is already rewriting instead of offering to act again", async () => {
    const onBeginMessageEdit = vi.fn<(entryId: string, text: string) => void>();
    const view = await renderView({ onBeginMessageEdit, editingEntryId: "ask-1" });

    expect(findButton(view, editLabel)).toBeUndefined();
    const button = requiredButton(view, rewritingLabel);
    expect(button.disabled).toBe(true);
    expect(button.getAttribute("aria-pressed")).toBe("true");
  });

  it("marks the rewritten line so the transcript below it can be shown as superseded", async () => {
    const onBeginMessageEdit = vi.fn<(entryId: string, text: string) => void>();
    const view = await renderView({ onBeginMessageEdit, editingEntryId: "ask-1", messages: [shownAsk, shownReply] });

    // Styling reads "after the rewrite target" off DOM order, so the marker is on
    // the target alone; the reply below carries nothing of its own.
    const marked = [...(view.shadowRoot?.querySelectorAll(".rewrite-target") ?? [])];
    expect(marked).toHaveLength(1);
    expect(marked[0]?.getAttribute("data-index")).toBe("0");
  });

  it("omits the action entirely when no rewrite handler is wired", async () => {
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
  onBeginMessageEdit?: (entryId: string, text: string) => void;
  editingEntryId?: string;
  messages?: ChatLine[];
  onShowBranch?: (targetId: string) => Promise<void>;
  sessionTree?: SessionTreeSnapshot;
} = {}): Promise<ChatView> {
  const view = new ChatView();
  view.sessionId = "session-1";
  view.messages = options.messages ?? [shownAsk];
  view.messageEnd = view.messages.length;
  view.messageTotal = view.messages.length;
  if (options.onBeginMessageEdit !== undefined) view.onBeginMessageEdit = options.onBeginMessageEdit;
  if (options.editingEntryId !== undefined) view.editingEntryId = options.editingEntryId;
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
