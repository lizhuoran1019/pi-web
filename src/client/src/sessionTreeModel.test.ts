import { describe, expect, it } from "vitest";
import { SESSION_TREE_CUSTOM_INSTRUCTIONS_MAX_LENGTH, type SessionTreeNode, type SessionTreeSnapshot } from "../../shared/apiTypes";
import { buildSessionTreeModel, initialSessionTreeSelection, sessionTreeBranchPositions, toggleSessionTreeFold, transitionSessionTreeKey, validateSessionTreeSummaryChoice, visibleSessionTreeRows } from "./sessionTreeModel";

describe("session tree hierarchy model", () => {
  it("builds a complete forest while normalizing orphans, cycles, self-links, and duplicate IDs", () => {
    const model = buildSessionTreeModel({
      nodes: [
        node("root", null),
        node("child", "root"),
        node("orphan", "missing"),
        node("cycle-a", "cycle-b"),
        node("cycle-b", "cycle-a"),
        node("cycle-child", "cycle-a"),
        node("self", "self"),
        { ...node("root", null), summary: "duplicate is ignored" },
      ],
      activeLeafId: "cycle-child",
      activePathIds: ["cycle-b", "cycle-a", "cycle-child", "missing"],
    });

    expect(model.orderedIds).toEqual(["root", "child", "orphan", "cycle-a", "cycle-b", "cycle-child", "self"]);
    expect(model.rootIds).toEqual(["root", "orphan", "cycle-b", "self"]);
    expect(model.parentById.get("cycle-b")).toBeNull();
    expect(model.parentById.get("cycle-a")).toBe("cycle-b");
    expect(model.childrenById.get("cycle-a")).toEqual(["cycle-child"]);

    const rows = visibleSessionTreeRows(model, new Set());
    expect(rows.map((row) => [row.node.id, row.depth])).toEqual([
      ["root", 0],
      ["child", 1],
      ["orphan", 0],
      ["cycle-b", 0],
      ["cycle-a", 1],
      ["cycle-child", 2],
      ["self", 0],
    ]);
    expect(rows.filter((row) => row.activePath).map((row) => row.node.id)).toEqual(["cycle-b", "cycle-a", "cycle-child"]);
    expect(rows.filter((row) => row.activeLeaf).map((row) => row.node.id)).toEqual(["cycle-child"]);
    expect(initialSessionTreeSelection(model)).toBe("cycle-child");
  });

  it("starts from the final retained entry when the active leaf is absent and hides only folded descendants", () => {
    const model = buildSessionTreeModel(snapshot());

    expect(initialSessionTreeSelection(model)).toBe("branch-2");
    expect(visibleSessionTreeRows(model, new Set(["branch-1"])).map((row) => row.node.id)).toEqual(["root", "branch-1", "branch-2"]);
    expect(visibleSessionTreeRows(model, new Set(["root"])).map((row) => row.node.id)).toEqual(["root"]);
  });

  it("keeps linear history in one visual lane and indents only after forks", () => {
    const model = buildSessionTreeModel({
      nodes: [
        node("root", null),
        node("before-fork", "root"),
        node("fork", "before-fork"),
        node("main", "fork"),
        node("main-next", "main"),
        node("side", "fork"),
        node("nested-fork", "side"),
        node("nested-a", "nested-fork"),
        node("nested-b", "nested-fork"),
      ],
      activeLeafId: "main-next",
      activePathIds: [],
    });

    expect(visibleSessionTreeRows(model, new Set()).map((row) => [row.node.id, row.branchDepth])).toEqual([
      ["root", 0],
      ["before-fork", 0],
      ["fork", 0],
      ["main", 1],
      ["main-next", 1],
      ["side", 1],
      ["nested-fork", 1],
      ["nested-a", 2],
      ["nested-b", 2],
    ]);
  });

  it("derives one coherent active path from the normalized leaf instead of trusting malformed badges", () => {
    const model = buildSessionTreeModel({
      nodes: [node("root", null), node("active", "root"), node("unrelated", "root")],
      activeLeafId: "active",
      activePathIds: ["unrelated", "missing"],
    });

    const rows = visibleSessionTreeRows(model, new Set());
    expect(rows.filter((row) => row.activePath).map((row) => row.node.id)).toEqual(["root", "active"]);
    expect(rows.filter((row) => row.activeLeaf).map((row) => row.node.id)).toEqual(["active"]);
  });

  it("normalizes and renders a large deep tree without recursive or quadratic parent walks", () => {
    const count = 20_000;
    const nodes = Array.from({ length: count }, (_, index) => node(
      `node-${String(index)}`,
      index === 0 ? null : `node-${String(index - 1)}`,
    ));
    const model = buildSessionTreeModel({
      nodes,
      activeLeafId: `node-${String(count - 1)}`,
      activePathIds: [],
    });

    expect(model.orderedIds).toHaveLength(count);
    expect(model.depthById.get(`node-${String(count - 1)}`)).toBe(count - 1);
    expect(model.branchDepthById.get(`node-${String(count - 1)}`)).toBe(0);
    expect(model.activePathIds.size).toBe(count);
    expect(visibleSessionTreeRows(model, new Set())).toHaveLength(count);
  });

  it("keeps an empty snapshot inert", () => {
    const model = buildSessionTreeModel({ nodes: [], activeLeafId: null, activePathIds: [] });

    expect(initialSessionTreeSelection(model)).toBeUndefined();
    expect(visibleSessionTreeRows(model, new Set())).toEqual([]);
    const transition = transitionSessionTreeKey(model, { selectedId: undefined, foldedIds: new Set() }, "Enter");
    expect(transition).toMatchObject({ selectedId: undefined, handled: true });
    expect(transition.action).toBeUndefined();
  });
});

