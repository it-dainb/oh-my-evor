/**
 * mcp/tests/agent-frontmatter.test.ts — Phase 1 (RALPLAN-DR REV 5)
 *
 * Phase 1 is "structural enforcement over prose" (P2) applied to the agent
 * roster. Three defects it pins:
 *
 *   1.5 `level:` is an invented key. Claude Code's agent frontmatter schema has
 *       no such field, so it is inert — while reading as though depth were being
 *       enforced. The real parent enforcement is the PARENT map in
 *       `hooks/pre-tool-use.mjs`.
 *   1.2 No agent set `maxTurns`. Cost is O(rate x turns^2) and `evor-forge` ran
 *       160 unbounded turns in run 29d17abc; the cap is the dominant cost lever.
 *   1.4 `effort` must be declared per role and fixed at spawn — changing it
 *       mid-session invalidates the prompt cache and forces a full prefix
 *       recompute. Haiku does not support `effort` at all, so declaring it there
 *       would be another inert key.
 *
 * The caps below are Phase 1 provisional values. PM1 (Forge cap thrashing) and
 * 3b.4 (evor-tick re-derivation) both revise them from measurement — a change
 * here is expected to come with a measurement, not a guess.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "fs";
import { join, dirname, resolve } from "path";
import { fileURLToPath } from "url";

const AGENTS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../agents");

/**
 * Per-role turn caps (plan §S3).
 *
 * The first set of caps was chosen to bound cost. Measured against a real 3-tick
 * run, they did the opposite: agents hit the cap MID-TASK and the orchestrator
 * resumed them, so the run paid for the same orientation twice. Every over-cap
 * agent was exactly `cap + a resume`:
 *
 *   forge 50 = 25+25   tick 87 = 60+27   forge-junior 28 = 20+8
 *   sage  22 = 16+6    critic 17 = 10+7  sage-junior  16 =  8+8
 *
 * Transcript: "Forge stopped mid-review. Resuming it to finish and write its
 * artifact." A resume re-primes the whole prefix as cache_creation, billed at
 * 1.25x input — strictly worse than having let the agent finish.
 *
 * So these are set to the observed cap+resume totals: the work each role actually
 * needs. A cap is a runaway backstop, not a budget. PM1 says raising a cap can let
 * a runaway run longer; the near-cap warning in subagent-stop.mjs is the detector.
 */
const EXPECTED_MAX_TURNS: Record<string, number> = {
  "evor-tick": 90,
  "evor-forge": 45,
  "evor-forge-junior": 28,
  "evor-sage": 22,
  "evor-mutagen": 14,
  "evor-probe": 14,
  "evor-selector": 12,
  "evor-forge-critic": 16,
  "evor-forge-architect": 10,
  "evor-forge-analyst": 10,
  "evor-sage-junior": 16,
  "evor-acquirer": 15,
};

function parseFrontmatter(file: string): Record<string, string> {
  const src = readFileSync(join(AGENTS_DIR, file), "utf8");
  const m = src.match(/^---\n([\s\S]*?)\n---/);
  if (!m) throw new Error(`${file}: no frontmatter block`);
  const out: Record<string, string> = {};
  for (const line of m[1].split("\n")) {
    const kv = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (kv) out[kv[1]] = kv[2].trim();
  }
  return out;
}

const AGENT_FILES = readdirSync(AGENTS_DIR).filter((f) => f.endsWith(".md")).sort();

describe("agent frontmatter", () => {
  it("covers every agent file in the roster", () => {
    expect(AGENT_FILES.map((f) => f.replace(/\.md$/, "")).sort())
      .toEqual(Object.keys(EXPECTED_MAX_TURNS).sort());
  });

  for (const file of AGENT_FILES) {
    const agent = file.replace(/\.md$/, "");

    describe(agent, () => {
      const fm = parseFrontmatter(file);

      it("declares no invented `level:` key", () => {
        expect(fm.level, "`level:` is not in the agent schema — it is inert").toBeUndefined();
      });

      it("declares an explicit model", () => {
        expect(["opus", "sonnet", "haiku"]).toContain(fm.model);
      });

      it(`caps turns at ${EXPECTED_MAX_TURNS[agent]}`, () => {
        expect(Number(fm.maxTurns)).toBe(EXPECTED_MAX_TURNS[agent]);
      });

      // Reviewers exist to produce a verdict on someone else's work. A reviewer
      // that can edit the artifact it is judging can make its own verdict true —
      // which is the self-approval failure P3 exists to prevent (sage-t1 emitted
      // `finding:"test", quorum_met:true` and no one caught it).
      if (/^evor-(forge-(critic|architect|analyst)|sage|probe|selector|sage-junior)$/.test(agent)) {
        it("denies Write/Edit — it reviews, it does not author", () => {
          const denied = (fm.disallowedTools ?? "").split(",").map((s) => s.trim());
          expect(denied).toContain("Write");
          expect(denied).toContain("Edit");
        });
      }

      it("declares `effort` iff the model supports it", () => {
        if (fm.model === "haiku") {
          expect(fm.effort, "haiku does not support effort — declaring it is inert").toBeUndefined();
        } else {
          expect(["low", "medium", "high"]).toContain(fm.effort);
        }
      });
    });
  }
});

describe("skills and agent docs", () => {
  it("no `level:` survives anywhere under agents/ or skills/", () => {
    const offenders: string[] = [];
    const scan = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) scan(p);
        else if (e.name.endsWith(".md")) {
          const fmBlock = readFileSync(p, "utf8").match(/^---\n([\s\S]*?)\n---/);
          if (fmBlock && /^level:/m.test(fmBlock[1])) offenders.push(p);
        }
      }
    };
    scan(AGENTS_DIR);
    scan(resolve(dirname(fileURLToPath(import.meta.url)), "../../skills"));
    expect(offenders).toEqual([]);
  });
});

describe("plugin manifest registration", () => {
  // An agent file that exists but is not listed in .claude-plugin/plugin.json is
  // never loaded by Claude Code — it looks shipped and does nothing. This is the
  // same silent-inertness class as the `level:` key and the un-propagated
  // EVOR_ACTIVE_RUN_ID: present in the repo, absent at runtime.
  const manifest = JSON.parse(
    readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../../.claude-plugin/plugin.json"), "utf8"),
  ) as { agents?: string[] };

  it("registers every agent file, and lists no agent that does not exist", () => {
    const onDisk = AGENT_FILES.map((f) => `./agents/${f}`).sort();
    const declared = [...(manifest.agents ?? [])].sort();
    expect(declared).toEqual(onDisk);
  });
});
