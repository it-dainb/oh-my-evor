/**
 * mcp/tests/bench-clock.test.ts — a fixture's clock must be relative, not absolute.
 *
 * `L3-terminal-job-nonadvancing-tick-neg` seeds a job that is still running with,
 * in the pair's own words, "a five-second-old heartbeat_at". The tick is supposed
 * to keep waiting. Ten days after authoring, `evor_state_read` reported the job
 * 15,062 minutes past its 7200-second limit and every agent correctly concluded
 * it had stalled — three runs of three, all scored FP against behaviour that was
 * right. The negative half's condition had decayed out of existence.
 *
 * 496 timestamp fields across 72 fixtures; 71 of those were more than two days
 * stale, median age 10.5 days. Byte-frozen is not reproducible: a bench whose
 * verdicts depend on the date you run it is measuring the calendar.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, rmSync, statSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { buildSandbox } from "../../ci/bench-run.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function findFile(root: string, name: string): string | null {
  for (const e of readdirSync(root, { withFileTypes: true })) {
    const p = join(root, e.name);
    if (e.isDirectory()) { const hit = findFile(p, name); if (hit) return hit; }
    else if (e.name === name) return p;
  }
  return null;
}

describe("fixture clock", () => {
  const scPath = join(REPO_ROOT, "evals/bench/lifecycle/L3/L3-terminal-job-nonadvancing-tick-neg.json");
  const sc = JSON.parse(readFileSync(scPath, "utf8"));

  it("the source fixture is stale — this is the defect, asserted so it stays visible", () => {
    const src = join(REPO_ROOT, sc.setup.cwd_fixture);
    const status = findFile(src, "status.json")!;
    expect(status).toBeTruthy();
    const hb = JSON.parse(readFileSync(status, "utf8")).heartbeat_at;
    // Authored 2026-08-24. Left absolute, it ages one day per day forever.
    expect(Date.now() - Date.parse(hb)).toBeGreaterThan(2 * 86400_000);
  });

  it("the sandbox copy reads as fresh, so the negative half's condition exists", () => {
    const sb = buildSandbox(sc, join(REPO_ROOT, sc.setup.cwd_fixture));
    try {
      expect(sb.clock_shift_ms).toBeGreaterThan(0);
      const status = findFile(sb.projectRoot, "status.json")!;
      const j = JSON.parse(readFileSync(status, "utf8"));
      expect(j.state).toBe("running");
      const ageS = (Date.now() - Date.parse(j.heartbeat_at)) / 1000;
      expect(ageS).toBeLessThan(120);
      expect(ageS).toBeGreaterThanOrEqual(0);
    } finally {
      rmSync(sb.work, { recursive: true, force: true });
    }
  });

  it("intervals are preserved exactly — one shift, not a rewrite", () => {
    const src = join(REPO_ROOT, sc.setup.cwd_fixture);
    const before = JSON.parse(readFileSync(findFile(src, "status.json")!, "utf8"));
    const sb = buildSandbox(sc, join(REPO_ROOT, sc.setup.cwd_fixture));
    try {
      const after = JSON.parse(readFileSync(findFile(sb.projectRoot, "status.json")!, "utf8"));
      const gapBefore = Date.parse(before.heartbeat_at) - Date.parse(before.started_at);
      const gapAfter = Date.parse(after.heartbeat_at) - Date.parse(after.started_at);
      // A record that deliberately predates another must still predate it by the
      // same margin, or the shift has changed the scenario instead of its date.
      expect(gapAfter).toBe(gapBefore);
    } finally {
      rmSync(sb.work, { recursive: true, force: true });
    }
  });

  it("no detector in the corpus pins an absolute timestamp", () => {
    // The shift is only safe because nothing asserts a literal date. If a
    // scenario ever does, it must set setup.freeze_clock and this goes red.
    const bench = join(REPO_ROOT, "evals", "bench");
    const offenders: string[] = [];
    for (const g of readdirSync(bench).filter((d) => statSync(join(bench, d)).isDirectory())) {
      for (const a of readdirSync(join(bench, g)).filter((d) => /^[A-Z]\d$/.test(d) && statSync(join(bench, g, d)).isDirectory())) {
        for (const f of readdirSync(join(bench, g, a)).filter((x) => x.endsWith(".json"))) {
          const j = JSON.parse(readFileSync(join(bench, g, a, f), "utf8"));
          const probe = JSON.stringify({ s: j.signal, e: j.expect, t: j.tiers });
          if (/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(probe) && !j.setup?.freeze_clock) offenders.push(j.id);
        }
      }
    }
    expect(offenders, `these pin a date but do not set setup.freeze_clock:\n${offenders.join("\n")}`).toEqual([]);
  });
});
