import { LitElement, css, html, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import {
  hitNodeIndex,
  nearestNodeIndex,
  seekScrollTop,
  tooltipLayout,
  viewportBox,
  type MinimapNode,
} from "../chatMinimapModel";

const DRAG_THRESHOLD_PX = 3;
const TOOLTIP_HEIGHT_PX = 34;
const TOOLTIP_GAP_PX = 4;

@customElement("chat-minimap")
export class ChatMinimap extends LitElement {
  @property({ attribute: false }) nodes: readonly MinimapNode[] = [];
  @property({ type: Number }) contentScrollTop = 0;
  @property({ type: Number }) contentScrollHeight = 0;
  @property({ type: Number }) viewportHeight = 0;
  @property({ type: Boolean }) hasMore = false;
  @property({ attribute: false }) onSeek?: (scrollTop: number) => void;

  @state() private hovering = false;
  @state() private dragging = false;
  @state() private pointerRatio = 0;
  @state() private hostHeight = 0;

  private pressed = false;
  private pressClientY = 0;
  private grabOffsetRatio = 0;
  private pressPointerRatio = 0;
  private pressHitIndex: number | undefined;
  private dragScrollTop: number | undefined;
  private resizeObserver: ResizeObserver | undefined;

  override connectedCallback(): void {
    super.connectedCallback();
    this.setAttribute("aria-hidden", "true");
    const observer = new ResizeObserver(() => {
      this.hostHeight = this.getBoundingClientRect().height;
    });
    observer.observe(this);
    this.resizeObserver = observer;
  }

  override disconnectedCallback(): void {
    this.resizeObserver?.disconnect();
    this.resizeObserver = undefined;
    this.detachDragListeners();
    super.disconnectedCallback();
  }

  override render() {
    const box = this.currentBox();
    const topRatios = this.nodes.map((node) => node.topRatio);
    const nearest = this.hovering ? nearestNodeIndex(topRatios, this.pointerRatio) : -1;
    const overNode = this.hovering && !this.dragging && hitNodeIndex(topRatios, this.pointerRatio, this.hostHeight) !== undefined;
    const tooltipTops = this.hovering && !this.dragging && this.hostHeight > 0
      ? tooltipLayout(topRatios, this.hostHeight, TOOLTIP_HEIGHT_PX, TOOLTIP_GAP_PX)
      : undefined;
    return html`
      <div
        class="strip${this.dragging ? " dragging" : ""}${overNode ? " over-node" : ""}"
        @pointerdown=${(event: PointerEvent) => { this.handlePointerDown(event); }}
        @pointerenter=${(event: PointerEvent) => { this.handleHover(event); }}
        @pointermove=${(event: PointerEvent) => { this.handleHover(event); }}
        @pointerleave=${() => { this.hovering = false; }}
      >
        <div class="center-line"></div>
        ${this.hasMore ? html`<div class="more">${chevronUp()}</div>` : nothing}
        <div class="viewport" style=${`top:${pct(box.topRatio)};height:${pct(box.heightRatio)}`}></div>
        ${this.nodes.map((node, index) => html`
          <div class="node ${node.role}${index === nearest ? " near" : ""}" style=${`top:${pct(node.topRatio)}`}></div>
        `)}
        ${tooltipTops === undefined ? nothing : this.nodes.map((node, index) => {
          if (node.preview === "") return nothing;
          const top = tooltipTops[index] ?? 0;
          return html`<div class="tooltip ${node.role}${index === nearest ? " near" : ""}" style=${`top:${top.toFixed(1)}px`}>${node.preview}</div>`;
        })}
      </div>
    `;
  }

  private currentBox() {
    const scrollTop = this.dragging && this.dragScrollTop !== undefined ? this.dragScrollTop : this.contentScrollTop;
    return viewportBox(scrollTop, this.contentScrollHeight, this.viewportHeight);
  }

  private pointerRatioFromEvent(event: PointerEvent): number {
    const rect = this.getBoundingClientRect();
    if (rect.height <= 0) return 0;
    return Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height));
  }

  private handleHover(event: PointerEvent): void {
    if (this.pressed) return;
    this.hovering = true;
    this.pointerRatio = this.pointerRatioFromEvent(event);
  }

  private handlePointerDown(event: PointerEvent): void {
    if (event.button !== 0) return;
    event.preventDefault();
    const ratio = this.pointerRatioFromEvent(event);
    const box = viewportBox(this.contentScrollTop, this.contentScrollHeight, this.viewportHeight);
    const inside = ratio >= box.topRatio && ratio <= box.topRatio + box.heightRatio;
    this.grabOffsetRatio = inside ? ratio - box.topRatio : box.heightRatio / 2;
    this.pressPointerRatio = ratio;
    this.pressClientY = event.clientY;
    this.pressHitIndex = hitNodeIndex(this.nodes.map((node) => node.topRatio), ratio, this.getBoundingClientRect().height);
    this.pressed = true;
    this.dragging = false;
    this.dragScrollTop = undefined;
    window.addEventListener("pointermove", this.onWindowPointerMove);
    window.addEventListener("pointerup", this.onWindowPointerUp);
  }

  private readonly onWindowPointerMove = (event: PointerEvent): void => {
    if (!this.pressed) return;
    if (!this.dragging && Math.abs(event.clientY - this.pressClientY) <= DRAG_THRESHOLD_PX) return;
    this.dragging = true;
    const ratio = this.pointerRatioFromEvent(event);
    this.pointerRatio = ratio;
    const target = seekScrollTop({
      pointerRatio: ratio,
      grabOffsetRatio: this.grabOffsetRatio,
      scrollHeight: this.contentScrollHeight,
      clientHeight: this.viewportHeight,
    });
    this.dragScrollTop = target;
    this.onSeek?.(target);
  };

  private readonly onWindowPointerUp = (): void => {
    if (!this.pressed) return;
    const wasDragging = this.dragging;
    this.detachDragListeners();
    this.pressed = false;
    this.dragging = false;
    this.dragScrollTop = undefined;
    if (wasDragging) return;
    this.seekOnClick();
  };

  private seekOnClick(): void {
    const hitIndex = this.pressHitIndex;
    if (hitIndex !== undefined) {
      const node = this.nodes[hitIndex];
      if (node === undefined) return;
      this.onSeek?.(seekScrollTop({
        pointerRatio: node.topRatio,
        grabOffsetRatio: 0,
        scrollHeight: this.contentScrollHeight,
        clientHeight: this.viewportHeight,
      }));
      return;
    }
    this.onSeek?.(seekScrollTop({
      pointerRatio: this.pressPointerRatio,
      grabOffsetRatio: this.grabOffsetRatio,
      scrollHeight: this.contentScrollHeight,
      clientHeight: this.viewportHeight,
    }));
  }

  private detachDragListeners(): void {
    window.removeEventListener("pointermove", this.onWindowPointerMove);
    window.removeEventListener("pointerup", this.onWindowPointerUp);
  }

  static override styles = css`
    :host { display: block; height: 100%; position: relative; z-index: 5; }
    .strip { position: absolute; inset: 0; cursor: grab; touch-action: none; user-select: none; }
    .strip.dragging { cursor: grabbing; }
    .strip.over-node { cursor: pointer; }
    .center-line { position: absolute; top: 0; bottom: 0; left: 50%; width: 1px; transform: translateX(-50%); background: color-mix(in srgb, var(--pi-border-muted) 60%, transparent); pointer-events: none; }
    .more { position: absolute; top: 0; left: 0; right: 0; height: 12px; display: grid; place-items: center; border-bottom: 1px solid var(--pi-border-muted); color: var(--pi-muted); pointer-events: none; }
    .more svg { width: 10px; height: 10px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
    .viewport { position: absolute; left: 3px; right: 3px; min-height: 8px; border: 1px solid color-mix(in srgb, var(--pi-muted) 28%, transparent); border-radius: 3px; background: color-mix(in srgb, var(--pi-muted) 12%, transparent); pointer-events: none; }
    .node { position: absolute; left: 50%; transform: translate(-50%, -50%); pointer-events: none; transition: transform .1s ease; }
    .node.user { width: 8px; height: 8px; border-radius: 2px; border: 1px solid var(--pi-accent-border); background: color-mix(in srgb, var(--pi-accent) 18%, var(--pi-surface)); }
    .node.assistant { width: 6px; height: 6px; border-radius: 50%; border: 1px solid var(--pi-border); background: var(--pi-surface); }
    .node.near { transform: translate(-50%, -50%) scale(1.6); }
    .node.user.near { border-color: var(--pi-accent); }
    .node.assistant.near { border-color: var(--pi-text); }
    .tooltip { position: absolute; right: calc(100% + 6px); width: 200px; height: 34px; box-sizing: border-box; padding: 4px 8px; border: 1px solid var(--pi-border); border-left-width: 3px; border-radius: 6px; background: var(--pi-bg); color: var(--pi-muted); font-size: 11px; line-height: 1.3; overflow: hidden; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; opacity: .45; pointer-events: none; box-shadow: 0 4px 14px var(--pi-shadow-soft); }
    .tooltip.user { border-left-color: var(--pi-accent-border); }
    .tooltip.assistant { border-left-color: var(--pi-border); }
    .tooltip.near { opacity: 1; color: var(--pi-text); border-color: var(--pi-accent); }
  `;
}

function pct(ratio: number): string {
  return `${(ratio * 100).toFixed(3)}%`;
}

function chevronUp() {
  return html`<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="m6 15 6-6 6 6"></path></svg>`;
}
