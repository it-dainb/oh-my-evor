/**
 * mcp/tests/seal-to-readers.test.ts
 *
 * The seal WRITES the evaluator anchor; three components READ it. This file runs
 * the real seal and then every reader, in both runtimes, on what it wrote.
 *
 * v1.2.6 changed what the seal writes — a digest over the evaluator's whole file
 * set, to bring score_plugin.py under custody — and no reader moved with it:
 *
 *   integrity check 4 (no_eval_shift)        sha256(eval-suites/<v>.py) == anchor
 *   ForgeStructureGate.eval_locked           sha256(worktree/evaluate.py) == anchor
 *   lockEvaluate (TS)                        sha256(worktree/evaluate.py) == anchor
 *
 * Every node failed no_eval_shift, and no node could be locked, from v1.2.6 until
 * a live tick on a current CLI got far enough to reach the gate. The tests at the
 * time pinned the seal to evor.eval_contract and nothing pinned it to its readers
 * — the same shape as every defect in this series: a fact with one writer and
 * several readers, and no test crossing from one to the others.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "child_process";
import { createHash } from "crypto";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, copyFileSync } from "fs";
import { tmpdir } from "os";
import { join, dirname, resolve } from "path";
import { fileURLToPath } from "url";
import { registerComputeTools, lockEvaluate } from "../src/tools/compute.js";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const HARNESS = resolve(TEST_DIR, "../../harness");
const UUID = "11111111-2222-4333-8444-555555555555";
const NAME = "n001-seed";
const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

let root: string;
let runDir: string;
let saved: string | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "evor-seal-readers-"));
  saved = process.env.EVOR_ROOT;
  process.env.EVOR_ROOT = root;
  runDir = join(root, "runs", "m1", "r1");
  mkdirSync(join(runDir, "eval-suites"), { recursive: true });
  writeFileSync(join(runDir, "goal-contract.json"), JSON.stringify({ mission_id: "m1", eval_version: "v1" }));
  writeFileSync(join(runDir, "eval-suites", "v1.py"), "from score_plugin import score\nprint('{}')\n");
  writeFileSync(join(runDir, "eval-suites", "score_plugin.py"), "def score(p, g, **k):\n    return {'f': 0.5}\n");
  // A schema-valid tree node, so lockEvaluate can resolve it.
  writeFileSync(join(runDir, "tree.json"), JSON.stringify({
    updated_at: "2026-10-30T00:00:00Z",
    nodes: { [UUID]: {
      id: UUID, name: NAME, parent_ids: [], approach_family: "arch", hypothesis_id: "h1",
      code_ref: "x", genome_ref: "g", data_version_ref: "d", config: {}, metrics: {}, eval_version: "v1",
    } },
  }));
});
afterEach(() => {
  if (saved === undefined) delete process.env.EVOR_ROOT; else process.env.EVOR_ROOT = saved;
  rmSync(root, { recursive: true, force: true });
});

async function seal(): Promise<Record<string, unknown>> {
  const handlers = new Map<string, (a: never) => Promise<{ content: { text: string }[] }>>();
  registerComputeTools({ tool: (n: string, _d: string, _s: unknown, h: never) => handlers.set(n, h) } as never);
  const res = await handlers.get("evor_seal_eval_script")!({ run_id: "r1", eval_version: "v1", mission_id: "m1" } as never);
  return JSON.parse(res.content[0].text);
}

const contract = () => JSON.parse(readFileSync(join(runDir, "goal-contract.json"), "utf8"));

/** Ask the PYTHON readers about the contract on disk. */
function pyReaders(worktreeEval?: string): { check4: boolean; plugin: boolean | null; forge: boolean | null } {
  const code = `
import json, sys
from pathlib import Path
from evor.eval_contract import eval_script_anchor_matches, plugin_anchor_matches, per_file_anchor
from evor.quality_gate import ForgeStructureGate
run = Path(${JSON.stringify(runDir)})
c = json.loads((run / "goal-contract.json").read_text())
ev = run / "eval-suites" / "v1.py"
out = {"check4": eval_script_anchor_matches(c.get("eval_script_hash"), ev),
       "plugin": plugin_anchor_matches(c.get("eval_plugin_hash"), ev), "forge": None}
wt = ${JSON.stringify(worktreeEval ?? "")}
if wt:
    gate = ForgeStructureGate(locked_eval_hash=per_file_anchor(c.get("eval_script_hash"), ev))
    out["forge"] = gate._check_eval_locked(Path(wt).parent).passed
print(json.dumps(out))
`;
  const r = spawnSync("python3", ["-c", code], { encoding: "utf8", env: { ...process.env, PYTHONPATH: HARNESS } });
  if (r.status !== 0) throw new Error(r.stderr);
  return JSON.parse(r.stdout.trim().split("\n").pop()!);
}

