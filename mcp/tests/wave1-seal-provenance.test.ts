/**
 * tests/wave1-seal-provenance.test.ts
 * Wave 2 category 1 — seal and provenance integrity (RED phase).
 *
 * Findings come from the v1.2.0 field trace (docs/field-trace-v1.2.0/):
 *   M-01 / I-02 — all three runs' eval-suites/v1.py were ONE inode, nlink 5.
 *   J-01        — the seal was re-applied over content changed out of band.
 *   O-01        — node-identity split-brain (slug vs uuid), fail-open resolution.
 *
 * Every test asserts the invariant the system is supposed to hold, never the
 * behaviour observed in the field. Statuses are recorded in
 * docs/field-trace-v1.2.0/red/T1-seal-provenance.md.
 *
 * Idioms follow compute.test.ts (captureComputeHandlers/callTool, EVOR_ROOT in a
 * tmpdir) and node-ref.test.ts (real tree.json fixture).
 */

import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, statSync, linkSync } from "fs";
import { createHash } from "crypto";
import { join } from "path";
import { tmpdir } from "os";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../src/subprocess-bridge.js", () => ({
  callPythonModule: vi.fn(),
  callBridge: vi.fn(),
}));

import { registerComputeTools, verifyArtifacts } from "../src/tools/compute.js";
import { resolveNodeRef } from "../src/tools/node-ref.js";

// ── Harness ───────────────────────────────────────────────────────────────────

function captureComputeHandlers(): Map<string, (args: never) => Promise<{ content: { text: string }[] }>> {
  const handlers = new Map<string, (args: never) => Promise<{ content: { text: string }[] }>>();
  const fakeServer = {
    tool: (name: string, _desc: string, _schema: unknown, handler: never) => {
      handlers.set(name, handler as (args: never) => Promise<{ content: { text: string }[] }>);
    },
  };
  registerComputeTools(fakeServer as never);
  return handlers;
}

async function callTool(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const handler = captureComputeHandlers().get(name);
  if (!handler) throw new Error(`tool ${name} was not registered`);
  const res = await handler(args as never);
  return JSON.parse(res.content[0].text) as Record<string, unknown>;
}

const MISSION = "binarization-worldmodel-min98-2026-08";
const sha256 = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");

let tmpRoot: string;
let savedEvorRoot: string | undefined;
let savedMission: string | undefined;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "evor-wave1-seal-"));
  savedEvorRoot = process.env.EVOR_ROOT;
  savedMission = process.env.EVOR_MISSION_ID;
  process.env.EVOR_ROOT = tmpRoot;
  process.env.EVOR_MISSION_ID = MISSION;
});

afterEach(() => {
  if (savedEvorRoot === undefined) delete process.env.EVOR_ROOT;
  else process.env.EVOR_ROOT = savedEvorRoot;
  if (savedMission === undefined) delete process.env.EVOR_MISSION_ID;
  else process.env.EVOR_MISSION_ID = savedMission;
  rmSync(tmpRoot, { recursive: true, force: true });
});

/** Create runs/<mission>/<runId>/ with an eval-suites dir and an empty contract. */
function makeRun(runId: string): string {
  const runDir = join(tmpRoot, "runs", MISSION, runId);
  mkdirSync(join(runDir, "eval-suites"), { recursive: true });
  writeFileSync(join(runDir, "goal-contract.json"), JSON.stringify({}), "utf8");
  return runDir;
}

function contractOf(runDir: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(runDir, "goal-contract.json"), "utf8")) as Record<string, unknown>;
}

// ── M-01 / I-02 — the seal must not accept a shared inode ─────────────────────

