import type { ChatLine, ChatPart } from "./components/shared";

export type MinimapRole = "user" | "assistant";

export interface MinimapEntry {
  index: number;
  message: ChatLine;
  top: number;
  height: number;
}

export interface MinimapNode {
  index: number;
  role: MinimapRole;
  preview: string;
  topRatio: number;
  heightRatio: number;
}

export interface ViewportBox {
  topRatio: number;
  heightRatio: number;
}

export interface SeekInput {
  pointerRatio: number;
  grabOffsetRatio: number;
  scrollHeight: number;
  clientHeight: number;
}

const PREVIEW_LIMIT = 200;
const SCROLLABLE_THRESHOLD = 20;
const HIT_TOLERANCE = 6;

export function chatMinimapPreview(message: ChatLine): string {
  const text = message.parts
    .filter((part): part is Extract<ChatPart, { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  if (text.length <= PREVIEW_LIMIT) return text;
  return `${text.slice(0, PREVIEW_LIMIT)}…`;
}

export function buildMinimapNodes(entries: readonly MinimapEntry[], scrollHeight: number): MinimapNode[] {
  if (scrollHeight <= 0) return [];
  const nodes: MinimapNode[] = [];
  for (const entry of entries) {
    const role = entry.message.role;
    if (role !== "user" && role !== "assistant") continue;
    nodes.push({
      index: entry.index,
      role,
      preview: chatMinimapPreview(entry.message),
      topRatio: clamp01(entry.top / scrollHeight),
      heightRatio: clamp01(entry.height / scrollHeight),
    });
  }
  return nodes;
}

export function viewportBox(scrollTop: number, scrollHeight: number, clientHeight: number): ViewportBox {
  if (scrollHeight <= 0) return { topRatio: 0, heightRatio: 1 };
  return {
    topRatio: clamp01(scrollTop / scrollHeight),
    heightRatio: clamp01(clientHeight / scrollHeight),
  };
}

export function seekScrollTop({ pointerRatio, grabOffsetRatio, scrollHeight, clientHeight }: SeekInput): number {
  const maxScrollTop = Math.max(0, scrollHeight - clientHeight);
  const target = (pointerRatio - grabOffsetRatio) * scrollHeight;
  return clamp(target, 0, maxScrollTop);
}

export function isScrollable(scrollHeight: number, clientHeight: number, threshold = SCROLLABLE_THRESHOLD): boolean {
  return scrollHeight - clientHeight > threshold;
}

export function nearestNodeIndex(topRatios: readonly number[], pointerRatio: number): number {
  let best = -1;
  let bestDistance = Number.POSITIVE_INFINITY;
  topRatios.forEach((ratio, index) => {
    const distance = Math.abs(ratio - pointerRatio);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = index;
    }
  });
  return best;
}

export function hitNodeIndex(
  topRatios: readonly number[],
  pointerRatio: number,
  containerHeightPx: number,
  tolerancePx = HIT_TOLERANCE,
): number | undefined {
  if (topRatios.length === 0 || containerHeightPx <= 0) return undefined;
  const index = nearestNodeIndex(topRatios, pointerRatio);
  const ratio = topRatios[index];
  if (ratio === undefined) return undefined;
  const distancePx = Math.abs(ratio - pointerRatio) * containerHeightPx;
  return distancePx <= tolerancePx ? index : undefined;
}

export function tooltipLayout(
  topRatios: readonly number[],
  containerHeightPx: number,
  tooltipHeightPx: number,
  gapPx: number,
): number[] {
  const tops = topRatios.map((ratio) => ratio * containerHeightPx - tooltipHeightPx / 2);
  const maxTop = Math.max(0, containerHeightPx - tooltipHeightPx);
  const step = tooltipHeightPx + gapPx;
  for (let i = 1; i < tops.length; i += 1) {
    const prev = tops[i - 1];
    const cur = tops[i];
    if (prev === undefined || cur === undefined) continue;
    if (cur - prev < step) tops[i] = prev + step;
  }
  for (let i = tops.length - 1; i >= 0; i -= 1) {
    const cur = tops[i];
    if (cur === undefined) continue;
    let value = Math.min(cur, maxTop);
    const next = tops[i + 1];
    if (next !== undefined && next - value < step) value = next - step;
    tops[i] = Math.max(0, value);
  }
  return tops;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function clamp01(value: number): number {
  return clamp(value, 0, 1);
}
