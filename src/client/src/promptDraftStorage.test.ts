import { describe, expect, it } from "vitest";
import { clearEditTarget, loadEditTarget, saveEditTarget } from "./promptDraftStorage";
import { MemoryStorage } from "./controllers/sessionController.testSupport";

/** A private-mode style storage: present, but every access throws. */
class BlockedStorage implements Storage {
  readonly length = 0;
  clear(): void { throw new Error("blocked"); }
  getItem(): string | null { throw new Error("blocked"); }
  key(): string | null { throw new Error("blocked"); }
  removeItem(): void { throw new Error("blocked"); }
  setItem(): void { throw new Error("blocked"); }
}

describe("prompt edit target storage", () => {
  it("round-trips the entry and the draft it displaced", () => {
    const storage = new MemoryStorage();

    saveEditTarget("local:session-1", { entryId: "entry-7", previousDraft: "half-written thought" }, storage);

    expect(loadEditTarget("local:session-1", storage)).toEqual({ entryId: "entry-7", previousDraft: "half-written thought" });
  });

  it("keeps an empty displaced draft distinguishable from no rewrite at all", () => {
    const storage = new MemoryStorage();

    saveEditTarget("local:session-1", { entryId: "entry-7", previousDraft: "" }, storage);

    // Cancelling has to be able to restore an empty composer, so "" is a value
    // here, not the absence of one.
    expect(loadEditTarget("local:session-1", storage)).toEqual({ entryId: "entry-7", previousDraft: "" });
  });

  it("scopes rewrites to their own session", () => {
    const storage = new MemoryStorage();

    saveEditTarget("local:session-1", { entryId: "entry-7", previousDraft: "" }, storage);

    expect(loadEditTarget("local:session-2", storage)).toBeUndefined();
  });

  it("forgets a rewrite that was cleared", () => {
    const storage = new MemoryStorage();
    saveEditTarget("local:session-1", { entryId: "entry-7", previousDraft: "" }, storage);

    clearEditTarget("local:session-1", storage);

    expect(loadEditTarget("local:session-1", storage)).toBeUndefined();
  });

  it("treats an unreadable record as no rewrite", () => {
    const storage = new MemoryStorage();

    // A half-written or future-shaped record must not strand the composer in a
    // rewrite it cannot describe; the draft text stands on its own instead.
    for (const raw of ["not json", "null", "[]", "{}", '{"entryId":"","previousDraft":"x"}', '{"entryId":"entry-7"}']) {
      storage.setItem("pi-web:prompt-edit-target:local:session-1", raw);
      expect(loadEditTarget("local:session-1", storage)).toBeUndefined();
    }
  });

  it("survives a storage that refuses to answer", () => {
    const storage = new BlockedStorage();

    expect(() => { saveEditTarget("local:session-1", { entryId: "entry-7", previousDraft: "" }, storage); }).not.toThrow();
    expect(loadEditTarget("local:session-1", storage)).toBeUndefined();
    expect(() => { clearEditTarget("local:session-1", storage); }).not.toThrow();
  });
});