function worktreeCopy(): string {
  const wt = join(root, "worktrees", NAME);
  mkdirSync(wt, { recursive: true });
  copyFileSync(join(runDir, "eval-suites", "v1.py"), join(wt, "evaluate.py"));
  return join(wt, "evaluate.py");
}

describe("what the seal writes, every reader accepts", () => {
  it("writes one anchor per file — the harness's sha256 and the plugin's", async () => {
    const out = await seal();
    expect(out.ok).toBe(true);
    const c = contract();
    expect(c.eval_script_hash).toBe(sha(readFileSync(join(runDir, "eval-suites", "v1.py"))));
    expect(c.eval_plugin_hash).toBe(sha(readFileSync(join(runDir, "eval-suites", "score_plugin.py"))));
  });

  it("integrity check 4, ForgeStructureGate and lockEvaluate all pass a verbatim node", async () => {
    await seal();
    const wt = worktreeCopy();
    const py = pyReaders(wt);
    expect(py.check4, "integrity no_eval_shift").toBe(true);
    expect(py.plugin, "plugin anchor").toBe(true);
    expect(py.forge, "ForgeStructureGate.eval_locked").toBe(true);
    const lock = lockEvaluate("r1", NAME, "m1");
    expect(lock.ok, lock.error).toBe(true);
  });

  it("a rewritten metric fails no_eval_shift even though the harness is untouched", async () => {
    await seal();
    writeFileSync(join(runDir, "eval-suites", "score_plugin.py"), "def score(p, g, **k):\n    return {'f': 0.99}\n");
    const py = pyReaders();
    expect(py.check4).toBe(true);
    expect(py.plugin, "the plugin anchor must catch the metric changing").toBe(false);
  });

  it("refuses to re-seal over a changed plugin", async () => {
    await seal();
    writeFileSync(join(runDir, "eval-suites", "score_plugin.py"), "def score(p, g, **k):\n    return {'f': 0.99}\n");
    const out = await seal();
    expect(out.ok).not.toBe(true);
  });
});

describe("a run sealed by v1.2.6–v1.2.9 (set-digest anchor) is still judged correctly", () => {
  function setDigest(): string {
    const acc = createHash("sha256");
    for (const name of ["v1.py", "score_plugin.py"]) {
      acc.update(name); acc.update(Buffer.from([0]));
      acc.update(sha(readFileSync(join(runDir, "eval-suites", name)))); acc.update("\n");
    }
    return acc.digest("hex");
  }
  beforeEach(() => {
    const d = setDigest();
    writeFileSync(join(runDir, "goal-contract.json"), JSON.stringify({ mission_id: "m1", eval_version: "v1", eval_script_hash: d }));
    writeFileSync(join(runDir, "eval-suites", "v1.sealed.json"), JSON.stringify({
      eval_version: "v1", hash: d,
      files: {
        "v1.py": sha(readFileSync(join(runDir, "eval-suites", "v1.py"))),
        "score_plugin.py": sha(readFileSync(join(runDir, "eval-suites", "score_plugin.py"))),
      },
    }));
  });

  it("every reader accepts it for an unchanged evaluator", () => {
    const wt = worktreeCopy();
    const py = pyReaders(wt);
    expect(py.check4).toBe(true);
    expect(py.forge).toBe(true);
    expect(lockEvaluate("r1", NAME, "m1").ok).toBe(true);
  });

  it("re-sealing the same bytes is allowed and rewrites the anchor to the per-file form", async () => {
    const out = await seal();
    expect(out.ok, JSON.stringify(out)).toBe(true);
    expect(contract().eval_script_hash).toBe(sha(readFileSync(join(runDir, "eval-suites", "v1.py"))));
  });

  it("a changed harness is still caught", () => {
    writeFileSync(join(runDir, "eval-suites", "v1.py"), "print('tampered')\n");
    expect(pyReaders().check4).toBe(false);
  });
});
