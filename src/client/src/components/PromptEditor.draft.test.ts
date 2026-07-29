// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { machineSessionKey } from "../machineKeys";
import { loadDraft, saveDraft } from "../promptDraftStorage";
import { PromptEditor } from "./PromptEditor";
import type { PromptTextarea } from "./PromptTextarea";

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();

  get length(): number { return this.values.size; }
  clear(): void { this.values.clear(); }
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  key(index: number): string | null { return Array.from(this.values.keys())[index] ?? null; }
  removeItem(key: string): void { this.values.delete(key); }
  setItem(key: string, value: string): void { this.values.set(key, value); }
}

beforeEach(() => {
  Object.defineProperty(globalThis, "localStorage", { value: new MemoryStorage(), configurable: true });
});

afterEach(() => {
  document.body.replaceChildren();
  Object.defineProperty(globalThis, "localStorage", { value: undefined, configurable: true });
});

describe("PromptEditor draft replacement", () => {
  it("persists the replacement, updates shell mode, and hands the text to the shared editor", async () => {
    const editor = await renderEditor("remote-a", "session-1");

    editor.replaceText("!pwd");
    await editor.updateComplete;

    // The composer still owns draft persistence and the shell-mode derivation;
    // the text itself is pushed into the shared editor.
    expect(loadDraft(machineSessionKey("remote-a", "session-1"))).toBe("!pwd");
    expect(childEditor(editor).view?.state.doc.toString()).toBe("!pwd");
    expect(editor.shadowRoot?.querySelector(".mode-hint")?.textContent).toContain("Shell command");
  });

  it("clears the persisted draft and the shared editor document", async () => {
    const editor = await renderEditor("local", "session-2");
    const key = machineSessionKey("local", "session-2");
    saveDraft(key, "stale text");
    editor.replaceText("stale text");
    await editor.updateComplete;

    editor.replaceText("");
    await editor.updateComplete;

    expect(loadDraft(key)).toBe("");
    expect(childEditor(editor).view?.state.doc.toString()).toBe("");
    expect(editor.shadowRoot?.querySelector(".mode-hint")).toBeNull();
  });
});

async function renderEditor(machineId: string, sessionId: string): Promise<PromptEditor> {
  const editor = new PromptEditor();
  editor.machineId = machineId;
  editor.sessionId = sessionId;
  document.body.append(editor);
  await editor.updateComplete;
  const child = editor.shadowRoot?.querySelector<PromptTextarea>("prompt-textarea");
  await child?.updateComplete;
  return editor;
}

function childEditor(editor: PromptEditor): PromptTextarea {
  const child = editor.shadowRoot?.querySelector<PromptTextarea>("prompt-textarea");
  if (child === null || child === undefined) throw new Error("Expected the composer to host a prompt-textarea");
  return child;
}
