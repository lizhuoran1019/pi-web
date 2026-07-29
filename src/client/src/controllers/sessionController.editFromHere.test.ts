import { beforeEach, describe, expect, it, vi } from "vitest";
import { initialAppState } from "../appState";
import { machineSessionKey } from "../machineKeys";
import { loadDraft, saveDraft } from "../promptDraftStorage";
import type { CommandResult, SessionTreeSnapshot } from "../api";
import { SessionController } from "./sessionController";
import { InMemorySessionSelectionMemory } from "./sessionSelection";
import {
  defaultApi,
  EmitSocket,
  FakeSocket,
  MemoryStorage,
  oldSession,
  runPendingAnimationFrames,
  sessionLookupId,
  status,
  workspace,
  type AppState,
  type MessagePage,
} from "./sessionController.testSupport";

/** Slash command the controller reads the current leaf with, mirrored from the controller. */
const TREE_COMMAND = "/tree";
const tree: SessionTreeSnapshot = {
  nodes: [
    { id: "entry-user", parentId: null, kind: "user", summary: "original prompt" },
    { id: "entry-assistant", parentId: "entry-user", kind: "assistant", summary: "answer" },
  ],
  activeLeafId: "entry-assistant",
  activePathIds: ["entry-user", "entry-assistant"],
};

beforeEach(() => {
  Object.defineProperty(globalThis, "localStorage", { value: new MemoryStorage(), configurable: true });
});

describe("SessionController message rewrite", () => {
  function rewriteHarness(overrides: Partial<typeof defaultApi> = {}) {
    // One ordered log across every endpoint: the design under test is that the
    // fork happens between the inline editor's Re-ask and the prompt going out,
    // and only the order proves it.
    const calls: string[] = [];
    const navigations: unknown[] = [];
    const prompts: unknown[] = [];
    let state: AppState = { ...initialAppState(), selectedWorkspace: workspace, selectedSession: oldSession, sessions: [oldSession] };
    const controller = new SessionController(
      () => state,
      (patch) => { state = { ...state, ...patch }; },
      () => undefined,
      new InMemorySessionSelectionMemory(),
      {
        api: {
          ...defaultApi,
          runCommand: (session, text) => {
            calls.push(text);
            return Promise.resolve<CommandResult>({ type: "tree", tree });
          },
          navigateTree: (session, request, machineId) => {
            calls.push("navigate");
            navigations.push({ sessionId: sessionLookupId(session), request, machineId });
            return Promise.resolve({ cancelled: false, editorText: "original prompt" });
          },
          prompt: (session, text, streamingBehavior, machineId) => {
            calls.push("prompt");
            prompts.push({ text, streamingBehavior, machineId });
            return Promise.resolve({ accepted: true as const });
          },
          messages: () => Promise.resolve(page("rewound branch")),
          status: () => Promise.resolve(status(oldSession.id)),
          streamSnapshot: () => Promise.resolve({ seq: 0, partial: null }),
          thinkingLevels: () => Promise.resolve({ levels: [] }),
          ...overrides,
        },
        socket: new FakeSocket(),
      },
    );
    return { controller, calls, navigations, prompts, read: () => state };
  }

  it("rewinds to the message's own entry before sending the rewrite, without summarizing", async () => {
    const { controller, calls, navigations, prompts, read } = rewriteHarness();

    await controller.rewriteMessage("entry-user", "edited prompt");

    // Leaf read, then the fork, then the prompt. The prompt going out last is the
    // whole design: until Re-ask, the rewrite was browser-only. The leaf is read
    // immediately before the mutation so the server's optimistic-concurrency
    // check still guards this entry point. (The further `/tree` in between is the
    // background branch re-read that the authoritative refresh always triggers.)
    expect(calls.slice(0, 2)).toEqual([TREE_COMMAND, "navigate"]);
    expect(calls.at(-1)).toBe("prompt");
    // Pi rewinds a user target to its parent, so the target is the message itself
    // and no branch summary is generated.
    expect(navigations).toEqual([{
      sessionId: oldSession.id,
      request: { targetId: "entry-user", expectedLeafId: "entry-assistant", summary: { mode: "none" } },
      machineId: "local",
    }]);
    expect(prompts).toEqual([{ text: "edited prompt", streamingBehavior: undefined, machineId: "local" }]);
    // Pi hands the original text back as part of rewinding. Accepting that copy
    // would overwrite the edits the user just sent.
    expect(loadDraft(machineSessionKey("local", oldSession.id))).toBe("");
    expect(read().error).toBe("");
  });

  it("throws the server's refusal to the caller and does not fork", async () => {
    const { controller, navigations, read } = rewriteHarness({
      runCommand: () => Promise.resolve<CommandResult>({ type: "unsupported", message: "Cannot open the session tree while the session is active. Stop current activity and try /tree again." }),
    });

    // The rejection belongs to the inline editor that is still holding the text;
    // routing it into `state.error` as well would show the same message twice.
    await expect(controller.rewriteMessage("entry-user", "edited prompt")).rejects.toThrow("Cannot open the session tree");

    expect(navigations).toEqual([]);
    expect(read().error).toBe("");
  });

  it("refuses a target the session no longer holds", async () => {
    const { controller, navigations } = rewriteHarness();

    await expect(controller.rewriteMessage("entry-missing", "edited prompt")).rejects.toThrow("no longer part of this session's history");

    expect(navigations).toEqual([]);
  });

  it("throws a rejected rewind without touching the session error bar", async () => {
    const { controller, prompts, read } = rewriteHarness({
      navigateTree: () => Promise.reject(new Error("The session changed since /tree was opened.")),
    });

    await expect(controller.rewriteMessage("entry-user", "edited prompt")).rejects.toThrow("The session changed since /tree was opened.");

    expect(prompts).toEqual([]);
    expect(read().error).toBe("");
  });

  it("throws a rejected prompt after the fork, so the editor can offer a retry that lands on the new branch", async () => {
    const { controller, navigations, read } = rewriteHarness({
      prompt: () => Promise.reject(new Error("prompt rejected")),
    });

    await expect(controller.rewriteMessage("entry-user", "edited prompt")).rejects.toThrow("prompt rejected");

    expect(navigations).toHaveLength(1);
    expect(read().error).toBe("");
  });

  it("does nothing for an archived session", async () => {
    const runCommand = vi.fn<typeof defaultApi.runCommand>();
    const archived = { ...oldSession, archived: true };
    let state: AppState = { ...initialAppState(), selectedWorkspace: workspace, selectedSession: archived, sessions: [archived] };
    const controller = new SessionController(
      () => state,
      (patch) => { state = { ...state, ...patch }; },
      () => undefined,
      new InMemorySessionSelectionMemory(),
      { api: { ...defaultApi, runCommand }, socket: new FakeSocket() },
    );

    await controller.rewriteMessage("entry-user", "edited prompt");

    expect(runCommand).not.toHaveBeenCalled();
  });
});

