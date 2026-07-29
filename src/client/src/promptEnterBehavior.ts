export const MOBILE_PROMPT_ENTER_MEDIA_QUERY = "(pointer: coarse), (max-width: 760px)";
export const PROMPT_ENTER_PREFERENCE_STORAGE_KEY = "pi-web.promptEnterPreference";

export type PromptEnterPreference = "auto" | "send" | "newline";
export type PromptEnterMedia = Pick<MediaQueryList, "matches">;
export type PromptEnterPreferenceStorage = Pick<Storage, "getItem" | "setItem">;

export function createMobilePromptEnterMedia(): PromptEnterMedia | undefined {
  return typeof window !== "undefined" && "matchMedia" in window ? window.matchMedia(MOBILE_PROMPT_ENTER_MEDIA_QUERY) : undefined;
}

export function parsePromptEnterPreference(value: string | null): PromptEnterPreference {
  if (value === "send" || value === "newline") return value;
  return "auto";
}

export function readPromptEnterPreference(storage = browserStorage()): PromptEnterPreference {
  if (storage === undefined) return "auto";
  try {
    return parsePromptEnterPreference(storage.getItem(PROMPT_ENTER_PREFERENCE_STORAGE_KEY));
  } catch {
    return "auto";
  }
}

export function writePromptEnterPreference(preference: PromptEnterPreference, storage = browserStorage()): void {
  if (storage === undefined) return;
  try {
    storage.setItem(PROMPT_ENTER_PREFERENCE_STORAGE_KEY, preference);
  } catch {
    // Ignore localStorage quota/privacy errors; Auto remains the safe fallback.
  }
}

export function shouldSendPromptOnEnter(media = createMobilePromptEnterMedia(), preference = readPromptEnterPreference()): boolean {
  if (preference === "send") return true;
  if (preference === "newline") return false;
  return media?.matches !== true;
}

export function shouldUsePromptEnterShiftShortcut(shiftKey: boolean, explicitShiftKeyActive: boolean, media = createMobilePromptEnterMedia()): boolean {
  // Touch keyboards can report autocapitalization as Shift on Enter after a line break.
  // On mobile-like screens, only trust Shift when the editor saw an explicit Shift keydown.
  if (!shiftKey) return false;
  if (media?.matches === true) return explicitShiftKeyActive;
  return true;
}

export function shouldSendPromptOnEnterShortcut(shiftKey: boolean, media = createMobilePromptEnterMedia(), preference = readPromptEnterPreference()): boolean {
  const plainEnterSends = shouldSendPromptOnEnter(media, preference);
  return shiftKey ? !plainEnterSends : plainEnterSends;
}

/**
 * What one Enter keypress means in a prompt-editing surface, combining the
 * user's Enter preference with the touch-keyboard Shift compensation. Both
 * editing surfaces — the composer and the inline message rewrite — resolve
 * Enter through here so the key cannot mean different things in different
 * boxes. `explicitShiftKeyActive` is whether the surface saw a real Shift
 * keydown, which is what separates a held Shift from autocapitalization.
 */
export function resolvePromptEnterAction(shiftKey: boolean, explicitShiftKeyActive: boolean, media = createMobilePromptEnterMedia(), preference = readPromptEnterPreference()): "send" | "newline" {
  const effectiveShift = shouldUsePromptEnterShiftShortcut(shiftKey, explicitShiftKeyActive, media);
  return shouldSendPromptOnEnterShortcut(effectiveShift, media, preference) ? "send" : "newline";
}

function browserStorage(): PromptEnterPreferenceStorage | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}
