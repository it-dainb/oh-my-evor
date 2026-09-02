/**
 * mcp/tests/bench-scenarios.test.ts — evor-eval-bench's offline gates, in `npm test`.
 *
 * §7 of `docs/evor-eval-bench/00-preflight-taxonomy.md` puts "land the gates"
 * FIRST, before authoring. That order was not followed: four authors wrote 170
 * scenarios, each built their own gate script, and nobody ran them together.
 * They all pass — but a gate that lives in an author's directory and is invoked
 * by hand is not a gate, it is a script someone remembered to run. This wires
 * them into the suite so a scenario cannot rot without the build going red.
 *
 * These are the OFFLINE gates only. They need no model and no API key: schema
 * conformance, detector fixtures, degenerate-strategy floors, freeze integrity.
 * The trace grader and the stub tool server do not exist yet, so the PARTIAL
 * floor on tier angles and every live measurement remain unrun — see the skip
 * block at the end, which asserts that absence rather than passing over it.
 */
import { describe, it, expect } from "vitest";
import { execFileSync } from "child_process";
import { existsSync, readFileSync, readdirSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const BENCH = join(REPO_ROOT, "evals", "bench");

const run = (rel: string) => {
  try {
    return { ok: true, out: execFileSync("node", [rel], { cwd: REPO_ROOT, encoding: "utf8", timeout: 180_000 }) };
  } catch (e: any) {
    return { ok: false, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
};

// Every author's own gate, run as the author wrote it. Reimplementing them here
// would create a second opinion that can drift from the one the author tested.
const GATES = [
  "evals/bench/authority/lint.mjs",
  "evals/bench/authority/detectors/run-fixtures.mjs",
  "evals/bench/tool/detectors/run-fixtures.mjs",
  "evals/bench/lifecycle/verify.mjs",
  "evals/bench/lifecycle/detectors/check-detectors.mjs",
];

describe("evor-eval-bench — offline gates", () => {
  it.each(GATES)("%s exits clean", (rel) => {
    expect(existsSync(join(REPO_ROOT, rel)), `${rel} is missing`).toBe(true);
    const r = run(rel);
    expect(r.ok, `${rel} failed:\n${r.out.slice(-1500)}`).toBe(true);
  });

  it("the freeze manifest matches the corpus on disk", () => {
    // execFileSync throws on a non-zero exit, which is the assertion: --check
    // exits 1 on DRIFT or UNFROZEN. Both were verified by mutation before this
    // test was written — an edited scenario and a smuggled-in one each fail it.
    const out = execFileSync("node", ["ci/bench-freeze.mjs", "--check"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    });
    expect(out).toMatch(/all match/);
  });

  it("every scenario declares exactly one angle, and every pair has both halves", () => {
    const files: string[] = [];
    for (const group of readdirSync(BENCH, { withFileTypes: true }).filter((d) => d.isDirectory())) {
      const gdir = join(BENCH, group.name);
      for (const angle of readdirSync(gdir, { withFileTypes: true }).filter((d) => d.isDirectory())) {
        if (!/^[A-Z]\d$/.test(angle.name)) continue;
        for (const f of readdirSync(join(gdir, angle.name))) {
          if (f.endsWith(".json")) files.push(join(gdir, angle.name, f));
        }
      }
    }
    expect(files.length, "no scenarios found — did the corpus move?").toBeGreaterThan(100);

    const orphans: string[] = [];
    for (const p of files) {
      const d = JSON.parse(readFileSync(p, "utf8"));
      expect(typeof d.angle, `${p} declares no angle`).toBe("string");
      // Trap 6.6: one angle per scenario, so a roll-up cannot sum one episode
      // many times across co-firing signals.
      for (const [a, b] of [
        ["-pos.json", "-neg.json"],
        ["-target.json", "-control.json"],
      ]) {
        if (p.endsWith(a) && !existsSync(p.slice(0, -a.length) + b)) orphans.push(p);
      }
    }
    expect(orphans, `scenarios with no sibling:\n${orphans.join("\n")}`).toEqual([]);
  });
});

describe("evor-eval-bench — what is NOT yet gated", () => {
  // Asserting the gap rather than leaving it implicit. If someone builds the
  // trace grader or the stub server, these fail and force the gates to catch up
  // — the opposite of a silent TODO.
  it("the tier PARTIAL floor is still owed, because the trace grader does not exist", () => {
    const note = readFileSync(join(BENCH, "authority", "AUTHORING-NOTE-B.md"), "utf8");
    expect(note).toMatch(/PARTIAL floor/i);
    expect(
      existsSync(join(REPO_ROOT, "ci", "bench-trace-grade.mjs")),
      "a trace grader now exists — wire the PARTIAL floor in and delete this test",
    ).toBe(false);
  });

  it("no scenario has been executed, so no result may be quoted", () => {
    expect(
      existsSync(join(REPO_ROOT, "ci", "out", "bench-81")),
      "bench results exist — this suite must gain a results-integrity gate before they are cited",
    ).toBe(false);
  });
});
