import { beforeEach, describe, expect, it, vi } from "vitest";
import { initialAppState } from "../appState";
import { machineSessionKey } from "../machineKeys";
import { loadDraft, saveDraft, saveEditTarget } from "../promptDraftStorage";
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

describe("SessionController edit from here", () => {
  const key = machineSessionKey("local", oldSession.id);

  function editHarness(overrides: Partial<typeof defaultApi> = {}) {
    const replacePromptEditorText = vi.fn();
    // One ordered log across every endpoint: the whole point of this design is
    // that the fork happens between the user pressing send and the prompt going
    // out, and only the order proves it.
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
            if (text === TREE_COMMAND) return Promise.resolve<CommandResult>({ type: "tree", tree });
            return Promise.resolve<CommandResult>({ type: "done" });
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
        replacePromptEditorText,
      },
    );
    return { controller, replacePromptEditorText, calls, navigations, prompts, read: () => state };
  }

  it("arms a rewrite without asking anything of the session", async () => {
    saveDraft(key, "half-written thought");
    const { controller, calls, replacePromptEditorText, read } = editHarness();

    await controller.beginMessageEdit("entry-user", "original prompt");

    // Nothing reached the server, so there is nothing for a change of mind to undo.
    expect(calls).toEqual([]);
    expect(loadDraft(key)).toBe("original prompt");
    expect(replacePromptEditorText).toHaveBeenCalledWith({ machineId: "local", sessionId: oldSession.id, text: "original prompt" });
    expect(read().promptEditTarget).toEqual({ key, entryId: "entry-user", previousDraft: "half-written thought" });
  });

  it("restores the draft the rewrite displaced when it is abandoned", async () => {
    saveDraft(key, "half-written thought");
    const { controller, calls, replacePromptEditorText, read } = editHarness();

    await controller.beginMessageEdit("entry-user", "original prompt");
    await controller.cancelMessageEdit();

    expect(loadDraft(key)).toBe("half-written thought");
    expect(replacePromptEditorText).toHaveBeenLastCalledWith({ machineId: "local", sessionId: oldSession.id, text: "half-written thought" });
    expect(read().promptEditTarget).toBeUndefined();
    expect(calls).toEqual([]);
  });

  it("restores an empty composer just as faithfully", async () => {
    const { controller, replacePromptEditorText } = editHarness();

    await controller.beginMessageEdit("entry-user", "original prompt");
    await controller.cancelMessageEdit();

    expect(loadDraft(key)).toBe("");
    expect(replacePromptEditorText).toHaveBeenLastCalledWith({ machineId: "local", sessionId: oldSession.id, text: "" });
  });

  it("keeps the originally displaced draft when a second message is picked", async () => {
    saveDraft(key, "half-written thought");
    const { controller, read } = editHarness();

    await controller.beginMessageEdit("entry-user", "original prompt");
    await controller.beginMessageEdit("entry-assistant", "second prompt");

    // Recording the first message's text as "what the user was typing" would make
    // cancelling restore that instead of their own draft.
    expect(read().promptEditTarget).toEqual({ key, entryId: "entry-assistant", previousDraft: "half-written thought" });
    await controller.cancelMessageEdit();
    expect(loadDraft(key)).toBe("half-written thought");
  });

  it("rewinds to the message's own entry before sending the rewrite, without summarizing", async () => {
    const { controller, calls, navigations, prompts, replacePromptEditorText, read } = editHarness();
    await controller.beginMessageEdit("entry-user", "original prompt");
    replacePromptEditorText.mockClear();

    await controller.send("edited prompt");

    // Leaf read, then the fork, then the prompt. The prompt going out last is the
    // whole design: until that moment the rewrite was browser-only. The leaf is
    // read immediately before the mutation so the server's optimistic-concurrency
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
    // Pi hands the original text back as part of rewinding to it. Accepting that
    // here would overwrite the edits the user just sent.
    expect(replacePromptEditorText).not.toHaveBeenCalled();
    expect(read().promptEditTarget).toBeUndefined();
    expect(read().error).toBe("");
  });

  it("keeps the rewrite armed and gives the text back when the server refuses the rewind", async () => {
    const { controller, prompts, replacePromptEditorText, read } = editHarness({
      runCommand: () => Promise.resolve<CommandResult>({ type: "unsupported", message: "Cannot open the session tree while the session is active. Stop current activity and try /tree again." }),
    });
    await controller.beginMessageEdit("entry-user", "original prompt");

    await controller.send("edited prompt");

    expect(read().error).toBe("Cannot open the session tree while the session is active. Stop current activity and try /tree again.");
    expect(prompts).toEqual([]);
    // Nothing moved, so the rewrite is still the right thing to retry — and the
    // composer emptied itself before handing the text over, so it needs it back.
    expect(read().promptEditTarget).toEqual({ key, entryId: "entry-user", previousDraft: "" });
    expect(loadDraft(key)).toBe("edited prompt");
    expect(replacePromptEditorText).toHaveBeenLastCalledWith({ machineId: "local", sessionId: oldSession.id, text: "edited prompt" });
  });

  it("refuses a target the session no longer holds", async () => {
    const { controller, navigations, read } = editHarness();
    await controller.beginMessageEdit("entry-missing", "original prompt");

    await controller.send("edited prompt");

    expect(read().error).toBe("That message is no longer part of this session's history.");
    expect(navigations).toEqual([]);
    expect(loadDraft(key)).toBe("edited prompt");
  });

  it("gives the text back as an ordinary draft when the prompt fails after the fork", async () => {
    const { controller, replacePromptEditorText, read } = editHarness({
      prompt: () => Promise.reject(new Error("prompt rejected")),
    });
    await controller.beginMessageEdit("entry-user", "original prompt");

    await controller.send("edited prompt");

    // The session already forked, so re-sending would correctly land on the new
    // branch: the text comes back, the rewrite does not.
    expect(read().promptEditTarget).toBeUndefined();
    expect(read().error).toContain("prompt rejected");
    expect(loadDraft(key)).toBe("edited prompt");
    expect(replacePromptEditorText).toHaveBeenLastCalledWith({ machineId: "local", sessionId: oldSession.id, text: "edited prompt" });
  });

  it("leaves an armed rewrite alone when the send turns out to be a command", async () => {
    const { controller, calls, read } = editHarness();
    await controller.beginMessageEdit("entry-user", "original prompt");

    await controller.send("/model");

    // A slash command is not a message, so it has no business consuming the
    // rewrite the user lined up.
    expect(calls).toEqual(["/model"]);
    expect(read().promptEditTarget).toEqual({ key, entryId: "entry-user", previousDraft: "" });
  });

  it("reads a persisted rewrite back when the session is selected again", async () => {
    saveEditTarget(key, { entryId: "entry-user", previousDraft: "half-written thought" });
    const { controller, read } = editHarness();

    await controller.selectSession(oldSession, { updateUrl: false });

    // The composer's text survives a reload, so what the text means has to survive
    // with it, or the next send would quietly do something else.
    expect(read().promptEditTarget).toEqual({ key, entryId: "entry-user", previousDraft: "half-written thought" });
  });

  it("does nothing for an archived session", async () => {
    const replacePromptEditorText = vi.fn();
    const archived = { ...oldSession, archived: true };
    let state: AppState = { ...initialAppState(), selectedWorkspace: workspace, selectedSession: archived, sessions: [archived] };
    const controller = new SessionController(
      () => state,
      (patch) => { state = { ...state, ...patch }; },
      () => undefined,
      new InMemorySessionSelectionMemory(),
      { api: { ...defaultApi }, socket: new FakeSocket(), replacePromptEditorText },
    );

    await controller.beginMessageEdit("entry-user", "original prompt");

    expect(state.promptEditTarget).toBeUndefined();
    expect(replacePromptEditorText).not.toHaveBeenCalled();
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