describe("session tree keyboard state", () => {
  const model = buildSessionTreeModel(snapshot());
  const expanded = { selectedId: "branch-1", foldedIds: new Set<string>() };

  it("moves over visible rows with arrows, Home, and End", () => {
    expect(transitionSessionTreeKey(model, expanded, "ArrowUp").selectedId).toBe("root");
    expect(transitionSessionTreeKey(model, expanded, "ArrowDown").selectedId).toBe("leaf-1");
    expect(transitionSessionTreeKey(model, expanded, "Home").selectedId).toBe("root");
    expect(transitionSessionTreeKey(model, expanded, "End").selectedId).toBe("branch-2");
    expect(transitionSessionTreeKey(model, { ...expanded, selectedId: "root" }, "ArrowUp").selectedId).toBe("root");
    expect(transitionSessionTreeKey(model, { ...expanded, selectedId: "branch-2" }, "ArrowDown").selectedId).toBe("branch-2");
  });

  it("folds or moves to a parent with Left and unfolds or moves to the first child with Right", () => {
    const folded = transitionSessionTreeKey(model, expanded, "ArrowLeft");
    expect([...folded.foldedIds]).toEqual(["branch-1"]);
    expect(folded.selectedId).toBe("branch-1");

    const parent = transitionSessionTreeKey(model, folded, "ArrowLeft");
    expect(parent.selectedId).toBe("root");

    const unfolded = transitionSessionTreeKey(model, folded, "ArrowRight");
    expect([...unfolded.foldedIds]).toEqual([]);
    expect(unfolded.selectedId).toBe("branch-1");

    expect(transitionSessionTreeKey(model, expanded, "ArrowRight").selectedId).toBe("leaf-1");
  });

  it("reports confirmation and cancellation actions and leaves unrelated keys alone", () => {
    expect(transitionSessionTreeKey(model, expanded, "Enter")).toMatchObject({ handled: true, action: "confirm", selectedId: "branch-1" });
    expect(transitionSessionTreeKey(model, expanded, "Escape")).toMatchObject({ handled: true, action: "cancel" });
    expect(transitionSessionTreeKey(model, expanded, "Tab")).toMatchObject({ handled: false, selectedId: "branch-1" });
  });

  it("selects a pointer-toggled branch and keeps folding immutable", () => {
    const originalFolded = new Set<string>();
    const folded = toggleSessionTreeFold(model, { selectedId: "leaf-1", foldedIds: originalFolded }, "root");

    expect(folded.selectedId).toBe("root");
    expect([...folded.foldedIds]).toEqual(["root"]);
    expect([...originalFolded]).toEqual([]);
    expect([...toggleSessionTreeFold(model, folded, "root").foldedIds]).toEqual([]);
  });
});

describe("session tree summary validation", () => {
  it("maps the three summary modes and trims custom focus", () => {
    expect(validateSessionTreeSummaryChoice("none", "ignored")).toEqual({ ok: true, choice: { mode: "none" } });
    expect(validateSessionTreeSummaryChoice("default", "ignored")).toEqual({ ok: true, choice: { mode: "default" } });
    expect(validateSessionTreeSummaryChoice("custom", "  focus on test failures\n  ")).toEqual({
      ok: true,
      choice: { mode: "custom", instructions: "focus on test failures" },
    });
  });

  it("rejects blank and oversized custom focus", () => {
    expect(validateSessionTreeSummaryChoice("custom", "   ")).toEqual({ ok: false, error: "Enter custom summary focus instructions." });
    expect(validateSessionTreeSummaryChoice("custom", "x".repeat(SESSION_TREE_CUSTOM_INSTRUCTIONS_MAX_LENGTH + 1))).toEqual({
      ok: false,
      error: `Custom summary focus must be ${String(SESSION_TREE_CUSTOM_INSTRUCTIONS_MAX_LENGTH)} characters or fewer.`,
    });
  });
});

