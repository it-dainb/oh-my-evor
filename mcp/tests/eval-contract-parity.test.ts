/**
 * mcp/tests/eval-contract-parity.test.ts
 *
 * `harness/evor/eval_contract.py` OWNS what files constitute "the evaluator".
 * `evor_seal_eval_script` mirrors that rule in TypeScript so the seal does not
 * need a Python subprocess on its hot path.
 *
 * A mirror is only safe with a test that crosses to the owner. Without one this
 * is just a second independent opinion about the same fact — which is precisely
 * the defect the eval contract exists to remove: four sites each asserted their
 * own belief about the evaluator's interface, and all four disagreed, because
 * nothing ever compared them.
 *
 * So: build one fixture, digest it with both implementations, and require the
 * hashes to be identical.
 */

import { describe, it, expect } from "vitest";
import { spawnSync } from "child_process";
import { createHash } from "crypto";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { basename, join, dirname, resolve } from "path";
import { fileURLToPath } from "url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** The TS mirror, character-for-character as `compute.ts` implements it. */
function digestEvaluator(runDir: string, evalVersion: string) {
  const base = join(runDir, "eval-suites");
  const candidates = [join(base, `${evalVersion}.py`), join(base, "score_plugin.py")];
  const files: Record<string, string> = {};
  const acc = createHash("sha256");
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    const digest = createHash("sha256").update(readFileSync(path)).digest("hex");
    files[basename(path)] = digest;
    acc.update(basename(path));
    acc.update(Buffer.from([0]));
    acc.update(digest);
    acc.update("\n");
  }
  return { hash: acc.digest("hex"), files };
}

/** The owner's answer, via its CLI. */
function pythonDigest(runDir: string, evalVersion: string) {
  const r = spawnSync("python3", [
    "-m", "evor.eval_contract", "digest", "--run-dir", runDir, "--eval-version", evalVersion,
  ], {
    encoding: "utf8",
    cwd: REPO,
    env: { ...process.env, PYTHONPATH: join(REPO, "harness") },
  });
  if (r.status !== 0) return { unavailable: true, stderr: r.stderr } as const;
  return JSON.parse(r.stdout) as { ok: boolean; hash?: string; files?: Record<string, string> };
}

function fixture(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), "evor-parity-"));
  mkdirSync(join(root, "eval-suites"), { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(join(root, "eval-suites", name), body);
  }
  return root;
}

describe("the seal's TS mirror agrees with the contract that owns the rule", () => {
  const cases: Array<[string, Record<string, string>]> = [
    ["harness only", { "v1.py": "print('a')\n" }],
    ["harness + score_plugin", { "v1.py": "print('a')\n", "score_plugin.py": "def score(): ...\n" }],
    ["score_plugin only", { "score_plugin.py": "def score(): ...\n" }],
    ["an unrelated file is not part of the evaluator", {
      "v1.py": "print('a')\n", "notes.md": "ignore me\n",
    }],
  ];

  for (const [name, files] of cases) {
    it(name, () => {
      const root = fixture(files);
      const py = pythonDigest(root, "v1");
      const ts = digestEvaluator(root, "v1");
      rmSync(root, { recursive: true, force: true });

      if ("unavailable" in py) {
        expect.fail(`the contract owner could not be reached: ${py.stderr}`);
      }
      if (!py.ok) {
        // No evaluator at all — both sides must agree there is nothing to seal.
        expect(Object.keys(ts.files)).toHaveLength(0);
        return;
      }
      expect(ts.hash, "TS mirror diverged from evor.eval_contract").toBe(py.hash);
      expect(ts.files).toEqual(py.files);
    });
  }

  it("changing the score_plugin changes the digest", () => {
    // The property the old single-file seal did not have.
    const a = fixture({ "v1.py": "print('a')\n", "score_plugin.py": "def score(): return 0.1\n" });
    const b = fixture({ "v1.py": "print('a')\n", "score_plugin.py": "def score(): return 0.9\n" });
    const da = digestEvaluator(a, "v1");
    const db = digestEvaluator(b, "v1");
    const pa = pythonDigest(a, "v1");
    const pb = pythonDigest(b, "v1");
    rmSync(a, { recursive: true, force: true });
    rmSync(b, { recursive: true, force: true });
    expect(da.hash).not.toBe(db.hash);
    if (!("unavailable" in pa) && !("unavailable" in pb)) {
      expect(pa.hash).not.toBe(pb.hash);
    }
  });
});
