import { defaultKeymap, history, historyKeymap, indentWithTab, insertNewlineAndIndent } from "@codemirror/commands";
import { markdown, deleteMarkupBackward, insertNewlineContinueMarkup } from "@codemirror/lang-markdown";
import { EditorSelection, EditorState, Compartment } from "@codemirror/state";
import { EditorView, keymap, placeholder as placeholderExtension } from "@codemirror/view";
import { defaultHighlightStyle, indentOnInput, indentUnit, syntaxHighlighting } from "@codemirror/language";
import { css, html, LitElement, type PropertyValues } from "lit";
import { customElement, property, query, state } from "lit/decorators.js";
import { api, type FileSuggestion, type SlashCommand } from "../api";
import { inputModeForDraft } from "../inputModes";
import { detectPromptCompletionTrigger, fileCompletionInsertText, type PromptCompletionTrigger } from "../promptCompletions";
import { createMobilePromptEnterMedia, readPromptEnterPreference, shouldSendPromptOnEnterShortcut, shouldUsePromptEnterShiftShortcut } from "../promptEnterBehavior";
import { autocompleteStyles, type CompletionItem } from "./shared";
import "./AutocompleteMenu";

/**
 * The editing surface shared by the prompt composer and the inline message
 * rewrite: a CodeMirror document with `@`/`/` completions and the app's Enter
 * semantics. It owns everything a plain textarea cannot do well — cursor-anchored
 * completion menu, completion vs. Enter key arbitration, IME, undo, syntax
 * highlighting — so both hosts get the same feel from one implementation.
 *
 * It knows nothing of what a host does with the text. Draft persistence, shell
 * mode, attachments, and what "submit" means all live in the host; this element
 * only reports the text (`onInput`), asks the host to submit (`onSubmit`), and
 * asks it to handle Escape (`onEscape`). Everything else it resolves itself.
 */
@customElement("prompt-textarea")
export class PromptTextarea extends LitElement {
  /** Initial document text. Not a live binding — the editor owns the text after mount; see `syncEditorDoc`. */
  @property() value = "";
  @property() placeholder = "";
  @property({ type: Boolean }) disabled = false;
  /** Completion context. Commands need a session and cwd; file suggestions need a cwd. */
  @property() sessionId?: string;
  @property() cwd?: string;
  @property() machineId = "local";
  @property() projectId?: string;
  @property() workspaceId?: string;
  @property({ type: Boolean }) workspaceScopedFileSuggestions = false;
  /** Reports the current text on every change. The host decides what to persist or derive from it. */
  @property({ attribute: false }) onInput?: (text: string) => void;
  /** Enter resolved to "send". `shiftKey` is the effective (preference-and-platform-adjusted) shift. */
  @property({ attribute: false }) onSubmit?: (shiftKey: boolean) => void;
  /** Escape with no completion menu open. The composer ignores it; the rewrite editor cancels. */
  @property({ attribute: false }) onEscape?: () => void;
  @query(".markdown-editor") private editorHost?: HTMLDivElement;
  @state() private completions: CompletionItem[] = [];
  @state() private selectedIndex = 0;
  // `text` mirrors the document but is intentionally NOT reactive: it changes on
  // every keystroke and CodeMirror, not Lit, owns what is on screen. Re-rendering
  // the surrounding template per keystroke is wasted work and, on iOS, can
  // interrupt an in-progress touch gesture.
  private text = "";
  private requestVersion = 0;
  private editor: EditorView | undefined;
  private readonly editableCompartment = new Compartment();
  private readonly readOnlyCompartment = new Compartment();
  private readonly mobilePromptEnterMedia = createMobilePromptEnterMedia();
  private explicitShiftKeyActive = false;

  override firstUpdated(): void {
    this.text = this.value;
    this.createEditor();
  }

  protected override updated(changed: PropertyValues): void {
    if (changed.has("disabled")) this.updateEditorDisabledState();
    // `value` is an initializer and a host-driven reset (draft moved on session
    // switch, text handed back after a failed send). Push it in only when it
    // actually differs from the live document, so ordinary typing is untouched.
    if (changed.has("value")) this.syncEditorDoc();
  }

