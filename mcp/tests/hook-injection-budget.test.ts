/**
 * mcp/tests/hook-injection-budget.test.ts — C5 Stage 7.3
 *
 * Hooks inject text into the model's context on every fire. Measured at ~11.8 KB
 * per tick once the enforcement layer actually ran — correct, not a regression,
 * since the old 734 tokens/run reflected an INERT governor. But an injection with
 * no upper bound is a different problem: it is unbounded context growth driven by
 * data volume rather than by design.
 *
 * `pre-compact.mjs` already enforces this discipline (RESTORE_LIMIT = 500 chars,
 * explicitly, with a comment). `session-start.mjs` appended wiki lesson output
 * with no cap at all — `--limit 5` bounds the NUMBER of lessons, never their
 * size, so five long lessons inject arbitrarily much. The asymmetry is the bug:
 * one path was budgeted and the other was not.
 *
 * This matters most for exactly the missions this plan targets. A 100-200 tick
 * run accumulates wiki lessons; an uncapped injection therefore grows with
 * mission age, which is the same compounding shape as the tree-read leak.
 */

import { describe, it, expect } from "vitest";
import { spawnSync } from "child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "fs";
import { join, dirname, resolve } from "path";
import { fileURLToPath } from "url";
import { tmpdir } from "os";

const HOOKS = resolve(dirname(fileURLToPath(import.meta.url)), "../../hooks");

/** Run session-start with a stub `evor.wiki` that emits a very large payload. */
function runWithHugeWiki(lessonBytes: number) {
  const dir = mkdtempSync(join(tmpdir(), "evor-inject-"));
  try {
    const evorRoot = join(dir, ".evor");
    mkdirSync(join(evorRoot, "runs", "m1", "r1"), { recursive: true });
    writeFileSync(
      join(evorRoot, "active-run.json"),
      JSON.stringify({ run_id: "r1", mission_id: "m1" }),
    );
    writeFileSync(join(evorRoot, "runs", "m1", "r1", "run-state.json"), JSON.stringify({ tick_count: 1 }));
    // Skip the environment probes so the hook reaches the wiki injection.
    writeFileSync(join(evorRoot, ".deps-ok"), "cached");
    writeFileSync(join(evorRoot, ".uv-ok"), "cached");

    // A fake `python3` that ignores its args and prints a huge wiki payload.
    const fakePy = join(dir, "python3");
    writeFileSync(
      fakePy,
      `#!/usr/bin/env node\nprocess.stdout.write("L".repeat(${lessonBytes}));\n`,
      { mode: 0o755 },
    );

    const r = spawnSync(process.execPath, [join(HOOKS, "session-start.mjs")], {
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        EVOR_ROOT: evorRoot,
        EVOR_MISSION_ID: "m1",
        EVOR_PYTHON: fakePy,
      },
      encoding: "utf8",
      timeout: 15_000,
    });
    return (r.stdout ?? "") + (r.stderr ?? "");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("session-start wiki injection is budgeted", () => {
  it("does not inject an unbounded wiki payload", () => {
    const HUGE = 40_000;
    const out = runWithHugeWiki(HUGE);
    const injected = (out.match(/L{50,}/g) ?? []).reduce((n, s) => Math.max(n, s.length), 0);
    expect(
      injected,
      `injected ${injected} chars of wiki output — pre-compact.mjs caps its restore block at 500, ` +
        `this path had no cap at all, so injection grows with mission age`,
    ).toBeLessThan(HUGE);
  });

  it("keeps the injection within a stated budget", () => {
    const out = runWithHugeWiki(40_000);
    const injected = (out.match(/L{50,}/g) ?? []).reduce((n, s) => Math.max(n, s.length), 0);
    // Generous but finite: enough for several real lessons, bounded by design.
    expect(injected).toBeLessThanOrEqual(2_000);
  });

  it("says it truncated rather than silently dropping content", () => {
    const out = runWithHugeWiki(40_000);
    // A silent truncation looks identical to "there were no more lessons" —
    // the reader cannot tell signal from budget. Fail loud (P5).
    expect(out).toMatch(/truncat/i);
  });
});
