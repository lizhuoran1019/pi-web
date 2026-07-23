import { describe, expect, it } from "vitest";
import {
  buildMinimapNodes,
  chatMinimapPreview,
  hitNodeIndex,
  isScrollable,
  nearestNodeIndex,
  seekScrollTop,
  tooltipLayout,
  viewportBox,
  type MinimapEntry,
} from "./chatMinimapModel";
import type { ChatLine } from "./components/shared";

const line = (role: ChatLine["role"], ...texts: string[]): ChatLine => ({
  role,
  parts: texts.map((text) => ({ type: "text", text })),
});

describe("chatMinimapPreview", () => {
  it("joins text parts and collapses whitespace", () => {
    expect(chatMinimapPreview(line("user", "hello  world", "again\n\tnow"))).toBe("hello world again now");
  });

  it("ignores non-text parts", () => {
    const message: ChatLine = {
      role: "assistant",
      parts: [
        { type: "thinking", text: "secret plan" },
        { type: "toolCall", toolName: "read", summary: "file" },
        { type: "text", text: "visible answer" },
      ],
    };
    expect(chatMinimapPreview(message)).toBe("visible answer");
  });

  it("returns empty string when there is no readable text", () => {
    expect(chatMinimapPreview(line("assistant", "   \n  "))).toBe("");
  });

  it("truncates to 200 characters with an ellipsis", () => {
    const preview = chatMinimapPreview(line("user", "a".repeat(250)));
    expect(preview).toHaveLength(201);
    expect(preview.endsWith("…")).toBe(true);
    expect(preview.startsWith("a".repeat(200))).toBe(true);
  });
});

describe("buildMinimapNodes", () => {
  const entries: MinimapEntry[] = [
    { index: 0, message: line("user", "hi"), top: 0, height: 100 },
    { index: 1, message: line("assistant", "hello"), top: 100, height: 300 },
    { index: 2, message: line("system", "note"), top: 400, height: 50 },
    { index: 3, message: line("bash", "$ ls"), top: 450, height: 50 },
  ];

  it("keeps only user and assistant entries", () => {
    const nodes = buildMinimapNodes(entries, 1000);
    expect(nodes.map((node) => node.index)).toEqual([0, 1]);
    expect(nodes.map((node) => node.role)).toEqual(["user", "assistant"]);
  });

  it("computes ratios against scroll height", () => {
    const nodes = buildMinimapNodes(entries, 1000);
    expect(nodes[1]).toMatchObject({ topRatio: 0.1, heightRatio: 0.3, preview: "hello" });
  });

  it("returns nothing when scroll height is not positive", () => {
    expect(buildMinimapNodes(entries, 0)).toEqual([]);
  });
});

describe("viewportBox", () => {
  it("maps scroll position and visible fraction", () => {
    expect(viewportBox(250, 1000, 400)).toEqual({ topRatio: 0.25, heightRatio: 0.4 });
  });

  it("fills the strip when there is no scroll height", () => {
    expect(viewportBox(0, 0, 400)).toEqual({ topRatio: 0, heightRatio: 1 });
  });

  it("clamps to the unit range", () => {
    expect(viewportBox(2000, 1000, 400)).toEqual({ topRatio: 1, heightRatio: 0.4 });
  });
});

describe("seekScrollTop", () => {
  const scrollHeight = 1000;
  const clientHeight = 200;

  it("centers the viewport on a track click", () => {
    const grabOffsetRatio = clientHeight / scrollHeight / 2;
    expect(seekScrollTop({ pointerRatio: 0.5, grabOffsetRatio, scrollHeight, clientHeight })).toBe(400);
  });

  it("preserves the grab offset while dragging", () => {
    expect(seekScrollTop({ pointerRatio: 0.6, grabOffsetRatio: 0.1, scrollHeight, clientHeight })).toBe(500);
  });

  it("clamps to the scrollable range", () => {
    expect(seekScrollTop({ pointerRatio: 1, grabOffsetRatio: 0, scrollHeight, clientHeight })).toBe(800);
    expect(seekScrollTop({ pointerRatio: -1, grabOffsetRatio: 0, scrollHeight, clientHeight })).toBe(0);
  });
});

describe("isScrollable", () => {
  it("requires more than the threshold of overflow", () => {
    expect(isScrollable(1020, 1000)).toBe(false);
    expect(isScrollable(1021, 1000)).toBe(true);
  });
});

describe("nearestNodeIndex", () => {
  it("finds the closest node", () => {
    expect(nearestNodeIndex([0.1, 0.5, 0.9], 0.55)).toBe(1);
  });

  it("prefers the earlier node on a tie", () => {
    expect(nearestNodeIndex([0.2, 0.4], 0.3)).toBe(0);
  });

  it("returns -1 for an empty list", () => {
    expect(nearestNodeIndex([], 0.5)).toBe(-1);
  });
});

describe("hitNodeIndex", () => {
  it("hits a node within the pixel tolerance", () => {
    expect(hitNodeIndex([0.5], 0.55, 100)).toBe(0);
  });

  it("misses a node outside the pixel tolerance", () => {
    expect(hitNodeIndex([0.5], 0.57, 100)).toBeUndefined();
  });

  it("returns undefined without nodes or height", () => {
    expect(hitNodeIndex([], 0.5, 100)).toBeUndefined();
    expect(hitNodeIndex([0.5], 0.5, 0)).toBeUndefined();
  });
});

describe("tooltipLayout", () => {
  it("leaves non-overlapping tooltips in place", () => {
    expect(tooltipLayout([0.1, 0.5], 1000, 40, 8)).toEqual([80, 480]);
  });

  it("pushes overlapping tooltips apart by at least the step", () => {
    const tops = tooltipLayout([0.1, 0.12], 1000, 40, 8);
    expect(tops[0]).toBe(80);
    expect((tops[1] ?? 0) - (tops[0] ?? 0)).toBeGreaterThanOrEqual(48);
  });

  it("clamps tooltips within the container", () => {
    expect(tooltipLayout([0.99], 1000, 40, 8)).toEqual([960]);
  });
});
