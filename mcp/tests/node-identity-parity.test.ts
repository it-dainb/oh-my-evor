/**
 * mcp/tests/node-identity-parity.test.ts
 *
 * O-01 has TWO owners because it has two runtimes: `harness/evor/node_identity.py`
 * for the harness, `hooks/lib/node-identity.mjs` for the hooks and the MCP
 * server. Two implementations of one rule is exactly the shape of the original
 * defect — every reader independently guessing which identity a writer used —
 * so they are pinned here over one fixture.
 *
 * The fixture is the real split, from a live run: `nodes/<uuid>/results.json`
 * beside `nodes/<name>/telemetry.jsonl`, one node, same run.
 */

import { describe, it, expect } from "vitest";
import { spawnSync } from "child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join, dirname, resolve } from "path";
import { fileURLToPath } from "url";
import {
  aliasesFromTree,
  resolveNodeArtifactByRef,
  resolveNodeArtifact,
} from "../../hooks/lib/node-identity.mjs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const UUID = "cf9f0020-f377-420b-a7ba-e9d203e9066c";
const NAME = "n001-depthwise-unet";

const REAL_NODE = {
  "id": "cf9f0020-f377-420b-a7ba-e9d203e9066c",
  "name": "n001-depthwise-unet",
  "parent_ids": [],
  "approach_family": "arch",
  "hypothesis_id": "h001-arch-depthwise-unet",
  "code_ref": "/home/dainb_1/research/binarization/.evor/worktrees/n001-depthwise-unet",
  "genome_ref": "e4977bfc2e4194160a3f0cea738670baddf8a71b53c8bc9e00cd81a7050c61d4",
  "mutation_tier": "structural",
  "mutation_locus": {
    "family": "arch",
    "path": "model/"
  },
  "data_version_ref": "corpora/v10",
  "config": {
    "model": "depthwise_thin_stroke_unet",
    "n_params": 152801,
    "precision": "fp32",
    "tile_size": 256,
    "batch_size": 16,
    "optimizer": "adamw",
    "lr": 0.001,
    "max_epochs": 180,
    "stopped_epoch": 115,
    "loss": "composite_dice_bce",
    "from_scratch": true
  },
  "metrics": {
    "f2_raw_min_domain": 64.0261,
    "fmeasure_min_domain": 53.9527,
    "precision_min_domain": 0.43478,
    "precision_mean": 0.73225,
    "recall_mean": 0.86771,
    "agg_f2": 85.6487,
    "agg_fmeasure": 81.4926,
    "f2_mean": 82.2098,
    "fmeasure_mean": 77.8408,
    "latency_gpu_ms": 591.556,
    "latency_cpu_4k_s": 9.4919,
    "vram_gb": 0.7577,
    "bytes_per_px": 3709.6296,
    "kmac_per_px": 45.3152,
    "precision_penalty_multiplier": 0.385778,
    "fitness_before_gates": 24.7
  },
  "eval_version": "v3",
  "fitness_value": 0,
  "status": "done",
  "integrity_status": "passed",
  "created_at": "2026-09-14T08:06:35.550Z"
} as const;

/** A run holding the real split: telemetry under the name, results under the uuid. */
function splitFixture() {
  const root = mkdtempSync(join(tmpdir(), "evor-o01-"));
  mkdirSync(join(root, "nodes", UUID), { recursive: true });
  mkdirSync(join(root, "nodes", NAME), { recursive: true });
  writeFileSync(join(root, "nodes", UUID, "results.json"), "{}");
  writeFileSync(join(root, "nodes", NAME, "telemetry.jsonl"), '{"step":1}\n');
  writeFileSync(
    join(root, "tree.json"),
    JSON.stringify({ nodes: { [UUID]: { id: UUID, name: NAME } }, updated_at: "2026-09-14T08:06:35.551Z" }),
  );
  return root;
}

/** The Python owner's answer, via a one-liner against the same fixture. */
function py(expr: string): string {
  const r = spawnSync("python3", ["-c", expr], {
    encoding: "utf8",
    cwd: REPO,
    env: { ...process.env, PYTHONPATH: join(REPO, "harness") },
  });
  if (r.status !== 0) throw new Error(`python owner failed: ${r.stderr}`);
  return r.stdout.trim();
}

