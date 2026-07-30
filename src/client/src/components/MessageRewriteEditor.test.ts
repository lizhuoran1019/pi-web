// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import { MessageRewriteEditor } from "./MessageRewriteEditor";
import type { PromptTextarea } from "./PromptTextarea";

afterEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
});

describe("MessageRewriteEditor", () => {
  it("starts the shared editor from the message's own text and submits what the user made of it", async () => {
    const onSubmit = vi.fn<(text: string) => Promise<void>>(() => Promise.resolve());
    const editor = await renderEditor({ text: "original prompt", onSubmit });

    expect(childEditor(editor).view?.state.doc.toString()).toBe("original prompt");
    setText(editor, "edited prompt");
    await editor.updateComplete;
    reAskButton(editor).click();

    expect(onSubmit).toHaveBeenCalledExactlyOnceWith("edited prompt");
  });

  it("hands cancelling back to whoever rendered it", async () => {
    const onCancel = vi.fn();
    const editor = await renderEditor({ text: "original prompt", onCancel });

    cancelButton(editor).click();

    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("cancels when the shared editor reports Escape", async () => {
    const onCancel = vi.fn();
    const editor = await renderEditor({ text: "original prompt", onCancel });

    // The editor core owns the key; the rewrite editor only wires its onEscape.
    childEditor(editor).onEscape?.();

    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("keeps the text and shows the failure when the rewrite is refused", async () => {
    const onSubmit = vi.fn<(text: string) => Promise<void>>(() => Promise.reject(new Error("Stop current session activity first")));
    const editor = await renderEditor({ text: "original prompt", onSubmit });

    reAskButton(editor).click();
    await editor.updateComplete;
    await editor.updateComplete;

    // Failure recovery is structural: the text never left the editor, so a
    // refused rewrite is the same editor with an error line and a live button.
    expect(childEditor(editor).view?.state.doc.toString()).toBe("original prompt");
    expect(editor.shadowRoot?.querySelector(".error")?.textContent).toContain("Stop current session activity first");
    expect(reAskButton(editor).disabled).toBe(false);
  });

  it("locks itself while the rewrite is in flight", async () => {
    let settle = (): void => undefined;
    const onSubmit = vi.fn<(text: string) => Promise<void>>(() => new Promise<void>((resolve) => { settle = resolve; }));
    const editor = await renderEditor({ text: "original prompt", onSubmit });

    reAskButton(editor).click();
    await editor.updateComplete;

    // A second Re-ask mid-flight would fork twice; a cancel would leave the
    // running rewrite headless. Both wait for the first to settle.
    expect(childEditor(editor).disabled).toBe(true);
    expect(cancelButton(editor).disabled).toBe(true);
    expect(reAskButton(editor).textContent).toContain("Re-asking…");
    reAskButton(editor).click();
    expect(onSubmit).toHaveBeenCalledOnce();
    settle();
    await Promise.resolve();
  });

  it("refuses to send an empty rewrite", async () => {
    const editor = await renderEditor({ text: "original prompt" });

    setText(editor, "   ");
    await editor.updateComplete;

    expect(reAskButton(editor).disabled).toBe(true);
  });

  it("mentions the parts a rewrite cannot carry, and only then", async () => {
    const withImages = await renderEditor({ text: "original prompt", hasUncarriedParts: true });
    expect(withImages.shadowRoot?.querySelector(".note")?.textContent).toContain("Images aren't carried");

    const textOnly = await renderEditor({ text: "original prompt" });
    expect(textOnly.shadowRoot?.querySelector(".note")).toBeNull();
  });

  it("forwards its completion context to the shared editor", async () => {
    const editor = await renderEditor({ text: "x", cwd: "/repo", sessionId: "s-1", machineId: "m-1" });

    expect(childEditor(editor).completionContext).toEqual({
      cwd: "/repo",
      sessionId: "s-1",
      machineId: "m-1",
      workspaceScopedFileSuggestions: false,
    });
  });
});

async function renderEditor(properties: {
  text: string;
  hasUncarriedParts?: boolean;
  cwd?: string;
  sessionId?: string;
  machineId?: string;
  onSubmit?: (text: string) => Promise<void>;
  onCancel?: () => void;
}): Promise<MessageRewriteEditor> {
  const editor = new MessageRewriteEditor();
  editor.text = properties.text;
  if (properties.hasUncarriedParts !== undefined) editor.hasUncarriedParts = properties.hasUncarriedParts;
  editor.completionContext = {
    machineId: properties.machineId ?? "local",
    workspaceScopedFileSuggestions: false,
    ...(properties.cwd === undefined ? {} : { cwd: properties.cwd }),
    ...(properties.sessionId === undefined ? {} : { sessionId: properties.sessionId }),
  };
  if (properties.onSubmit !== undefined) editor.onSubmit = properties.onSubmit;
  if (properties.onCancel !== undefined) editor.onCancel = properties.onCancel;
  document.body.append(editor);
  await editor.updateComplete;
  await childEditor(editor).updateComplete;
  return editor;
}

function childEditor(editor: MessageRewriteEditor): PromptTextarea {
  const child = editor.shadowRoot?.querySelector<PromptTextarea>("prompt-textarea");
  if (child === null || child === undefined) throw new Error("Expected the rewrite editor to host a prompt-textarea");
  return child;
}

function setText(editor: MessageRewriteEditor, text: string): void {
  const view = childEditor(editor).view;
  if (view === undefined) throw new Error("Shared editor view not mounted");
  view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text }, selection: { anchor: text.length } });
}

function reAskButton(editor: MessageRewriteEditor): HTMLButtonElement {
  const button = editor.shadowRoot?.querySelector<HTMLButtonElement>("button.primary");
  if (button === null || button === undefined) throw new Error("Expected a Re-ask button");
  return button;
}

function cancelButton(editor: MessageRewriteEditor): HTMLButtonElement {
  const buttons = [...(editor.shadowRoot?.querySelectorAll<HTMLButtonElement>("footer button") ?? [])];
  const button = buttons.find((candidate) => candidate.textContent.trim() === "Cancel");
  if (button === undefined) throw new Error("Expected a Cancel button");
  return button;
}
