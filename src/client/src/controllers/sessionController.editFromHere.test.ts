import { beforeEach, describe, expect, it, vi } from "vitest";
import { initialAppState } from "../appState";
import { machineSessionKey } from "../machineKeys";
import { loadDraft } from "../promptDraftStorage";
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
  it("reads the current leaf, then rewinds to the message's own entry without summarizing", async () => {
    const commandCalls: { sessionId: string; text: string }[] = [];
    const navigationCalls: unknown[] = [];
    const replacePromptEditorText = vi.fn();
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
            commandCalls.push({ sessionId: sessionLookupId(session), text });
            return Promise.resolve<CommandResult>({ type: "tree", tree });
          },
          navigateTree: (session, request, machineId) => {
            navigationCalls.push({ sessionId: sessionLookupId(session), request, machineId });
            return Promise.resolve({ cancelled: false, editorText: "original prompt" });
          },
          messages: () => Promise.resolve(page("rewound branch")),
          status: () => Promise.resolve(status(oldSession.id)),
          streamSnapshot: () => Promise.resolve({ seq: 0, partial: null }),
          thinkingLevels: () => Promise.resolve({ levels: [] }),
        },
        socket: new FakeSocket(),
        replacePromptEditorText,
      },
    );

    await controller.editFromHere("entry-user");

    // The leaf is read immediately before the mutation, so the server's
    // optimistic-concurrency check still protects this entry point.
    expect(commandCalls).toEqual([{ sessionId: oldSession.id, text: "/tree" }]);
    // Pi rewinds a user target to its parent and hands back the text, so the
    // target is the message itself and no branch summary is generated.
    expect(navigationCalls).toEqual([{
      sessionId: oldSession.id,
      request: { targetId: "entry-user", expectedLeafId: "entry-assistant", summary: { mode: "none" } },
      machineId: "local",
    }]);
    expect(loadDraft(machineSessionKey("local", oldSession.id))).toBe("original prompt");
    expect(replacePromptEditorText).toHaveBeenCalledWith({ machineId: "local", sessionId: oldSession.id, text: "original prompt" });
    expect(state.error).toBe("");
  });

  it("reports the server's own refusal and does not rewind", async () => {
    const navigateTree = vi.fn<typeof defaultApi.navigateTree>();
    let state: AppState = { ...initialAppState(), selectedWorkspace: workspace, selectedSession: oldSession, sessions: [oldSession] };
    const controller = new SessionController(
      () => state,
      (patch) => { state = { ...state, ...patch }; },
      () => undefined,
      new InMemorySessionSelectionMemory(),
      {
        api: {
          ...defaultApi,
          runCommand: () => Promise.resolve<CommandResult>({ type: "unsupported", message: "Cannot open the session tree while the session is active. Stop current activity and try /tree again." }),
          navigateTree,
        },
        socket: new FakeSocket(),
      },
    );

    await controller.editFromHere("entry-user");

    expect(state.error).toBe("Cannot open the session tree while the session is active. Stop current activity and try /tree again.");
    expect(navigateTree).not.toHaveBeenCalled();
  });

  it("refuses a target the session no longer holds", async () => {
    const navigateTree = vi.fn<typeof defaultApi.navigateTree>();
    let state: AppState = { ...initialAppState(), selectedWorkspace: workspace, selectedSession: oldSession, sessions: [oldSession] };
    const controller = new SessionController(
      () => state,
      (patch) => { state = { ...state, ...patch }; },
      () => undefined,
      new InMemorySessionSelectionMemory(),
      {
        api: {
          ...defaultApi,
          runCommand: () => Promise.resolve<CommandResult>({ type: "tree", tree }),
          navigateTree,
        },
        socket: new FakeSocket(),
      },
    );

    await controller.editFromHere("entry-missing");

    expect(state.error).toBe("That message is no longer part of this session's history.");
    expect(navigateTree).not.toHaveBeenCalled();
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

    await controller.editFromHere("entry-user");

    expect(runCommand).not.toHaveBeenCalled();
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
