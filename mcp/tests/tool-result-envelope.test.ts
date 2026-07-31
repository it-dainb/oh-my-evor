/**
 * mcp/tests/tool-result-envelope.test.ts — C5 Stage 1 (correctness, not style)
 *
 * Every evor_* tool must answer in ONE shape:
 *   success -> { ok: true,  ... }
 *   failure -> { ok: false, error: string }
 *
 * Today three incompatible shapes coexist, and the inconsistency has already
 * caused real harm twice:
 *
 *   1. A stub artifact (`finding:"test", quorum_met:true`) cleared a review gate
 *      in run 29d17abc, because `ok:true` from evor_read_artifact means only
 *      "some JSON was read", never "this payload is trustworthy".
 *   2. `scripts/bench-seed-mission.mjs` checked `ok === false`, received a bare
 *      `{error}` from a genuinely failed evor_seal_eval_script, printed a tick,
 *      and proceeded to a lock_mission that then failed on a missing anchor.
 *
 * Root cause is structural: `ok()`/`err()` live at compute.ts:32,36 and are NOT
 * exported, so all 16 other tool files invented their own shape. The fix is a
 * shared module, which turns 14 scattered judgement calls into one import.
 *
 * These tests read the ACTUAL source, so they cannot pass by accident.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, existsSync } from "fs";
import { join, dirname, resolve } from "path";
import { fileURLToPath } from "url";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "../src");
const TOOLS = join(SRC, "tools");
const toolFiles = readdirSync(TOOLS).filter((f) => f.endsWith(".ts")).sort();

describe("shared tool-result module", () => {
  it("exists and exports both helpers", () => {
    const p = join(SRC, "tool-result.ts");
    expect(existsSync(p), "mcp/src/tool-result.ts must exist — one envelope, one definition").toBe(true);
    const src = readFileSync(p, "utf8");
    expect(src).toMatch(/export function ok\b|export const ok\b/);
    expect(src).toMatch(/export function err\b|export const err\b/);
  });

  it("err() emits ok:false, not a bare error object", () => {
    const src = readFileSync(join(SRC, "tool-result.ts"), "utf8");
    // The precise defect: `{ error: msg }` with no ok field reads as success to
    // any caller testing `ok === false`.
    const errBody = src.slice(src.search(/export (function|const) err\b/));
    expect(errBody).toMatch(/ok:\s*false/);
  });
});

describe("no tool file emits a bare {error} envelope", () => {
  for (const file of toolFiles) {
    it(`${file}`, () => {
      const src = readFileSync(join(TOOLS, file), "utf8");
      // Strip comments so documentation of the old shape does not trip this.
      const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      const offenders = [...code.matchAll(/\{\s*error:\s*[^}]*\}/g)]
        .map((m) => m[0])
        .filter((s) => !/ok:\s*false/.test(s));
      expect(
        offenders,
        `bare {error} without ok:false — a caller checking \`ok === false\` reads this as SUCCESS`,
      ).toEqual([]);
    });
  }
});

describe("no tool returns raw unwrapped data on success", () => {
  it("record.ts does not stringify result.data directly", () => {
    const src = readFileSync(join(TOOLS, "record.ts"), "utf8");
    // evor_read_result: success returned raw result.data (no ok), failure returned
    // {error} (no ok:false) — so NEITHER `ok===true` nor `ok===false` worked.
    expect(src).not.toMatch(/JSON\.stringify\(result\.data\)/);
  });
});

describe("evor_store_blob returns the handle it computes", () => {
  it("includes content_ref in its success response", () => {
    const src = readFileSync(join(TOOLS, "gotcha.ts"), "utf8");
    // storeBlob() computes a real sha256 content_ref and the handler dropped it,
    // echoing back the input acquisition_id instead. With acquisition_id omitted
    // the whole response was {ok:true, acquisition_id:null} — the tool's entire
    // output silently discarded. This is content-addressing, so it is
    // integrity-adjacent rather than cosmetic.
    const handler = src.slice(src.indexOf("evor_store_blob"));
    expect(handler).toMatch(/content_ref/);
  });
});

describe("evor_read_artifact declares whether it validated the payload", () => {
  it("returns an explicit `validated` field", () => {
    const src = readFileSync(join(TOOLS, "artifact.ts"), "utf8");
    // Pydantic contract coverage spans only mutagen/sage/sage-junior/acquirer;
    // selector, probe, forge and the three forge reviewers pass through as plain
    // JSON with no write-time validation at all. `ok:true` must therefore stop
    // implying "safe to trust" uniformly across all agent kinds.
    // Assert the RESPONSE carries it — a mention in the tool description would
    // otherwise satisfy a naive grep while the payload stayed unlabelled.
    expect(src).toMatch(/validated:\s*CONTRACT_VALIDATED_AGENTS\.has\(/);
    expect(src).toMatch(/const CONTRACT_VALIDATED_AGENTS\s*=\s*new Set/);
  });
});