describe("M-01 / I-02 — evor_seal_eval_script and hardlinked evaluators", () => {
  /**
   * Invariant: a run's sealed evaluator is byte-stable for the life of the run.
   * A file that shares an inode with a path outside the run directory is not,
   * so the seal must either refuse it or break the link by copying.
   *
   * Current behaviour: evor_seal_eval_script reads the bytes, hashes them and
   * patches goal-contract.json. It never inspects st_nlink and never copies —
   * which is how all three field runs ended up sharing inode 28705681 at
   * nlink 5, and how a 23:49 rewrite retroactively replaced r1's and r2's
   * archived evaluators.
   */
  it("refuses, or defensively copies, an evaluator hardlinked outside the run", async () => {
    // The canonical evaluator lives in the project root, outside .evor/runs/**.
    const canonical = join(tmpRoot, "v1.py");
    writeFileSync(canonical, "# evaluator rev 1\nLATENCY_GPU_MS_MAX = 10.0\n", "utf8");

    const runDir = makeRun("run-live-01");
    const sealed = join(runDir, "eval-suites", "v1.py");
    linkSync(canonical, sealed); // this is exactly how the field run made its "copy"

    const out = await callTool("evor_seal_eval_script", {
      run_id: "run-live-01",
      eval_version: "v1",
      mission_id: MISSION,
    });

    const refused = out.ok === false;
    const decoupled = statSync(sealed).nlink === 1;
    expect(
      refused || decoupled,
      `seal accepted an evaluator with st_nlink=${statSync(sealed).nlink}; ` +
      "a rewrite through the unprotected alias reaches the sealed copy",
    ).toBe(true);
  });

  /**
   * Invariant: after two runs seal the same evaluator, a rewrite through any
   * path outside run B must leave run B's recorded hash still verifying against
   * run B's file.
   *
   * Current behaviour: both run dirs point at one inode, so r3's 23:49 rewrite
   * silently replaced r2's sealed evaluator and r2's fmeasure 48.72 became
   * unreproducible.
   */
  it("a rewrite for one run does not change another run's sealed evaluator", async () => {
    const canonical = join(tmpRoot, "v1.py");
    writeFileSync(canonical, "# evaluator rev 1\nLATENCY_GPU_MS_MAX = 10.0\n", "utf8");

    const r2 = makeRun("run-r2");
    const r3 = makeRun("run-r3");
    linkSync(canonical, join(r2, "eval-suites", "v1.py"));
    linkSync(canonical, join(r3, "eval-suites", "v1.py"));

    for (const [runId, dir] of [["run-r2", r2], ["run-r3", r3]] as const) {
      const out = await callTool("evor_seal_eval_script", {
        run_id: runId, eval_version: "v1", mission_id: MISSION,
      });
      expect(out.ok, `sealing ${runId} failed outright: ${String(out.error)}`).toBe(true);
      expect(typeof contractOf(dir).eval_script_hash).toBe("string");
    }

    const r2Hash = contractOf(r2).eval_script_hash as string;

    // r3's agent rewrites the evaluator through the unprotected project-root alias.
    writeFileSync(canonical, "# evaluator rev 2\nLATENCY_GPU_MS_MAX = 500.0\n", "utf8");

    const r2OnDisk = sha256(readFileSync(join(r2, "eval-suites", "v1.py"), "utf8"));
    expect(
      r2OnDisk,
      "r2's sealed evaluator changed when r3's evaluator was rewritten — the two runs share an inode",
    ).toBe(r2Hash);
  });
});

// ── J-01 — re-sealing must not launder an out-of-band rewrite ─────────────────

describe("J-01 — the seal re-applied over content changed out of band", () => {
  /**
   * Invariant: once a run has an eval_script_hash, sealing again over DIFFERENT
   * content is a seal violation, not a fresh seal. The recorded anchor is the
   * denominator of every integrity verdict already issued under it, so it may
   * not be silently replaced (this mirrors FrozenSplitManager's refusal to
   * re-freeze without allow_refreeze=True).
   *
   * Current behaviour: the handler unconditionally hashes whatever is on disk
   * and calls patchGoalContract. In the field an agent patched the sealed
   * evaluator through a split string literal (`".../v1" + "." + "p" + "y"`),
   * ran `chmod 444`, and the new hash a3776de4… was recorded as the locked
   * evaluator hash in run state. no_eval_shift never had a mismatch to find.
   */
  it("refuses to re-seal a run over changed evaluator content", async () => {
    const runDir = makeRun("run-live-01");
    const sealed = join(runDir, "eval-suites", "v1.py");
    const original = "# evaluator rev 1\nLATENCY_GPU_MS_MAX = 10.0\n";
    writeFileSync(sealed, original, "utf8");

    const first = await callTool("evor_seal_eval_script", {
      run_id: "run-live-01", eval_version: "v1", mission_id: MISSION,
    });
    expect(first.ok).toBe(true);
    expect(contractOf(runDir).eval_script_hash).toBe(sha256(original));

    // Out-of-band rewrite, then the seal is re-applied.
    writeFileSync(sealed, "# evaluator rev 2\nLATENCY_GPU_MS_MAX = 500.0\n", "utf8");
    const second = await callTool("evor_seal_eval_script", {
      run_id: "run-live-01", eval_version: "v1", mission_id: MISSION,
    });

    expect(
      second.ok,
      "re-sealing over changed content succeeded; the recorded anchor now matches the tampered file",
    ).toBe(false);
    expect(
      contractOf(runDir).eval_script_hash,
      "the contract's eval_script_hash was overwritten with the hash of the rewritten evaluator",
    ).toBe(sha256(original));
  });

  /**
   * Invariant: re-sealing identical content is a no-op, not an error — setup
   * flows legitimately call the seal twice. Fail loud, not locked out.
   *
   * Current behaviour: already correct (patchGoalContract skips an unchanged
   * value). Kept so the fix above cannot be "always refuse the second call".
   */
  it("re-sealing identical content stays idempotent", async () => {
    const runDir = makeRun("run-live-01");
    const content = "# evaluator rev 1\n";
    writeFileSync(join(runDir, "eval-suites", "v1.py"), content, "utf8");

    const first = await callTool("evor_seal_eval_script", {
      run_id: "run-live-01", eval_version: "v1", mission_id: MISSION,
    });
    const second = await callTool("evor_seal_eval_script", {
      run_id: "run-live-01", eval_version: "v1", mission_id: MISSION,
    });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(contractOf(runDir).eval_script_hash).toBe(sha256(content));
  });
});