describe("the JS and Python identity owners agree", () => {
  const cases: Array<[string, string, string]> = [
    ["telemetry from the uuid", UUID, "telemetry.jsonl"],
    ["telemetry from the name", NAME, "telemetry.jsonl"],
    ["results from the uuid", UUID, "results.json"],
    ["results from the name", NAME, "results.json"],
  ];

  for (const [label, ref, artifact] of cases) {
    it(label, () => {
      const root = splitFixture();
      const jsPath = resolveNodeArtifactByRef(root, ref, artifact);
      const pyPath = py(
        `from pathlib import Path\n` +
          `from evor.node_identity import resolve_node_artifact_by_ref\n` +
          `print(resolve_node_artifact_by_ref(Path(${JSON.stringify(root)}), ${JSON.stringify(ref)}, ${JSON.stringify(artifact)}) or "")`,
      );
      rmSync(root, { recursive: true, force: true });
      expect(jsPath, "JS resolver found nothing").toBeTruthy();
      expect(jsPath).toBe(pyPath);
    });
  }

  it("both return nothing for an artifact that exists under neither identity", () => {
    // The safety property: resolution can rescue a misfiled artifact and can
    // NEVER manufacture one, so a genuine absence still fails the check.
    const root = splitFixture();
    const jsPath = resolveNodeArtifactByRef(root, UUID, "absent.json");
    const pyPath = py(
      `from pathlib import Path\n` +
        `from evor.node_identity import resolve_node_artifact_by_ref\n` +
        `print(resolve_node_artifact_by_ref(Path(${JSON.stringify(root)}), ${JSON.stringify(UUID)}, "absent.json") or "")`,
    );
    rmSync(root, { recursive: true, force: true });
    expect(jsPath).toBeNull();
    expect(pyPath).toBe("");
  });

  it("both list the same aliases, uuid first", () => {
    const tree = { nodes: { [UUID]: { id: UUID, name: NAME } } };
    expect(aliasesFromTree(tree, NAME)).toEqual([UUID, NAME]);
    const pyOut = py(
      `from evor.node_identity import aliases_from_tree\n` +
        `import json\n` +
        `print(json.dumps(aliases_from_tree(${JSON.stringify(JSON.stringify(tree))} and json.loads(${JSON.stringify(JSON.stringify(tree))}), ${JSON.stringify(NAME)})))`,
    );
    expect(JSON.parse(pyOut)).toEqual([UUID, NAME]);
  });

  it("an unknown ref has only itself as an alias, in both", () => {
    const tree = { nodes: {} };
    expect(aliasesFromTree(tree, "ghost")).toEqual(["ghost"]);
    const pyOut = py(
      `from evor.node_identity import aliases_from_tree\n` +
        `import json\n` +
        `print(json.dumps(aliases_from_tree({"nodes": {}}, "ghost")))`,
    );
    expect(JSON.parse(pyOut)).toEqual(["ghost"]);
  });

  it("resolveNodeArtifact never second-guesses a direct hit", () => {
    const root = splitFixture();
    const direct = join(root, "nodes", NAME, "telemetry.jsonl");
    const got = resolveNodeArtifact(direct, { id: UUID, name: NAME });
    rmSync(root, { recursive: true, force: true });
    expect(got).toBe(direct);
  });
});

describe("the write side cannot mint a second directory", () => {
  it("canonical_node_id maps either identity to the uuid", () => {
    const root = splitFixture();
    const fromName = py(
      `from pathlib import Path\n` +
        `from evor.node_identity import canonical_node_id\n` +
        `print(canonical_node_id(Path(${JSON.stringify(root)}), ${JSON.stringify(NAME)}))`,
    );
    const fromUuid = py(
      `from pathlib import Path\n` +
        `from evor.node_identity import canonical_node_id\n` +
        `print(canonical_node_id(Path(${JSON.stringify(root)}), ${JSON.stringify(UUID)}))`,
    );
    const unknown = py(
      `from pathlib import Path\n` +
        `from evor.node_identity import canonical_node_id\n` +
        `print(canonical_node_id(Path(${JSON.stringify(root)}), "ghost"))`,
    );
    rmSync(root, { recursive: true, force: true });
    expect(fromName).toBe(UUID);
    expect(fromUuid).toBe(UUID);
    // An unknown ref is the caller's not-found case; inventing an identity for
    // it would be the resolver manufacturing a path.
    expect(unknown).toBe("ghost");
  });
});

describe("telemetryIngest writes one directory per node, whichever key it is given", () => {
  it("a NAME resolves to the uuid directory", async () => {
    const { telemetryIngest } = await import("../src/tools/telemetry.js");
    const { readdirSync, existsSync: exists } = await import("fs");

    const root = mkdtempSync(join(tmpdir(), "evor-ingest-"));
    const runDir = join(root, ".evor", "runs", "m1", "r1");
    mkdirSync(join(runDir, "nodes"), { recursive: true });
    // A SCHEMA-VALID node: readTree validates against TreeFileSchema and throws
    // on a thin one, which tryResolveNodeRef swallows — so a stub fixture would
    // have tested the fallback instead of the resolution.
    writeFileSync(join(runDir, "tree.json"), JSON.stringify({ nodes: { [UUID]: REAL_NODE }, updated_at: "2026-09-14T08:06:35.551Z" }));
    process.env.EVOR_ROOT = join(root, ".evor");

    // Ingest under BOTH identities. Before the fix this produced two directories.
    telemetryIngest("r1", NAME, [{ step: 1, loss: 0.5 } as never], "m1");
    telemetryIngest("r1", UUID, [{ step: 2, loss: 0.4 } as never], "m1");

    const dirs = readdirSync(join(runDir, "nodes")).sort();
    const underUuid = exists(join(runDir, "nodes", UUID, "telemetry.jsonl"));
    rmSync(root, { recursive: true, force: true });
    delete process.env.EVOR_ROOT;

    expect(dirs, "one node must have exactly one directory").toEqual([UUID]);
    expect(underUuid).toBe(true);
  });
});