  override disconnectedCallback(): void {
    this.editor?.destroy();
    this.editor = undefined;
    super.disconnectedCallback();
  }

  override render() {
    return html`
      <div class=${`markdown-editor${this.disabled ? " markdown-editor-disabled" : ""}`} aria-label=${this.placeholder === "" ? "Message" : this.placeholder} aria-disabled=${this.disabled ? "true" : "false"}></div>
      <autocomplete-menu .items=${this.completions} .selectedIndex=${this.selectedIndex} .onPick=${(item: CompletionItem) => { this.pick(item); }}></autocomplete-menu>
    `;
  }

  /** Move keyboard focus into the editor. */
  focusEditor(): void {
    this.editor?.focus();
  }

  /** Replace the whole document and drop any open completion, e.g. when the host hands new text back. */
  replaceText(text: string): void {
    this.text = text;
    const editor = this.editor;
    if (editor !== undefined) {
      const current = editor.state.doc.toString();
      editor.dispatch({
        ...(current === text ? {} : { changes: { from: 0, to: current.length, insert: text } }),
        selection: EditorSelection.cursor(text.length),
      });
    }
    // Invalidate completion requests started for the previous document.
    this.requestVersion += 1;
    this.completions = [];
    this.selectedIndex = 0;
  }

  /** Put the cursor at the end of the document. Hosts call this after mounting with initial text. */
  moveCursorToEnd(): void {
    const editor = this.editor;
    if (editor === undefined) return;
    editor.dispatch({ selection: EditorSelection.cursor(editor.state.doc.length) });
  }

  /** The underlying CM6 view, or undefined before mount. */
  get view(): EditorView | undefined {
    return this.editor;
  }