// ── O-01 — node identity split-brain ─────────────────────────────────────────

function treeNode(id: string, name?: string): Record<string, unknown> {
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
    created_at: "2026-08-24T00:00:00Z",
  };
}

function writeTree(runId: string, nodes: Record<string, unknown>): string {
  const dir = join(tmpRoot, "runs", MISSION, runId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "tree.json"),
    JSON.stringify({ nodes, updated_at: "2026-08-24T00:00:00Z" }),
    "utf8",
  );
  return dir;
}

const NODE_UUID = "afb204f4-66d0-4c6e-9f1e-ced66d31de8b";
const NODE_SLUG = "iir-scan-binnet-02";

describe("O-01 — one canonical node id, both writers agree", () => {
  /**
   * Invariant: resolution is the single point where a node reference becomes a
   * directory key, so it must never mint an identity that no registry contains.
   * An unresolvable ref has to fail loudly; returning it unchanged is what
   * lets the trainer write nodes/<slug>/ while the gate reads nodes/<uuid>/.
   *
   * Current behaviour: step 4 of resolveNodeRef is documented fail-open — "No
   * match → return the ref UNCHANGED". In the field, job 3679dbc8 logged
   * "node 'iir-binnet-01' not found in tree.json" and the run continued with
   * two live identities for one candidate.
   */
  it("refuses to resolve a ref that is in no registry", () => {
    writeTree("run-live-01", { [NODE_UUID]: treeNode(NODE_UUID, NODE_SLUG) });

    expect(
      () => resolveNodeRef("run-live-01", "iir-binnet-01", MISSION),
      "an unregistered ref resolved to itself instead of failing — a second node identity was minted",
    ).toThrow();
  });

  /**
   * Invariant (control arm): a registered slug still resolves to its uuid, and
   * a uuid still resolves to itself. Already GREEN — kept so the fix above
   * cannot be "throw on everything".
   */
  it("still resolves a registered slug and a registered uuid", () => {
    writeTree("run-live-01", { [NODE_UUID]: treeNode(NODE_UUID, NODE_SLUG) });
    expect(resolveNodeRef("run-live-01", NODE_SLUG, MISSION)).toBe(NODE_UUID);
    expect(resolveNodeRef("run-live-01", NODE_UUID, MISSION)).toBe(NODE_UUID);
  });

  /**
   * Invariant: a node's deliverables are found regardless of which of its two
   * identities the writer used. The trainer writes nodes/<slug>/telemetry.jsonl;
   * verifyArtifacts resolves the slug to the uuid and looks only there.
   *
   * Current behaviour: has_telemetry=false against a node with 12,000
   * well-formed telemetry records — the same false negative that produced
   * r3's `telemetry_sane` verdict at 01:56 and was never re-scored.
   */
  it("finds telemetry the trainer wrote under the slug", () => {
    const runDir = writeTree("run-live-01", { [NODE_UUID]: treeNode(NODE_UUID, NODE_SLUG) });

    // Harness half, keyed by UUID.
    mkdirSync(join(runDir, "nodes", NODE_UUID), { recursive: true });
    writeFileSync(join(runDir, "nodes", NODE_UUID, "results.json"),
      JSON.stringify({ status: "success", telemetry_summary: { total_steps: 12000 } }), "utf8");

    // Trainer half, keyed by SLUG.
    mkdirSync(join(runDir, "nodes", NODE_SLUG), { recursive: true });
    writeFileSync(join(runDir, "nodes", NODE_SLUG, "telemetry.jsonl"),
      Array.from({ length: 120 }, (_, i) =>
        JSON.stringify({ step: i, train_loss: 2 - i * 0.01, grad_norm: 1.5 })).join("\n") + "\n",
      "utf8");

    const out = verifyArtifacts("run-live-01", NODE_SLUG, MISSION);
    expect(
      out.has_telemetry,
      `telemetry.jsonl exists at nodes/${NODE_SLUG}/ and verifyArtifacts looked only under nodes/${NODE_UUID}/`,
    ).toBe(true);
    expect(out.ok).toBe(true);
  });
});