describe("SessionController show branch", () => {
  function branchHarness(overrides: Partial<typeof defaultApi> = {}) {
    const replacePromptEditorText = vi.fn();
    let state: AppState = {
      ...initialAppState(),
      selectedWorkspace: workspace,
      selectedSession: oldSession,
      sessions: [oldSession],
      sessionTree: tree,
    };
    const controller = new SessionController(
      () => state,
      (patch) => { state = { ...state, ...patch }; },
      () => undefined,
      new InMemorySessionSelectionMemory(),
      {
        api: {
          ...defaultApi,
          navigateTree: () => Promise.resolve({ cancelled: false }),
          messages: () => Promise.resolve(page("other branch")),
          status: () => Promise.resolve(status(oldSession.id)),
          streamSnapshot: () => Promise.resolve({ seq: 0, partial: null }),
          thinkingLevels: () => Promise.resolve({ levels: [] }),
          runCommand: () => Promise.resolve<CommandResult>({ type: "tree", tree }),
          ...overrides,
        },
        socket: new FakeSocket(),
        replacePromptEditorText,
      },
    );
    return { controller, replacePromptEditorText, read: () => state };
  }

  it("navigates to the neighbouring branch's entry against the known leaf, without summarizing", async () => {
    const navigationCalls: unknown[] = [];
    const { controller, read } = branchHarness({
      navigateTree: (session, request, machineId) => {
        navigationCalls.push({ sessionId: sessionLookupId(session), request, machineId });
        return Promise.resolve({ cancelled: false });
      },
    });

    await controller.showBranch("entry-assistant");

    expect(navigationCalls).toEqual([{
      sessionId: oldSession.id,
      request: { targetId: "entry-assistant", expectedLeafId: "entry-assistant", summary: { mode: "none" } },
      machineId: "local",
    }]);
    // Pi puts the leaf on the target, so the next switch does not carry a leaf the
    // server has already moved past.
    expect(read().sessionTree?.activeLeafId).toBe("entry-assistant");
  });

  it("leaves a typed draft alone", async () => {
    // Pi returns editor text only when the target was a message to re-edit;
    // switching branches has nothing to hand back and must not clear the editor.
    saveDraft(machineSessionKey("local", oldSession.id), "half-written thought");
    const { controller, replacePromptEditorText } = branchHarness();

    await controller.showBranch("entry-assistant");

    expect(loadDraft(machineSessionKey("local", oldSession.id))).toBe("half-written thought");
    expect(replacePromptEditorText).not.toHaveBeenCalled();
  });

  it("surfaces a rejected navigation and keeps the known leaf", async () => {
    const { controller, read } = branchHarness({
      navigateTree: () => Promise.reject(new Error("The session changed since /tree was opened.")),
    });

    await controller.showBranch("entry-assistant");

    expect(read().error).toContain("The session changed since /tree was opened.");
    expect(read().sessionTree?.activeLeafId).toBe("entry-assistant");
  });

  it("does nothing for an archived session", async () => {
    const navigateTree = vi.fn<typeof defaultApi.navigateTree>();
    const archived = { ...oldSession, archived: true };
    let state: AppState = { ...initialAppState(), selectedWorkspace: workspace, selectedSession: archived, sessions: [archived], sessionTree: tree };
    const controller = new SessionController(
      () => state,
      (patch) => { state = { ...state, ...patch }; },
      () => undefined,
      new InMemorySessionSelectionMemory(),
      { api: { ...defaultApi, navigateTree }, socket: new FakeSocket() },
    );

    await controller.showBranch("entry-assistant");

    expect(navigateTree).not.toHaveBeenCalled();
  });
});

