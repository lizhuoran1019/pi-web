import { css, html, LitElement } from "lit";
import { customElement, property, query, state } from "lit/decorators.js";
import type { PromptTextarea } from "./PromptTextarea";
import "./PromptTextarea";

/**
 * A user message's body while it is being rewritten: the text, editable in
 * place with the same editor the composer uses (so `@`/`/` completions work
 * here too), plus the actions that resolve the rewrite. It renders where the
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
  /** Completion context, forwarded to the shared editor so `@`/`/` resolve against this session. */
  @property() sessionId?: string;
  @property() cwd?: string;
  @property() machineId = "local";
  @property() projectId?: string;
  @property() workspaceId?: string;
  @property({ type: Boolean }) workspaceScopedFileSuggestions = false;
  /** Fork the conversation at this message and send `text` as the new branch's opening prompt. Rejection is shown inline. */
  @property({ attribute: false }) onSubmit?: (text: string) => Promise<void>;
  /** Abandon the rewrite. The message's read-only body returns unchanged. */
  @property({ attribute: false }) onCancel?: () => void;
  @query("prompt-textarea") private editor?: PromptTextarea;
  @state() private draft: string | undefined;
  @state() private submitting = false;
  @state() private error = "";

  override render() {
    const draft = this.currentDraft();
    return html`
      <prompt-textarea
        placeholder="Rewrite this message…"
        .value=${this.text}
        ?disabled=${this.submitting}
        .sessionId=${this.sessionId}
        .cwd=${this.cwd}
        .machineId=${this.machineId}
        .projectId=${this.projectId}
        .workspaceId=${this.workspaceId}
        .workspaceScopedFileSuggestions=${this.workspaceScopedFileSuggestions}
        .onInput=${(value: string) => { this.draft = value; }}
        .onSubmit=${() => { void this.submit(); }}
        .onEscape=${() => { this.cancel(); }}
      ></prompt-textarea>
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
    // The likely edit is a revision near the end; an unplaced cursor would land
    // at the start, where typing prepends to the question being re-asked.
    this.editor?.focusEditor();
    this.editor?.moveCursorToEnd();
  }

  /** The text as edited so far, starting from the message's own text. */
  private currentDraft(): string {
    return this.draft ?? this.text;
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
    prompt-textarea {
      --prompt-editor-max-height: 40vh;
      --prompt-editor-resize: vertical;
      --prompt-editor-border: var(--pi-accent-border);
      --prompt-editor-content-padding: 8px;
    }
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
