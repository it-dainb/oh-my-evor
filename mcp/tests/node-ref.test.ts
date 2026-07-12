import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { resolveNodeRef, assignUniqueName, isUuid } from "../src/tools/node-ref.js";

// node-ref reads tree.json via readTree(runId, missionId), which resolves under
// EVOR_ROOT/runs/<mission>/<run>/tree.json. We stand up a real temp store.

let root: string;
const RUN = "r-noderef";
const MISSION = "m-noderef";

// Build a schema-complete TreeNode (readTree validates against TreeNodeSchema).
function node(id: string, name?: string): Record<string, unknown> {
  return {
    id,
    ...(name ? { name } : {}),
    parent_ids: [],
    approach_family: "training",
    hypothesis_id: "h1",
    code_ref: "c1",
    genome_ref: "g1",
    data_version_ref: "d1",
    config: {},
    metrics: {},
    eval_version: "v1",
    lesson_ids: [],
    citations: [],
    integrity_status: "pending",
    status: "running",
    is_crossover: false,
    visit_count: 0,
    depth: 0,
    created_at: "2026-01-01T00:00:00Z",
  };
}

function writeTree(nodes: Record<string, unknown>): void {
  const dir = join(root, "runs", MISSION, RUN);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "tree.json"),
    JSON.stringify({ nodes, updated_at: "2026-01-01T00:00:00Z" }),
    "utf8",
  );
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "evor-noderef-"));
  process.env.EVOR_ROOT = root;
  process.env.EVOR_MISSION_ID = MISSION;
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  delete process.env.EVOR_ROOT;
  delete process.env.EVOR_MISSION_ID;
});

const UUID = "3b578937-63e9-44f9-b015-1e63ee379bd7";

describe("isUuid", () => {
  it("recognizes a canonical uuid", () => {
    expect(isUuid(UUID)).toBe(true);
  });
  it("rejects a slug", () => {
    expect(isUuid("immune-memory-02")).toBe(false);
  });
});

describe("resolveNodeRef", () => {
  it("returns a uuid unchanged when it is a real node id (fast-path)", () => {
    writeTree({ [UUID]: node(UUID, "immune-memory-02") });
    expect(resolveNodeRef(RUN, UUID, MISSION)).toBe(UUID);
  });

  it("resolves a slug to the node's uuid", () => {
    writeTree({ [UUID]: node(UUID, "immune-memory-02") });
    expect(resolveNodeRef(RUN, "immune-memory-02", MISSION)).toBe(UUID);
  });

  it("resolves a sweep-arm sub-identity to the parent node's id", () => {
    writeTree({ [UUID]: node(UUID, "immune-memory-02") });
    expect(resolveNodeRef(RUN, "immune-memory-02:b80", MISSION)).toBe(UUID);
  });

  it("fails open (returns ref unchanged) when unresolvable — downstream reports", () => {
    writeTree({ [UUID]: node(UUID, "immune-memory-02") });
    expect(resolveNodeRef(RUN, "never-recorded", MISSION)).toBe("never-recorded");
  });

  it("fails open when tree.json is missing", () => {
    expect(resolveNodeRef(RUN, "immune-memory-02", MISSION)).toBe("immune-memory-02");
  });
});

describe("assignUniqueName", () => {
  it("returns the desired name when free", () => {
    writeTree({ [UUID]: node(UUID, "spectral-membrane-03") });
    expect(assignUniqueName(RUN, "immune-memory-02", MISSION)).toBe("immune-memory-02");
  });

  it("auto-suffixes on collision (decision #1)", () => {
    writeTree({ [UUID]: node(UUID, "immune-memory-02") });
    expect(assignUniqueName(RUN, "immune-memory-02", MISSION)).toBe("immune-memory-02-2");
  });

  it("finds the next free suffix when -2 is also taken", () => {
    const idA = "11111111-1111-4111-8111-111111111111";
    const idB = "22222222-2222-4222-8222-222222222222";
    writeTree({
      [idA]: node(idA, "immune-memory-02"),
      [idB]: node(idB, "immune-memory-02-2"),
    });
    expect(assignUniqueName(RUN, "immune-memory-02", MISSION)).toBe("immune-memory-02-3");
  });

  it("returns empty string for empty desired", () => {
    expect(assignUniqueName(RUN, "", MISSION)).toBe("");
  });
});
