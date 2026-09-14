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

/** Every scenario JSON in the corpus, angle directories only. */
function scenarioFiles(): string[] {
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
  return files;
}

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

  // ── What the pilot's own logs exposed ──────────────────────────────────────
  //
  // Two of these are corpus gates for defects the RUNNER committed, kept here
  // because the corpus is the thing a future author edits. The runner-side
  // fixes are in `ci/bench-run.mjs`; these stop the corpus drifting back into a
  // shape that hides them.

  it("no scenario shows the model a placeholder it cannot bind", () => {
    // 48 of 170 scenarios carried `{{ASK}}`, `{{FIELD}}`, `{{TARGET}}` and
    // friends in `prompt` or `follow_ups`. The runner bound templates for
    // detectors only, so the model was handed the literal braces — and in
    // `A3-hypothesis-verdict-pos` it said so, refused to guess, and was scored
    // FN for it. `bindTemplates` now throws; this keeps the corpus bindable.
    const unbound: string[] = [];
    for (const p of scenarioFiles()) {
      const d = JSON.parse(readFileSync(p, "utf8"));
      const bound = new Set([
        "SANDBOX",
        "FIXTURE",
        ...Object.keys(d.setup?.templates ?? {}),
        ...Object.keys(d.setup?.substitutions ?? {}),
      ]);
      const texts: string[] = [
        String(d.prompt ?? ""),
        ...(d.setup?.follow_ups ?? []).map((f: any) => String(typeof f === "string" ? f : f?.prompt ?? "")),
      ];
      for (const t of texts) {
        for (const m of t.matchAll(/\{\{(\w+)\}\}/g)) {
          if (!bound.has(m[1])) unbound.push(`${d.id}: {{${m[1]}}}`);
        }
      }
    }
    expect(unbound, `placeholders with no binding:\n${unbound.join("\n")}`).toEqual([]);
  });

  it("every setup path resolves from the repo root", () => {
    // `cwd_fixture`, `mcp_config` and `plugin_fixture` are resolved against the
    // REPO by the runner and were written group-relative by the evidence
    // generator. Six scenarios pointed at `fixtures/E4/...` at the repo root
    // and preflighted 0/6. It was fixed by hand in the generated JSON once and
    // the generator reverted it — the same shape as the model-arm revert.
    const missing: string[] = [];
    for (const p of scenarioFiles()) {
      const d = JSON.parse(readFileSync(p, "utf8"));
      for (const k of ["cwd_fixture", "mcp_config", "plugin_fixture"]) {
        const v = d.setup?.[k];
        if (typeof v === "string" && !existsSync(join(REPO_ROOT, v))) missing.push(`${d.id}: ${k}=${v}`);
      }
    }
    expect(missing, `setup paths that do not resolve:\n${missing.join("\n")}`).toEqual([]);
  });

  it("every fail rule maps to a kind — the direction that governs attribution", () => {
    // The existing check runs map -> rule and catches a kind nothing can reach.
    // This runs rule -> map and catches the opposite: a detector that CAN fire
    // and produces `failure_kind: null`, which is how T2-artifact-slot reported
    // a wrong argument without naming which one. `scoreTiers` returns the fired
    // detector's mapped kind, so an unmapped rule is a verdict with no cause.
    const unmapped: string[] = [];
    for (const p of scenarioFiles()) {
      const d = JSON.parse(readFileSync(p, "utf8"));
      if (!d.tiers) continue;
      const map = d.tiers.fail_kind_map ?? {};
      for (const r of d.tiers.fail ?? []) {
        if (r?.id && !(r.id in map)) unmapped.push(`${d.id}: fail rule "${r.id}" has no kind`);
      }
      const pid = d.tiers.partial?.id;
      if (pid && !(pid in map)) unmapped.push(`${d.id}: partial rule "${pid}" has no kind`);
    }
    expect(unmapped, `rules that fire with no attributable kind:\n${unmapped.join("\n")}`).toEqual([]);
  });

  it("every fail_kind_map key names a rule that exists", () => {
    // 46 of 170 tier/hybrid scenarios mapped failure kinds — `wrong-store-queried`,
    // `treated-success-as-failure`, `no-delegation` — onto rule ids nothing
    // declares. Every FAIL in those scenarios therefore came back with no
    // attributable kind, which is why the pilot could say a run failed and not
    // say why. An unreachable kind is a rule the author meant to write.
    const orphans: string[] = [];
    for (const p of scenarioFiles()) {
      const d = JSON.parse(readFileSync(p, "utf8"));
      if (!d.tiers) continue;
      const ids = new Set<string>();
      for (const k of ["pass", "partial"]) if (d.tiers[k]?.id) ids.add(d.tiers[k].id);
      for (const r of d.tiers.fail ?? []) if (r?.id) ids.add(r.id);
      for (const k of Object.keys(d.tiers.fail_kind_map ?? {})) {
        if (!ids.has(k)) orphans.push(`${d.id}: fail_kind_map["${k}"] matches no rule id`);
      }
    }
    expect(orphans, `unreachable failure kinds:\n${orphans.join("\n")}`).toEqual([]);
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
