// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionTreeSnapshot } from "../api";
import { ChatView } from "./ChatView";
import type { ChatLine } from "./shared";

const editLabel = "Edit from here — rewrite this message and send it as a new branch";
const shownAsk: ChatLine = { role: "user", parts: [{ type: "text", text: "ask 1" }], entryId: "ask-1" };
const secondAsk: ChatLine = { role: "user", parts: [{ type: "text", text: "ask 2" }], entryId: "ask-2" };
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
  it("turns the message body into an inline editor holding the message's text", async () => {
    const view = await renderView({ onRewriteMessage: vi.fn(() => Promise.resolve()) });

    requiredButton(view, editLabel).click();
    await view.updateComplete;

    // The edit happens where its consequences are, not in the composer: the
    // message keeps its header while its body becomes the editor.
    const editor = requiredRewriteEditor(view);
    expect(editor.text).toBe("ask 1");
    expect(view.shadowRoot?.querySelectorAll(".rewrite-target")).toHaveLength(1);
  });

  it("submits the rewrite through the handler and closes the editor when it lands", async () => {
    const onRewriteMessage = vi.fn<(entryId: string, text: string) => Promise<void>>(() => Promise.resolve());
    const view = await renderView({ onRewriteMessage });

    requiredButton(view, editLabel).click();
    await view.updateComplete;
    await requiredRewriteEditor(view).onSubmit?.("edited prompt");
    await view.updateComplete;

    expect(onRewriteMessage).toHaveBeenCalledExactlyOnceWith("ask-1", "edited prompt");
    expect(view.shadowRoot?.querySelector("message-rewrite-editor")).toBeNull();
  });

  it("keeps the editor open when the rewrite is refused", async () => {
    const onRewriteMessage = vi.fn<(entryId: string, text: string) => Promise<void>>(() => Promise.reject(new Error("refused")));
    const view = await renderView({ onRewriteMessage });

    requiredButton(view, editLabel).click();
    await view.updateComplete;
    await expect(requiredRewriteEditor(view).onSubmit?.("edited prompt")).rejects.toThrow("refused");
    await view.updateComplete;

    // The refusal belongs to the editor still holding the text; the transcript
    // must not take the editor away from under it.
    expect(view.shadowRoot?.querySelector("message-rewrite-editor")).not.toBeNull();
  });

  it("returns the message body and disables nothing once the rewrite is cancelled", async () => {
    const view = await renderView({ onRewriteMessage: vi.fn(() => Promise.resolve()) });

    requiredButton(view, editLabel).click();
    await view.updateComplete;
    requiredRewriteEditor(view).onCancel?.();
    await view.updateComplete;

    expect(view.shadowRoot?.querySelector("message-rewrite-editor")).toBeNull();
    expect(view.shadowRoot?.querySelector(".rewrite-target")).toBeNull();
    expect(requiredButton(view, editLabel).disabled).toBe(false);
  });

  it("holds other rewrites and branch switches while one rewrite is open", async () => {
    const view = await renderView({
      onRewriteMessage: vi.fn(() => Promise.resolve()),
      onShowBranch: vi.fn(() => Promise.resolve()),
      sessionTree: tree,
      messages: [shownAsk, secondAsk],
    });

    requiredButton(view, editLabel).click();
    await view.updateComplete;

    // One rewrite at a time keeps "what will move to the abandoned branch" a
    // single boundary; a branch switch would unmount the editor with the user's
    // unsent text still in it.
    const editButtons = findButtons(view, editLabel);
    expect(editButtons).toHaveLength(1);
    expect(editButtons[0]?.disabled).toBe(true);
    expect(editButtons[0]?.title).toContain("finish or cancel the current rewrite");
    expect(requiredButton(view, "Rewriting this message").getAttribute("aria-pressed")).toBe("true");
    expect(requiredButton(view, "Show newer branch").disabled).toBe(true);
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
  onRewriteMessage?: (entryId: string, text: string) => Promise<void>;
  messages?: ChatLine[];
  onShowBranch?: (targetId: string) => Promise<void>;
  sessionTree?: SessionTreeSnapshot;
} = {}): Promise<ChatView> {
  const view = new ChatView();
  view.sessionId = "session-1";
  view.messages = options.messages ?? [shownAsk];
  view.messageEnd = view.messages.length;
  view.messageTotal = view.messages.length;
  if (options.onRewriteMessage !== undefined) view.onRewriteMessage = options.onRewriteMessage;
  if (options.onShowBranch !== undefined) view.onShowBranch = options.onShowBranch;
  if (options.sessionTree !== undefined) view.sessionTree = options.sessionTree;
  document.body.append(view);
  await view.updateComplete;
  return view;
}

function findButton(view: ChatView, label: string): HTMLButtonElement | undefined {
  return findButtons(view, label)[0];
}

function findButtons(view: ChatView, label: string): HTMLButtonElement[] {
  return [...(view.shadowRoot?.querySelectorAll<HTMLButtonElement>("button") ?? [])]
    .filter((button) => button.getAttribute("aria-label") === label);
}

function requiredRewriteEditor(view: ChatView) {
  const editor = view.shadowRoot?.querySelector("message-rewrite-editor");
  if (editor === null || editor === undefined) throw new Error("Expected an inline rewrite editor");
  return editor;
}

function requiredButton(view: ChatView, label: string): HTMLButtonElement {
  const button = findButton(view, label);
  if (button === undefined) throw new Error(`Expected button with aria-label ${label}`);
  return button;
}
