import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { resolveNodeRef, tryResolveNodeRef, assignUniqueName, isUuid, nameForId, namesForIds } from "../src/tools/node-ref.js";

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

  it("REFUSES a ref a populated tree does not claim (item 1.5 / O-01)", () => {
    // This asserted `.toBe("never-recorded")` — fail-open — and that IS the
    // defect. Resolving an unregistered ref to itself mints a second identity:
    // a writer then creates `nodes/<ref>/`, and the node exists under two names
    // with nothing tying them together. Integrity check 5 looked under the UUID,
    // found nothing, and failed `iir-scan-binnet-02` — which had 12,000
    // well-formed telemetry records — and that verdict stood as the run's last
    // word. `wave1-seal-provenance.test.ts` requires the refusal by name.
    writeTree({ [UUID]: node(UUID, "immune-memory-02") });
    expect(() => resolveNodeRef(RUN, "never-recorded", MISSION)).toThrow(/not in this run's tree/);
  });

  it("still fails open when tree.json is missing", () => {
    // Unchanged, and the distinction that makes the refusal above safe: an
    // ABSENT tree is not a registry that excludes the ref, it is the absence of
    // a registry. Setup flows resolve names before any node is recorded, and
    // refusing there would turn "nothing has happened yet" into an error.
    expect(resolveNodeRef(RUN, "immune-memory-02", MISSION)).toBe("immune-memory-02");
  });

  it("fails open for an EMPTY tree — absence is not a verdict", () => {
    writeTree({});
    expect(resolveNodeRef(RUN, "immune-memory-02", MISSION)).toBe("immune-memory-02");
  });

  it("readers get null instead of a throw", () => {
    // `tryResolveNodeRef` exists because two questions hid behind one name:
    // "what is the canonical id" (an unregistered ref has no answer) and "does
    // this node have artifacts" (the honest answer is "none", not a crash).
    writeTree({ [UUID]: node(UUID, "immune-memory-02") });
    expect(tryResolveNodeRef(RUN, "never-recorded", MISSION)).toBeNull();
    expect(tryResolveNodeRef(RUN, "immune-memory-02", MISSION)).toBe(UUID);
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

const UUID2 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

describe("nameForId", () => {
  it("returns the node name when set", () => {
    writeTree({ [UUID]: node(UUID, "immune-memory-02") });
    expect(nameForId(RUN, UUID, MISSION)).toBe("immune-memory-02");
  });

  it("derives a readable fallback from approach_family when name not set", () => {
    writeTree({ [UUID]: node(UUID) }); // no name, approach_family = "training"
    const result = nameForId(RUN, UUID, MISSION);
    expect(result).not.toBe(UUID); // must NOT surface the UUID
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });

  it("fails open (returns id unchanged) when tree unreadable", () => {
    // no tree written — tree is missing
    expect(nameForId(RUN, UUID, MISSION)).toBe(UUID);
  });

  it("fails open (returns id unchanged) when id not in tree", () => {
    writeTree({ [UUID]: node(UUID, "immune-memory-02") });
    expect(nameForId(RUN, UUID2, MISSION)).toBe(UUID2);
  });
});

describe("namesForIds", () => {
  it("maps each id to its name", () => {
    writeTree({
      [UUID]: node(UUID, "immune-memory-02"),
      [UUID2]: node(UUID2, "spectral-membrane-03"),
    });
    const result = namesForIds(RUN, [UUID, UUID2], MISSION);
    expect(result).toEqual(["immune-memory-02", "spectral-membrane-03"]);
  });

  it("uses fallback for ids without a name", () => {
    writeTree({ [UUID]: node(UUID) }); // no name
    const result = namesForIds(RUN, [UUID], MISSION);
    expect(result[0]).not.toBe(UUID);
    expect(typeof result[0]).toBe("string");
  });

  it("returns empty array for empty input", () => {
    writeTree({ [UUID]: node(UUID, "immune-memory-02") });
    expect(namesForIds(RUN, [], MISSION)).toEqual([]);
  });
});