  private createEditor() {
    if (!this.editorHost || this.editor !== undefined) return;
    this.editor = new EditorView({
      parent: this.editorHost,
      state: EditorState.create({
        doc: this.text,
        extensions: [
          history(),
          markdown(),
          indentOnInput(),
          indentUnit.of("  "),
          syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
          EditorView.lineWrapping,
          EditorView.contentAttributes.of((view) => inputAssistanceContentAttributes(view.state.sliceDoc(0, view.state.selection.main.head))),
          EditorView.domEventHandlers({
            keyup: (event) => this.handleEditorKeyUp(event),
            blur: () => this.resetEditorModifierState(),
          }),
          placeholderExtension(this.placeholder),
          this.editableCompartment.of(EditorView.editable.of(!this.disabled)),
          this.readOnlyCompartment.of(EditorState.readOnly.of(this.disabled)),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) this.updateText(update.state.doc.toString());
          }),
          keymap.of([
            { any: (view, event) => this.handleEditorKeyDown(event, view) },
            { key: "ArrowDown", run: () => this.moveCompletion(1) },
            { key: "ArrowUp", run: () => this.moveCompletion(-1) },
            { key: "Escape", run: () => this.handleEscape() },
            { key: "Tab", run: (view) => this.handleEditorTab(view) },
            { key: "Shift-Tab", run: (view) => indentWithTab.shift?.(view) ?? false },
            { key: "Backspace", run: (view) => deleteMarkupBackward(view) },
            ...historyKeymap,
            ...defaultKeymap,
          ]),
        ],
      }),
    });
  }

  private syncEditorDoc() {
    const editor = this.editor;
    if (!editor) return;
    const current = editor.state.doc.toString();
    if (current === this.value) return;
    this.text = this.value;
    editor.dispatch({
      changes: { from: 0, to: current.length, insert: this.value },
      selection: EditorSelection.cursor(this.value.length),
    });
    this.requestVersion += 1;
    this.completions = [];
    this.selectedIndex = 0;
  }

  private updateEditorDisabledState() {
    this.editor?.dispatch({
      effects: [
        this.editableCompartment.reconfigure(EditorView.editable.of(!this.disabled)),
        this.readOnlyCompartment.reconfigure(EditorState.readOnly.of(this.disabled)),
      ],
    });
  }

  private updateText(value: string) {
    this.text = value;
    this.onInput?.(value);
    void this.refreshCompletions();
  }

  private async refreshCompletions() {
    const trigger = this.currentTrigger();
    const version = ++this.requestVersion;
    this.selectedIndex = 0;
    if (trigger === undefined) {
      this.completions = [];
      return;
    }
    if (trigger.kind === "command" && this.sessionId !== undefined && this.sessionId !== "" && this.cwd !== undefined && this.cwd !== "") {
      const commands = await api.commands({ id: this.sessionId, cwd: this.cwd }, this.machineId).catch(emptySlashCommands);
      if (version !== this.requestVersion) return;
      this.completions = commands
        .filter((command) => command.name.toLowerCase().includes(trigger.query.toLowerCase()))
        .slice(0, 12)
        .map((command) => ({
          kind: "command",
          replaceFrom: trigger.from,
          replaceTo: trigger.to,
          insertText: `/${command.name}`,
          detail: command.source,
          ...(command.description === undefined ? {} : { description: command.description }),
        }));
    } else if (trigger.kind === "file" && this.cwd !== undefined && this.cwd !== "") {
      const files = await api.files(this.cwd, trigger.query, { scope: trigger.fileScope, machineId: this.machineId, projectId: this.projectId, workspaceId: this.workspaceId, workspaceScoped: this.workspaceScopedFileSuggestions }).catch(emptyFileSuggestions);
      if (version !== this.requestVersion) return;
      this.completions = files
        .slice(0, 12)
        .map((file) => {
          const insertText = fileCompletionInsertText(file.path, trigger.quoted === true, file.path.endsWith("/") ? trigger.allPrefix : undefined);
          return {
            kind: "file",
            replaceFrom: trigger.from,
            replaceTo: trigger.to,
            insertText,
            detail: file.kind,
            ...(file.path.endsWith("/") && insertText.endsWith("\"") ? { cursorOffset: insertText.length - 1 } : {}),
          };
        });
    }
  }

  private currentTrigger(): PromptCompletionTrigger | undefined {
    return detectPromptCompletionTrigger(this.text, this.editor?.state.selection.main.head ?? this.text.length);
  }

  private moveCompletion(delta: number): boolean {
    if (!this.completions.length) return false;
    this.selectedIndex = (this.selectedIndex + delta + this.completions.length) % this.completions.length;
    return true;
  }

  /** Escape closes an open completion menu; with none open, it is the host's to handle. */
  private handleEscape(): boolean {
    if (this.completions.length) {
      this.completions = [];
      return true;
    }
    if (this.onEscape === undefined) return false;
    this.onEscape();
    return true;
  }

  private handleEditorKeyDown(event: KeyboardEvent, view: EditorView): boolean {
    if (event.key === "Shift") {
      this.explicitShiftKeyActive = true;
      return false;
    }
    if (event.key !== "Enter") {
      this.explicitShiftKeyActive = false;
      return false;
    }
    if (event.defaultPrevented || event.isComposing || view.composing) return false;

    // The effective shift folds in the platform rule (a touch keyboard's implicit
    // shift is autocapitalization, not intent). It drives both the completion
    // arbitration and, through the host, the send/newline meaning — one value, as
    // the composer has always done.
    const effectiveShift = shouldUsePromptEnterShiftShortcut(event.shiftKey, this.explicitShiftKeyActive, this.mobilePromptEnterMedia);
    this.explicitShiftKeyActive = false;
    return this.handleEditorEnter(view, effectiveShift);
  }

  private handleEditorKeyUp(event: KeyboardEvent): boolean {
    if (event.key === "Shift") this.explicitShiftKeyActive = false;
    return false;
  }

  private resetEditorModifierState(): boolean {
    this.explicitShiftKeyActive = false;
    return false;
  }

  private handleEditorEnter(view: EditorView, shiftKey: boolean): boolean {
    // Plain Enter with a completion open accepts it, before any send/newline
    // decision. A shift that flips the usual meaning falls through.
    if (!shiftKey && this.completions.length) {
      const completion = this.completions[this.selectedIndex];
      if (completion !== undefined) this.pick(completion);
      return true;
    }
    if (!shouldSendPromptOnEnterShortcut(shiftKey, this.mobilePromptEnterMedia, readPromptEnterPreference())) {
      return insertNewlineContinueMarkup(view) || insertNewlineAndIndent(view);
    }
    this.onSubmit?.(shiftKey);
    return true;
  }

  private handleEditorTab(view: EditorView): boolean {
    if (this.completions.length) {
      const completion = this.completions[this.selectedIndex];
      if (completion !== undefined) this.pick(completion);
      return true;
    }
    const trigger = this.currentTrigger();
    if (trigger?.kind === "file") {
      void this.refreshCompletions();
      return true;
    }
    return indentWithTab.run?.(view) ?? false;
  }

  private pick(item: CompletionItem) {
    const editor = this.editor;
    if (!editor) return;
    const suffix = item.kind === "file" && (item.insertText.endsWith("/") || item.cursorOffset !== undefined) ? "" : " ";
    const cursor = item.replaceFrom + (item.cursorOffset ?? item.insertText.length) + suffix.length;
    const replaceTo = item.insertText.endsWith("\"") && this.text.slice(item.replaceTo).startsWith("\"") ? item.replaceTo + 1 : item.replaceTo;
    editor.dispatch({
      changes: { from: item.replaceFrom, to: replaceTo, insert: `${item.insertText}${suffix}` },
      selection: EditorSelection.cursor(cursor),
      scrollIntoView: true,
    });
    this.completions = [];
  }

  static override styles = [
    autocompleteStyles,
    css`
      :host { position: relative; display: block; color: var(--pi-text); font: 14px system-ui, sans-serif; }
      .markdown-editor .cm-editor { box-sizing: border-box; width: 100%; min-height: var(--prompt-editor-min-height, 54px); max-height: var(--prompt-editor-max-height, 220px); resize: var(--prompt-editor-resize, none); overflow: hidden; border-radius: 8px; border: 1px solid var(--prompt-editor-border, var(--pi-border)); background: var(--pi-bg); color: var(--pi-text); box-shadow: var(--prompt-editor-shadow, none); font: var(--pi-control-font-size, 16px)/1.4 var(--pi-control-font-family, system-ui, sans-serif); }
      .markdown-editor .cm-scroller { max-height: var(--prompt-editor-max-height, 220px); overflow-y: auto; font-family: var(--pi-control-font-family, system-ui, sans-serif); line-height: 1.4; }
      .markdown-editor .cm-content { min-height: 38px; padding: var(--prompt-editor-content-padding, 8px 44px 8px 8px); caret-color: var(--pi-text); text-align: start; unicode-bidi: plaintext; }
      .markdown-editor .cm-line { padding: 0; unicode-bidi: plaintext; }
      .markdown-editor .cm-placeholder { color: var(--pi-dim); }
      .markdown-editor .cm-focused { outline: none; }
      .markdown-editor-disabled .cm-editor { opacity: .5; cursor: not-allowed; }
    `,
  ];
}

function emptySlashCommands(): SlashCommand[] {
  return [];
}

function emptyFileSuggestions(): FileSuggestion[] {
  return [];
}

const proseInputAssistanceAttributes: Record<string, string> = {
  spellcheck: "true",
  autocorrect: "on",
  autocapitalize: "sentences",
  writingsuggestions: "true",
  dir: "auto",
};

const codeLikeInputAssistanceAttributes: Record<string, string> = {
  spellcheck: "false",
  autocorrect: "off",
  autocapitalize: "off",
  writingsuggestions: "false",
  dir: "auto",
};

function inputAssistanceContentAttributes(draftBeforeCursor: string): Record<string, string> {
  // CodeMirror is optimized for code and disables these by default, but the chat prompt is usually prose.
  return inputModeForDraft(draftBeforeCursor).kind === "normal" ? proseInputAssistanceAttributes : codeLikeInputAssistanceAttributes;
}

declare global {
  interface HTMLElementTagNameMap {
    "prompt-textarea": PromptTextarea;
  }
}