describe("SessionController transcript entry identity", () => {
  it("re-reads the branch when a settled turn left a user message without an entry id", async () => {
    const socket = new EmitSocket();
    const messages = vi.fn<typeof defaultApi.messages>(() => Promise.resolve(page("committed")));
    const controller = await controllerWithLiveTranscript(socket, messages);

    // Live events carry no entry ids: pi appends the entry only after announcing
    // the message, so a message sent in this view is unaddressable until re-read.
    socket.emit({ type: "message.append", message: { role: "user", content: "sent in this view" } });
    runPendingAnimationFrames();
    expect(messages).toHaveBeenCalledOnce();

    socket.emit({ type: "agent.end" });

    await vi.waitFor(() => { expect(messages).toHaveBeenCalledTimes(2); });
    controller.dispose();
  });

  it("does not re-read when every user message is already addressable", async () => {
    const socket = new EmitSocket();
    const messages = vi.fn<typeof defaultApi.messages>(() => Promise.resolve({ messages: [{ role: "user", content: "from history", entryId: "entry-user" }], start: 0, total: 1 }));
    const controller = await controllerWithLiveTranscript(socket, messages);

    socket.emit({ type: "agent.end" });
    await Promise.resolve();

    expect(messages).toHaveBeenCalledOnce();
    controller.dispose();
  });
});

async function controllerWithLiveTranscript(socket: EmitSocket, messages: typeof defaultApi.messages): Promise<SessionController> {
  let state: AppState = { ...initialAppState(), selectedWorkspace: workspace, selectedSession: oldSession, sessions: [oldSession] };
  const controller = new SessionController(
    () => state,
    (patch) => { state = { ...state, ...patch }; },
    () => undefined,
    new InMemorySessionSelectionMemory(),
    {
      api: {
        ...defaultApi,
        messages,
        status: () => Promise.resolve(status(oldSession.id)),
        streamSnapshot: () => Promise.resolve({ seq: 0, partial: null }),
        thinkingLevels: () => Promise.resolve({ levels: [] }),
      },
      socket,
    },
  );
  await controller.selectSession(oldSession, { updateUrl: false });
  return controller;
}

function page(text: string): MessagePage {
  return { messages: [{ role: "assistant", content: text }], start: 0, total: 1 };
}
