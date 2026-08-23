/**
 * mcp/tests/runtime-limits.test.ts — Phase 6 / nesting prerequisites
 *
 * The subagent spawn-depth default has flipped twice in released Claude Code:
 * nested spawning shipped in 2.1.172, 2.1.217 turned it OFF (default 1), and
 * 2.1.219 turned it back on at 3. `evor-tick` (Phase 3a) puts the tick loop at
 * depth 1 and its leads at depth 2, so a silent flip back to 1 would not error —
 * it would make every lead spawn fail at runtime, mid-mission.
 *
 * Inheriting a default that has already moved twice is exactly the "rule that
 * exists only as an assumption" P2 rejects. Both the checked-in settings and the
 * CI images must state the limits outright.
 *
 * Verified against the binaries on this host:
 *   2.1.212 — MAX_SUBAGENT_SPAWN_DEPTH absent, MAX_CONCURRENT_SUBAGENTS absent,
 *             MAX_SUBAGENTS_PER_SESSION present
 *   2.1.220 — all three present
 * (An earlier plan revision said 2.1.212 contained none of the three; the
 * per-session cap is in fact present there.)
 */

import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "fs";
import { join, dirname, resolve } from "path";
import { fileURLToPath } from "url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** Minimum CLI that supports all three env vars (2.1.219 restored depth). */
const MIN_CLI = [2, 1, 220] as const;

function parseVersion(v: string): number[] {
  return v.split(".").map(Number);
}

function atLeast(actual: string, min: readonly number[]): boolean {
  const a = parseVersion(actual);
  for (let i = 0; i < min.length; i++) {
    if ((a[i] ?? 0) > min[i]) return true;
    if ((a[i] ?? 0) < min[i]) return false;
  }
  return true;
}

const DOCKERFILES = ["ci/docker/Dockerfile", "ci/docker/Dockerfile.ml"];

describe("CI images — pinned CLI", () => {
  for (const file of DOCKERFILES) {
    it(`${file} pins a CLI new enough to honour the spawn-depth vars`, () => {
      const src = readFileSync(join(REPO, file), "utf8");
      const m = src.match(/@anthropic-ai\/claude-code@(\d+\.\d+\.\d+)/);
      expect(m, "the CLI must be pinned, never floating").toBeTruthy();
      expect(
        atLeast(m![1], MIN_CLI),
        `${file} pins ${m![1]}; ${MIN_CLI.join(".")}+ is required for CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH`,
      ).toBe(true);
    });
  }

  it("pins both images to the same CLI — drift makes E2E results unattributable", () => {
    const versions = DOCKERFILES.map((f) => {
      const m = readFileSync(join(REPO, f), "utf8").match(/@anthropic-ai\/claude-code@(\d+\.\d+\.\d+)/);
      return m?.[1];
    });
    expect(new Set(versions).size).toBe(1);
  });

  it("pins the agent SDK too", () => {
    const src = readFileSync(join(REPO, "ci/docker/Dockerfile.ml"), "utf8");
    expect(src).toMatch(/@anthropic-ai\/claude-agent-sdk@\d+\.\d+\.\d+/);
  });
});

describe("runtime limits are declared, not inherited", () => {
  const REQUIRED = [
    "CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH",
    "CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS",
    "CLAUDE_CODE_MAX_SUBAGENTS_PER_SESSION",
  ];

  it("settings.json declares every limit the run depends on", () => {
    const p = join(REPO, ".claude", "settings.json");
    expect(existsSync(p), ".claude/settings.json must be checked in").toBe(true);
    const env = JSON.parse(readFileSync(p, "utf8")).env ?? {};
    for (const key of REQUIRED) {
      expect(env[key], `${key} must be stated explicitly`).toBeDefined();
    }
  });

  it("declares a spawn depth deep enough for evor-tick's tree", () => {
    const env = JSON.parse(readFileSync(join(REPO, ".claude", "settings.json"), "utf8")).env ?? {};
    // depth 0 main -> 1 evor-tick -> 2 leads -> 3 juniors. 3 is the minimum that
    // lets forge-junior/sage-junior spawn at all; the ceiling is 5.
    const depth = Number(env.CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH);
    expect(depth).toBeGreaterThanOrEqual(3);
    expect(depth).toBeLessThanOrEqual(5);
  });

  it("raises the per-session spawn cap above the 200 default", () => {
    const env = JSON.parse(readFileSync(join(REPO, ".claude", "settings.json"), "utf8")).env ?? {};
    // ~7-9 spawns/tick over 100-200 ticks is 700-1800; the 200 default binds
    // around tick 20-22, which is well inside the target run length.
    expect(Number(env.CLAUDE_CODE_MAX_SUBAGENTS_PER_SESSION)).toBeGreaterThan(200);
  });

  for (const file of DOCKERFILES) {
    it(`${file} declares the same limits`, () => {
      const src = readFileSync(join(REPO, file), "utf8");
      for (const key of REQUIRED) {
        expect(src, `${file} must ENV ${key}`).toContain(key);
      }
    });
  }

  it("settings and images agree on every limit", () => {
    const env = JSON.parse(readFileSync(join(REPO, ".claude", "settings.json"), "utf8")).env ?? {};
    for (const file of DOCKERFILES) {
      const src = readFileSync(join(REPO, file), "utf8");
      for (const key of REQUIRED) {
        const m = src.match(new RegExp(`${key}=(\\S+)`));
        expect(m, `${file} missing a value for ${key}`).toBeTruthy();
        expect(m![1], `${file}: ${key} disagrees with .claude/settings.json`).toBe(String(env[key]));
      }
    }
  });
});