describe("sessionTreeBranchPositions", () => {
  it("counts the branches at a fork and points at each neighbour's newest reply", () => {
    // root
    //  +- ask-1 -> reply-1
    //  +- ask-2 -> reply-2 -> ask-3 -> reply-3   (shown)
    //  +- ask-4 -> reply-4
    const positions = sessionTreeBranchPositions(buildSessionTreeModel({
      nodes: [
        node("root", null),
        userNode("ask-1", "root"),
        node("reply-1", "ask-1"),
        userNode("ask-2", "root"),
        node("reply-2", "ask-2"),
        userNode("ask-3", "reply-2"),
        node("reply-3", "ask-3"),
        userNode("ask-4", "root"),
        node("reply-4", "ask-4"),
      ],
      activeLeafId: "reply-3",
      activePathIds: ["root", "ask-2", "reply-2", "ask-3", "reply-3"],
    }));

    // The targets are replies, never the sibling asks: pi reads a user target as
    // "re-edit this" and would move the leaf to that target's parent instead.
    expect(positions.get("ask-2")).toEqual({ index: 2, total: 3, olderTargetId: "reply-1", newerTargetId: "reply-4" });
    // A fork deeper inside the shown branch is its own switcher, and the only
    // entries with siblings get one at all.
    expect(positions.get("ask-3")).toBeUndefined();
    expect(positions.get("root")).toBeUndefined();
  });

  it("treats parentless entries as each other's alternatives", () => {
    // Re-editing the very first message resets the leaf, so the new branch starts
    // at a second root rather than as a child.
    const positions = sessionTreeBranchPositions(buildSessionTreeModel({
      nodes: [
        userNode("ask-1", null),
        node("reply-1", "ask-1"),
        userNode("ask-2", null),
        node("reply-2", "ask-2"),
      ],
      activeLeafId: "reply-1",
      activePathIds: ["ask-1", "reply-1"],
    }));

    expect(positions.get("ask-1")).toEqual({ index: 1, total: 2, olderTargetId: undefined, newerTargetId: "reply-2" });
  });

  it("offers no target for a branch that has nothing to switch to yet", () => {
    // `ask-2` was sent but produced no entry, so there is nothing pi can switch
    // to: navigating to `ask-2` itself would rewind rather than show the branch.
    const positions = sessionTreeBranchPositions(buildSessionTreeModel({
      nodes: [
        node("root", null),
        userNode("ask-1", "root"),
        node("reply-1", "ask-1"),
        userNode("ask-2", "root"),
      ],
      activeLeafId: "reply-1",
      activePathIds: ["root", "ask-1", "reply-1"],
    }));

    expect(positions.get("ask-1")).toEqual({ index: 1, total: 2, olderTargetId: undefined, newerTargetId: undefined });
  });

  it("falls back to an earlier fork when the newest one holds nothing switchable", () => {
    // Inside the alternative branch, the newest fork (`ask-3`) is unanswered, so
    // the switch target has to come from the older fork's reply.
    const positions = sessionTreeBranchPositions(buildSessionTreeModel({
      nodes: [
        node("root", null),
        userNode("ask-1", "root"),
        node("reply-1", "ask-1"),
        userNode("ask-2", "root"),
        node("reply-2", "ask-2"),
        userNode("ask-3", "ask-2"),
      ],
      activeLeafId: "reply-1",
      activePathIds: ["root", "ask-1", "reply-1"],
    }));

    expect(positions.get("ask-1")?.newerTargetId).toBe("reply-2");
  });

  it("skips a custom message when choosing a target", () => {
    const positions = sessionTreeBranchPositions(buildSessionTreeModel({
      nodes: [
        node("root", null),
        userNode("ask-1", "root"),
        node("reply-1", "ask-1"),
        userNode("ask-2", "root"),
        node("reply-2", "ask-2"),
        { id: "note", parentId: "reply-2", kind: "custom-message", summary: "note" },
      ],
      activeLeafId: "reply-1",
      activePathIds: ["root", "ask-1", "reply-1"],
    }));

    expect(positions.get("ask-1")?.newerTargetId).toBe("reply-2");
  });
});

function snapshot(): SessionTreeSnapshot {
  return {
    nodes: [
      node("root", null),
      node("branch-1", "root"),
      node("leaf-1", "branch-1"),
      node("branch-2", "root"),
    ],
    activeLeafId: null,
    activePathIds: [],
  };
}

function node(id: string, parentId: string | null): SessionTreeNode {
  return { id, parentId, kind: "assistant", summary: id };
}

function userNode(id: string, parentId: string | null): SessionTreeNode {
  return { id, parentId, kind: "user", summary: id };
}
