// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryStorage } from "../controllers/sessionController.testSupport";
import { PromptEditor } from "./PromptEditor";

beforeEach(() => {
  Object.defineProperty(globalThis, "localStorage", { value: new MemoryStorage(), configurable: true });
});

afterEach(() => {
  document.body.replaceChildren();
  Object.defineProperty(globalThis, "localStorage", { value: undefined, configurable: true });
});

describe("PromptEditor rewrite hint", () => {
  it("says nothing while the composer holds an ordinary draft", async () => {
    const editor = await renderEditor({});

    expect(editor.shadowRoot?.querySelector(".edit-hint")).toBeNull();
  });

  it("states what sending will do while a rewrite is armed", async () => {
    const editor = await renderEditor({ editingMessage: true });

    // A rewrite is otherwise invisible: the composer just holds text, and the
    // conversation it is about to fork is still on screen in full.
    const hint = editor.shadowRoot?.querySelector(".edit-hint");
    expect(hint?.textContent).toContain("forks the conversation");
    expect(hint?.getAttribute("role")).toBe("status");
  });

  it("hands the way out to the controller that owns the displaced draft", async () => {
    const onCancelEdit = vi.fn();
    const editor = await renderEditor({ editingMessage: true, onCancelEdit });

    cancelButton(editor).click();

    expect(onCancelEdit).toHaveBeenCalledOnce();
  });
});

async function renderEditor(properties: { editingMessage?: boolean; onCancelEdit?: () => void }): Promise<PromptEditor> {
  const editor = new PromptEditor();
  editor.machineId = "local";
  editor.sessionId = "session-1";
  if (properties.editingMessage !== undefined) editor.editingMessage = properties.editingMessage;
  if (properties.onCancelEdit !== undefined) editor.onCancelEdit = properties.onCancelEdit;
  document.body.append(editor);
  await editor.updateComplete;
  return editor;
}

function cancelButton(editor: PromptEditor): HTMLButtonElement {
  const button = editor.shadowRoot?.querySelector<HTMLButtonElement>(".edit-hint button");
  if (button === null || button === undefined) throw new Error("Expected the rewrite hint to offer a cancel button");
  return button;
}
