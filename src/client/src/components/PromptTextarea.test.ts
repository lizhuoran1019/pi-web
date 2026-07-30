// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../api";
import { PROMPT_ENTER_PREFERENCE_STORAGE_KEY } from "../promptEnterBehavior";
import { PromptTextarea } from "./PromptTextarea";

beforeEach(() => {
  // Force the desktop "Enter sends" branch deterministically, independent of the
  // happy-dom matchMedia default.
  window.localStorage.setItem(PROMPT_ENTER_PREFERENCE_STORAGE_KEY, "send");
});

afterEach(() => {
  document.body.replaceChildren();
  window.localStorage.clear();
});

describe("PromptTextarea", () => {
  it("reports edits to the host without persisting anything itself", async () => {
    const onInput = vi.fn<(text: string) => void>();
    const editor = await renderEditor({ onInput });

    typeInto(editor, "hello");
    await editor.updateComplete;

    expect(onInput).toHaveBeenLastCalledWith("hello");
    // The surface holds no storage of its own; persistence is the host's job.
    expect(window.localStorage.getItem("pi-web:prompt-draft:local:session-1")).toBeNull();
  });

  it("asks the host to submit on a plain Enter", async () => {
    const onSubmit = vi.fn<(shiftKey: boolean) => void>();
    const editor = await renderEditor({ onSubmit });
    typeInto(editor, "send me");
    await editor.updateComplete;

    const handled = pressEnter(editor, { shiftKey: false });

    expect(handled).toBe(true);
    expect(onSubmit).toHaveBeenCalledExactlyOnceWith(false);
    // The document is unchanged: a send is not a newline.
    expect(editor.view?.state.doc.toString()).toBe("send me");
  });

  it("inserts a newline on Shift+Enter instead of submitting", async () => {
    const onSubmit = vi.fn<(shiftKey: boolean) => void>();
    const editor = await renderEditor({ onSubmit });
    typeInto(editor, "line one");
    await editor.updateComplete;

    pressEnter(editor, { shiftKey: true });

    expect(onSubmit).not.toHaveBeenCalled();
    expect(editor.view?.state.doc.toString()).toBe("line one\n");
  });

  it("hands Escape to the host when no completion menu is open", async () => {
    const onEscape = vi.fn();
    const editor = await renderEditor({ onEscape });

    pressEscape(editor);

    expect(onEscape).toHaveBeenCalledOnce();
  });

  it("offers file completions and replaces the trigger when one is picked", async () => {
    const files = vi.spyOn(api, "files").mockResolvedValue([{ path: "src/main.ts", kind: "tracked" }]);
    const editor = await renderEditor({ cwd: "/repo" });

    typeInto(editor, "see @main");
    await editor.updateComplete;
    await flushMicrotasks();
    await editor.updateComplete;

    const menu = editor.shadowRoot?.querySelector("autocomplete-menu");
    expect(menu?.shadowRoot?.querySelectorAll("button").length ?? 0).toBeGreaterThan(0);
    // Enter accepts the highlighted completion rather than submitting.
    pressEnter(editor, { shiftKey: false });
    await editor.updateComplete;
    expect(editor.view?.state.doc.toString()).toContain("src/main.ts");

    files.mockRestore();
  });

  it("closes the completion menu on Escape before the host ever sees it", async () => {
    const files = vi.spyOn(api, "files").mockResolvedValue([{ path: "src/main.ts", kind: "tracked" }]);
    const onEscape = vi.fn();
    const editor = await renderEditor({ cwd: "/repo", onEscape });
    typeInto(editor, "see @main");
    await editor.updateComplete;
    await flushMicrotasks();
    await editor.updateComplete;

    pressEscape(editor);
    await editor.updateComplete;

    const menu = editor.shadowRoot?.querySelector("autocomplete-menu");
    expect(menu?.shadowRoot?.querySelectorAll("button").length ?? 0).toBe(0);
    expect(onEscape).not.toHaveBeenCalled();

    files.mockRestore();
  });
});

async function renderEditor(properties: {
  onInput?: (text: string) => void;
  onSubmit?: (shiftKey: boolean) => void;
  onEscape?: () => void;
  cwd?: string;
} = {}): Promise<PromptTextarea> {
  const editor = new PromptTextarea();
  editor.completionContext = {
    sessionId: "session-1",
    machineId: "local",
    workspaceScopedFileSuggestions: false,
    ...(properties.cwd === undefined ? {} : { cwd: properties.cwd }),
  };
  if (properties.onInput !== undefined) editor.onInput = properties.onInput;
  if (properties.onSubmit !== undefined) editor.onSubmit = properties.onSubmit;
  if (properties.onEscape !== undefined) editor.onEscape = properties.onEscape;
  document.body.append(editor);
  await editor.updateComplete;
  return editor;
}

function typeInto(editor: PromptTextarea, text: string): void {
  const view = editor.view;
  if (view === undefined) throw new Error("Editor view not mounted");
  view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text }, selection: { anchor: text.length } });
}

function pressEnter(editor: PromptTextarea, options: { shiftKey: boolean }): boolean {
  return dispatchKey(editor, "Enter", options.shiftKey);
}

function pressEscape(editor: PromptTextarea): boolean {
  return dispatchKey(editor, "Escape", false);
}

function dispatchKey(editor: PromptTextarea, key: string, shiftKey: boolean): boolean {
  const content = editor.view?.contentDOM;
  if (content === undefined) throw new Error("Editor content DOM not mounted");
  const event = new KeyboardEvent("keydown", { key, shiftKey, bubbles: true, cancelable: true });
  content.dispatchEvent(event);
  return event.defaultPrevented;
}

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, 0); });
}
