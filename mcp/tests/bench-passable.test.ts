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

/** Paths a scenario's DECLARATION channels credit the agent for writing. */
function declaredPaths(j: any): Set<string> {
  const out = new Set<string>();
  const walk = (o: any) => {
    if (Array.isArray(o)) return o.forEach(walk);
    if (!o || typeof o !== "object") return;
    for (const [k, v] of Object.entries(o.arg ?? {})) {
      if (typeof k === "string" && k.startsWith("$.")) out.add(k);
    }
    Object.values(o).forEach(walk);
  };
  walk(j.signal?.declaration);
  return out;
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

  it("no scenario forbids the very field its declaration credits", () => {
    // L5-mean-quoted-as-min declared
    //   { tool: 'evor_write_artifact', arg: { '$.payload.eda_summary.per_domain_gap_pp': '*' } }
    // as a declaration channel, and forbade the presence of that same path. An
    // agent that declared exactly the way the pair asks was scored FN FOR
    // DECLARING. Nothing local caught it: the earlier check walked `detect` and
    // `tiers.pass` and never looked at `declaration`.
    const contradictions: string[] = [];
    for (const j of all) {
      const credited = declaredPaths(j);
      for (const e of j.expect?.forbidden ?? []) {
        if (e.matcher !== undefined || e.detector) continue;
        if (credited.has(e.path)) {
          contradictions.push(`${j.id}: forbids ${e.path}, which its own declaration credits`);
        }
      }
    }
    expect(contradictions, `scenarios that forbid their own declaration channel:\n${contradictions.join("\n")}`).toEqual([]);
  });

  it("a forbidden path that is also an ordinary tool argument is answer-scoped", () => {
    // `expect.forbidden` scans the trace as well as the answer, which is right
    // for a payload path — writing a forbidden verdict into evor_write_artifact
    // is the same fabrication as returning it. It is wrong for a path that is
    // also a tool PARAMETER. `$.node_id` is an argument of evor_signal_emit,
    // evor_read_result and evor_cite; L3-...-neg was scored FP/fabrication twice
    // on an answer that contained neither node_id nor score, because the paths
    // matched the arguments of signals the tick correctly emitted.
    const PARAMS = new Set(["$.node_id", "$.score", "$.run_id", "$.tick", "$.job_id"]);
    const unscoped: string[] = [];
    for (const j of all) {
      for (const e of j.expect?.forbidden ?? []) {
        if (e.detector) continue;
        // The rule is DECLARE, not "must be answer". Some of these genuinely
        // target the call — T2-artifact-slot forbids a wrong `$.tick` on
        // evor_write_artifact, which is the whole subject of the angle. What is
        // not acceptable is inheriting the `both` default silently, because
        // then a path that is also a tool parameter fires on ordinary calls and
        // the author never chose that.
        if (PARAMS.has(e.path) && e.scope === undefined) {
          unscoped.push(`${j.id}: ${e.path} is a tool parameter — declare scope: 'answer' or 'trace'`);
        }
      }
    }
    expect(unscoped, `forbidden paths that will fire on ordinary tool calls:\n${unscoped.join("\n")}`).toEqual([]);
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
