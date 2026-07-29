import { css, html, LitElement } from "lit";
import { customElement, property, query, state } from "lit/decorators.js";
import { resolvePromptEnterAction } from "../promptEnterBehavior";

/**
 * A user message's body while it is being rewritten: the text, editable in
 * place, with the actions that resolve the rewrite. It renders where the
 * message's read-only body normally renders, under the message's own header, so
 * the edit happens exactly where its consequences are — the replies that recede
 * below it are the ones sending will move to the abandoned branch.
 *
 * Everything about the rewrite lives here until `Re-ask` is pressed: the draft,
 * the in-flight state, and any failure. That makes failure recovery structural
 * rather than coded — the text never left this component, so a refused rewrite
 * is just the same editor with an error line and the button ready again.
 */
@customElement("message-rewrite-editor")
export class MessageRewriteEditor extends LitElement {
  /** The message's current text, editable as the rewrite's starting point. */
  @property() text = "";
  /** Whether the message also holds parts a rewrite cannot carry, such as pasted images. */
  @property({ type: Boolean }) hasUncarriedParts = false;
  /** Fork the conversation at this message and send `text` as the new branch's opening prompt. Rejection is shown inline. */
  @property({ attribute: false }) onSubmit?: (text: string) => Promise<void>;
  /** Abandon the rewrite. The message's read-only body returns unchanged. */
  @property({ attribute: false }) onCancel?: () => void;
  @query("textarea") private textarea?: HTMLTextAreaElement;
  @state() private draft: string | undefined;
  @state() private submitting = false;
  @state() private error = "";
  // Touch keyboards can report autocapitalization as Shift on Enter after a line
  // break, which would flip Enter's meaning. Track real Shift keydowns the same
  // way the prompt composer does (see PromptEditor.handleEditorKeyDown), so only
  // an explicit Shift is trusted on mobile-like screens.
  private explicitShiftKeyActive = false;

  override render() {
    const draft = this.currentDraft();
    return html`
      <textarea
        aria-label="Rewrite this message"
        .value=${draft}
        ?disabled=${this.submitting}
        @input=${(event: Event) => { this.handleInput(event); }}
        @keydown=${(event: KeyboardEvent) => { this.handleKeyDown(event); }}
        @keyup=${(event: KeyboardEvent) => { if (event.key === "Shift") this.explicitShiftKeyActive = false; }}
        @blur=${() => { this.explicitShiftKeyActive = false; }}
      ></textarea>
      ${this.hasUncarriedParts ? html`<p class="note">Images aren't carried to the new branch.</p>` : null}
      ${this.error === "" ? null : html`<p class="error" role="alert">${this.error}</p>`}
      <footer>
        <button type="button" ?disabled=${this.submitting} title="Cancel the rewrite (Esc)" @click=${() => { this.cancel(); }}>Cancel</button>
        <button type="button" class="primary" ?disabled=${this.submitting || draft.trim() === ""} title="Fork the conversation here and send this text" @click=${() => { void this.submit(); }}>
          ${this.submitting ? "Re-asking…" : "Re-ask"}
        </button>
      </footer>
    `;
  }

  override firstUpdated(): void {
    const textarea = this.textarea;
    if (textarea === undefined) return;
    textarea.focus();
    // The likely edit is a revision near the end, and an unplaced cursor would
    // land at the start, where typing prepends to the question being re-asked.
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
  }

  private handleInput(event: Event): void {
    const textarea = event.currentTarget;
    if (textarea instanceof HTMLTextAreaElement) this.draft = textarea.value;
  }

  /** The text as edited so far, starting from the message's own text. */
  private currentDraft(): string {
    return this.draft ?? this.text;
  }

  private handleKeyDown(event: KeyboardEvent): void {
    if (event.key === "Shift") {
      this.explicitShiftKeyActive = true;
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      this.cancel();
      return;
    }
    if (event.key !== "Enter") {
      this.explicitShiftKeyActive = false;
      return;
    }
    if (event.isComposing) return;
    const action = resolvePromptEnterAction(event.shiftKey, this.explicitShiftKeyActive);
    this.explicitShiftKeyActive = false;
    // A newline is the textarea's own default; only sending needs intervention.
    if (action !== "send") return;
    event.preventDefault();
    void this.submit();
  }

  private cancel(): void {
    if (this.submitting) return;
    this.onCancel?.();
  }

  private async submit(): Promise<void> {
    const text = this.currentDraft().trim();
    if (this.submitting || text === "" || this.onSubmit === undefined) return;
    this.submitting = true;
    this.error = "";
    try {
      // Success unmounts this editor with the transcript it forked; failure keeps
      // it here, text and all, which is the whole recovery story.
      await this.onSubmit(text);
    } catch (error) {
      this.error = String(error);
    } finally {
      this.submitting = false;
    }
  }

  static override styles = css`
    :host { display: block; color: var(--pi-text); font: 14px system-ui, sans-serif; }
    textarea { box-sizing: border-box; width: 100%; min-height: 72px; max-height: 40vh; resize: vertical; padding: 8px; border: 1px solid var(--pi-accent-border); border-radius: 8px; background: var(--pi-bg); color: var(--pi-text); font: var(--pi-control-font-size, 16px)/1.4 var(--pi-control-font-family, system-ui, sans-serif); }
    textarea:focus { outline: none; border-color: var(--pi-accent); }
    textarea:disabled { opacity: .5; }
    .note { margin: 6px 0 0; color: var(--pi-muted); font-size: 12px; }
    .error { margin: 6px 0 0; color: var(--pi-danger); font-size: 12px; }
    footer { display: flex; justify-content: flex-end; gap: 8px; margin-top: 8px; }
    button { border: 1px solid var(--pi-border); border-radius: 8px; background: var(--pi-surface); color: var(--pi-text); padding: 6px 12px; cursor: pointer; }
    button.primary:not(:disabled) { border-color: var(--pi-accent-border); color: var(--pi-accent); }
    button:disabled { opacity: .5; cursor: not-allowed; }
  `;
}

declare global {
  interface HTMLElementTagNameMap {
    "message-rewrite-editor": MessageRewriteEditor;
  }
}
