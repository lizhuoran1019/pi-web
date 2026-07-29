const draftStoragePrefix = "pi-web:prompt-draft:";
const editTargetStoragePrefix = "pi-web:prompt-edit-target:";

/**
 * The session entry the composer is rewriting, plus the draft that rewrite
 * displaced. It lives next to the draft text and shares its lifetime on purpose:
 * the text and what the text *means* are two halves of one composer state, and
 * letting one survive a reload without the other would leave the next send
 * silently doing something else than the user asked for.
 */
interface PromptEditTarget {
  readonly entryId: string;
  /** Composer contents from before the rewrite began, restored verbatim on cancel. */
  readonly previousDraft: string;
}

function draftStorageKey(sessionId: string): string {
  return `${draftStoragePrefix}${sessionId}`;
}

function editTargetStorageKey(sessionId: string): string {
  return `${editTargetStoragePrefix}${sessionId}`;
}

function browserStorage(): Storage | undefined {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

export function loadDraft(sessionId: string, storage = browserStorage()): string {
  try {
    return storage?.getItem(draftStorageKey(sessionId)) ?? "";
  } catch {
    return "";
  }
}

export function saveDraft(sessionId: string, draft: string, storage = browserStorage()): void {
  try {
    if (draft) storage?.setItem(draftStorageKey(sessionId), draft);
    else storage?.removeItem(draftStorageKey(sessionId));
  } catch {
    // Ignore localStorage quota/privacy errors.
  }
}

export function clearDraft(sessionId: string, storage = browserStorage()): void {
  try {
    storage?.removeItem(draftStorageKey(sessionId));
  } catch {
    // Ignore localStorage quota/privacy errors.
  }
}

export function loadEditTarget(sessionId: string, storage = browserStorage()): PromptEditTarget | undefined {
  let raw: string | null | undefined;
  try {
    raw = storage?.getItem(editTargetStorageKey(sessionId));
  } catch {
    return undefined;
  }
  if (raw === null || raw === undefined) return undefined;
  // A record written by a future version, or a half-written one, must not strand
  // the composer in a rewrite it cannot describe: treat anything unreadable as
  // "not rewriting" and let the draft stand on its own.
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return undefined;
    if (!("entryId" in parsed) || !("previousDraft" in parsed)) return undefined;
    const { entryId, previousDraft } = parsed;
    if (typeof entryId !== "string" || entryId === "" || typeof previousDraft !== "string") return undefined;
    return { entryId, previousDraft };
  } catch {
    return undefined;
  }
}

export function saveEditTarget(sessionId: string, target: PromptEditTarget, storage = browserStorage()): void {
  try {
    storage?.setItem(editTargetStorageKey(sessionId), JSON.stringify({ entryId: target.entryId, previousDraft: target.previousDraft }));
  } catch {
    // Ignore localStorage quota/privacy errors.
  }
}

export function clearEditTarget(sessionId: string, storage = browserStorage()): void {
  try {
    storage?.removeItem(editTargetStorageKey(sessionId));
  } catch {
    // Ignore localStorage quota/privacy errors.
  }
}

export function moveDraft(fromSessionId: string, toSessionId: string, storage = browserStorage()): void {
  const draft = loadDraft(fromSessionId, storage);
  if (draft === "") return;
  saveDraft(toSessionId, draft, storage);
  clearDraft(fromSessionId, storage);
}
