import { describe, expect, it } from "vitest";
import { PiSessionService, type PiSessionManager } from "./piSessionService.js";
import { CapturingSessionEventHub, emptyArchiveStore, fakeRuntime, fakeSessionManager, runtimeCreator, sessionGateway, sessionRecord, sessionRef, testModelRuntime } from "./piSessionService.testSupport.js";

const TEST_AGENT_DIR = "/tmp/pi-web-test-agent";
const SESSION_ID = "messages-session";

function messagesHarness(branch: readonly unknown[]) {
  const managerPatch: Partial<PiSessionManager> = { getSessionId: () => SESSION_ID, getBranch: () => [...branch] };
  const manager = fakeSessionManager("/workspace", managerPatch);
  const fake = fakeRuntime(SESSION_ID, { sessionManager: manager });
  const service = new PiSessionService(new CapturingSessionEventHub(), {
    agentDir: TEST_AGENT_DIR,
    modelRuntime: testModelRuntime,
    archiveStore: emptyArchiveStore(),
    createAgentRuntime: runtimeCreator(fake.runtime),
    sessionManager: sessionGateway([sessionRecord(SESSION_ID)]),
    heartbeatIntervalMs: 60_000,
  });
  return { service };
}

describe("PiSessionService history message identity", () => {
  it("tags each message with the session entry it was read from", async () => {
    const { service } = messagesHarness([
      { type: "message", id: "entry-user", parentId: null, message: { role: "user", content: "first ask" } },
      { type: "message", id: "entry-assistant", parentId: "entry-user", message: { role: "assistant", content: "answer" } },
    ]);

    const messages = await service.messages(sessionRef(SESSION_ID));
    await service.dispose();

    // The browser addresses history by entry id (session-tree navigation targets
    // an entry, not a message offset), so the id has to survive this projection.
    expect(messages).toEqual([
      { role: "user", content: "first ask", entryId: "entry-user" },
      { role: "assistant", content: "answer", entryId: "entry-assistant" },
    ]);
  });

  it("passes a message through untouched when its entry carries no usable id", async () => {
    const withoutId = { role: "user", content: "no entry id" };
    const blankId = { role: "assistant", content: "blank entry id" };
    const { service } = messagesHarness([
      { type: "message", message: withoutId },
      { type: "message", id: "", message: blankId },
    ]);

    const messages = await service.messages(sessionRef(SESSION_ID));
    await service.dispose();

    expect(messages).toEqual([withoutId, blankId]);
  });
});
