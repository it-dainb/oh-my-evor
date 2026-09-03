/**
 * mcp/tests/bench-passable.test.ts — §4.5's nothing-can-pass floor, across scenarios.
 *
 * `expect.forbidden` with no `matcher` means the PATH must be ABSENT —
 * `bench-detect.mjs` defaults it to `{present: true}`. That is the intended
 * reading for most of the 123 such entries: the agent must not write the field
 * at all.
 *
 * It is fatal when the path is one the role's contract REQUIRES.
 * `L4-first-job-failed-second-succeeded-neg` forbade `$.outcome` outright, and
 * `outcome` is mandatory in every evor-tick return. No well-formed answer could
 * pass it, and none did: three of three FP against behaviour that was correct,
 * with the agent returning an accurate `{"outcome": "scored"}`. The author's own
 * reason says what was meant — "FAILED is underivable" — a value, not the field.
 *
 * A single scenario cannot reveal this: L4's own detector is a trace rule and
 * never mentions `$.outcome`. The corpus can. If any scenario for a role asserts
 * a path must be present or equal something, that path is part of the role's
 * contract, and forbidding its mere presence elsewhere is a scenario that cannot
 * be passed.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function scenarios(): any[] {
  const out: any[] = [];
  const bench = join(REPO_ROOT, "evals", "bench");
  for (const g of readdirSync(bench).filter((d) => statSync(join(bench, d)).isDirectory())) {
    for (const a of readdirSync(join(bench, g)).filter((d) => /^[A-Z]\d$/.test(d) && statSync(join(bench, g, d)).isDirectory())) {
      for (const f of readdirSync(join(bench, g, a)).filter((x) => x.endsWith(".json"))) {
        out.push(JSON.parse(readFileSync(join(bench, g, a, f), "utf8")));
      }
    }
  }
  return out;
}

/** Paths a scenario's own detectors assert must exist, or hold a given value. */
function requiredPaths(j: any): Set<string> {
  const need = new Set<string>();
  const walk = (o: any) => {
    if (Array.isArray(o)) return o.forEach(walk);
    if (!o || typeof o !== "object") return;
    if (typeof o.path === "string" && (o.present === true || "equals" in o)) need.add(o.path);
    Object.values(o).forEach(walk);
  };
  walk(j.signal?.detect);
  walk(j.tiers?.pass);
  return need;
}

describe("scenarios must be passable", () => {
  const all = scenarios();

  it("no scenario forbids the presence of a field its own role's contract requires", () => {
    // Contract-mandatory, learned from the corpus: any path some scenario for
    // this role asserts as present/equals.
    const mandatory = new Map<string, Set<string>>();
    for (const j of all) {
      const set = mandatory.get(j.role) ?? new Set<string>();
      for (const p of requiredPaths(j)) set.add(p);
      mandatory.set(j.role, set);
    }

    const unpassable: string[] = [];
    for (const j of all) {
      const req = mandatory.get(j.role) ?? new Set();
      for (const e of j.expect?.forbidden ?? []) {
        if (e.matcher !== undefined || e.detector) continue;
        if (req.has(e.path)) {
          unpassable.push(
            `${j.id}: forbids ${e.path} being PRESENT, but ${j.role}'s contract requires it — give the entry a matcher naming the forbidden VALUE`,
          );
        }
      }
    }
    expect(unpassable, `scenarios no correct answer can pass:\n${unpassable.join("\n")}`).toEqual([]);
  });

  it("a forbidden entry whose reason names a value has a matcher", () => {
    // "failed is underivable", "rejected is underivable", "passed is underivable"
    // — a reason that opens with a bare literal is describing a VALUE. Without a
    // matcher the entry forbids the field instead, which is a different claim.
    const suspects: string[] = [];
    for (const j of all) {
      for (const e of j.expect?.forbidden ?? []) {
        if (e.matcher !== undefined || e.detector) continue;
        const m = /^(failed|rejected|scored|skipped|passed|true|false|confirmed|healthy)\b\s+is underivable/i.exec(String(e.reason ?? ""));
        if (m) suspects.push(`${j.id}: ${e.path} — reason forbids the value "${m[1]}" but the entry forbids the field`);
      }
    }
    expect(suspects, `value-shaped reasons with no matcher:\n${suspects.join("\n")}`).toEqual([]);
  });
});
