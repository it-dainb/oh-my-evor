/**
 * mcp/tests/eval-specs.test.ts — validates every evals/<role>/spec.json against
 * ci/eval-core.mjs, without calling the API.
 *
 * This suite is generic: it discovers spec files, so a new role's case file is
 * checked the moment it lands rather than by whatever ad-hoc script its author
 * happened to run once.
 *
 * The two failure modes it exists to catch, both of which have already happened
 * in this repo:
 *
 *  1. **A harness where nothing can pass.** If the graded paths do not match the
 *     shape the contract declares, every case fails identically and the report
 *     reads like a model failure. The oracle check pins this: feeding a case's
 *     own expectations back in must score `correct`.
 *
 *  2. **A harness where anything passes.** A scorer that has stopped
 *     discriminating rewards a constant answer. The degenerate-strategy floors
 *     pin this: no fixed reply may clear a third of the cases.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, existsSync } from "fs";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";
import { scoreByContract, buildRolePrompt } from "../../ci/eval-core.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const EVALS = resolve(REPO_ROOT, "evals");

const specs = readdirSync(EVALS, { withFileTypes: true })
  .filter((d) => d.isDirectory() && existsSync(resolve(EVALS, d.name, "spec.json")))
  .map((d) => ({
    dir: d.name,
    spec: JSON.parse(readFileSync(resolve(EVALS, d.name, "spec.json"), "utf8")),
  }));

/**
 * Build the nested answer object a case's own expectations describe.
 *
 * Kinds matter here: for a `present` field the expectation is a boolean *about*
 * the value, not the value itself, so `false` has to become `null`. Writing the
 * literal `false` would be a non-null value and would read back as present.
 */
type OracleField = {
  path: string;
  kind: string;
  key?: string;
  where?: { field: string; equals?: string; not_equals?: string };
};

function oracleAnswer(
  contract: { fields: OracleField[] },
  caseObj: { expect: Record<string, unknown> },
) {
  // Two rules may share one path when each states its own subset, so the
  // expectation key -- not the path -- identifies a field here, exactly as it
  // does in scoreByContract.
  const byKey = new Map(contract.fields.map((f) => [f.key ?? f.path, f]));
  const kindOf = new Map([...byKey].map(([k, f]) => [k, f.kind]));
  const pathOf = (key: string) => byKey.get(key)!.path;
  const out: Record<string, unknown> = {};

  const put = (path: string, value: unknown) => {
    const parts = path.split(".");
    let node = out;
    for (const p of parts.slice(0, -1)) {
      node[p] = node[p] ?? {};
      node = node[p] as Record<string, unknown>;
    }
    node[parts[parts.length - 1]] = value;
  };

  // List-shaped fields share one array, so build the arrays first: a `count`
  // expectation fixes the length and each `every` expectation fixes a field on
  // every element. Doing these one path at a time would have each overwrite the
  // last.
  const lengths = new Map<string, number>();
  for (const [path, value] of Object.entries(caseObj.expect)) {
    if (kindOf.get(path) !== "count") continue;
    const n =
      value && typeof value === "object"
        ? Math.max((value as { min?: number }).min ?? 1, 1)
        : Number(value);
    lengths.set(path, n);
  }
  const roots = new Set<string>(
    Object.keys(caseObj.expect)
      .filter((p) => kindOf.get(p) === "count" || kindOf.get(p) === "every")
      .map((p) => pathOf(p).split("[]")[0]),
  );
  for (const root of roots) {
    const n = lengths.has(root) ? lengths.get(root)! : 1;
    const elements = Array.from({ length: n }, () => ({}) as Record<string, unknown>);
    for (const [key, value] of Object.entries(caseObj.expect)) {
      const path = pathOf(key);
      if (path.split("[]")[0] !== root) continue;
      const inner = path.split("[].")[1];
      const where = byKey.get(key)!.where;
      if (where?.equals !== undefined) {
        // An oracle for a positive filter would have to plant elements that
        // match it, which collides with `unique`'s distinct values. Fail loudly
        // rather than emit an oracle that quietly does not satisfy the rule.
        throw new Error(`oracleAnswer cannot build a positive \`where\` yet (field ${key})`);
      }
      if (kindOf.get(key) === "every") {
        for (const el of elements) el[inner] = value;
      } else if (kindOf.get(key) === "unique") {
        // The oracle for a distinctness rule is distinct values, not the
        // literal `true` the expectation carries.
        elements.forEach((el, i) => {
          el[inner] = `family-${i}`;
        });
      }
    }
    put(root, elements);
  }

  for (const [key, value] of Object.entries(caseObj.expect)) {
    const kind = kindOf.get(key);
    if (kind === "count" || kind === "every") continue;
    put(pathOf(key), kind === "present" ? (value ? { present: true } : null) : value);
  }
  return out;
}

it("there is at least one role spec to validate", () => {
  expect(specs.length).toBeGreaterThan(0);
});

describe.each(specs)("$dir", ({ spec }) => {
  const paths = new Set<string>(spec.contract.fields.map((f: OracleField) => f.key ?? f.path));

  it("declares two arms that differ, so the matrix measures a retier", () => {
    expect(spec.arms).toHaveLength(2);
    expect(spec.arms[0].model).not.toBe(spec.arms[1].model);
  });

  it("points at an agent file that exists", () => {
    expect(existsSync(resolve(REPO_ROOT, spec.agent_file))).toBe(true);
  });

  it("grades only fields the contract states", () => {
    for (const c of spec.cases) {
      for (const path of Object.keys(c.expect)) {
        expect(paths, `case ${c.id}`).toContain(path);
      }
    }
  });

  it("has a case for every contract field, or the field is dead weight in the prompt", () => {
    const graded = new Set(spec.cases.flatMap((c: { expect: object }) => Object.keys(c.expect)));
    for (const p of paths) expect(graded, `contract field ${p}`).toContain(p);
  });

  it("is passable: each case's own expectations score correct", () => {
    for (const c of spec.cases) {
      const r = scoreByContract(spec.contract, c, oracleAnswer(spec.contract, c));
      expect(r.status, `case ${c.id}: ${r.reason}`).toBe("correct");
    }
  });

  it("leaks neither the answer key nor the authoring note into the prompt", () => {
    for (const c of spec.cases) {
      const p = buildRolePrompt("<Agent_Prompt/>", spec.contract, c);
      if (c.note) {
        // Match on a distinctive slice; the whole note is often long.
        expect(p, `case ${c.id}`).not.toContain(String(c.note).slice(0, 40));
      }
      expect(p, `case ${c.id}`).not.toContain(c.id);
    }
  });

  it("is not cleared by a constant answer", () => {
    // Every enum's declared values, plus both booleans, plus presence/absence:
    // enumerate the fixed replies an agent could give without reading anything.
    const constants: Record<string, unknown>[] = [];
    const perElement = (f: OracleField) => f.kind === "every" || f.kind === "unique";
    const build = (choice: (f: OracleField) => unknown, listLen: number) => {
      const out: Record<string, unknown> = {};
      const put = (path: string, value: unknown) => {
        const parts = path.split(".");
        let node = out;
        for (const p of parts.slice(0, -1)) {
          node[p] = node[p] ?? {};
          node = node[p] as Record<string, unknown>;
        }
        node[parts[parts.length - 1]] = value;
      };
      // A fixed reply can pin a field on every element of a list just as easily
      // as it can pin a scalar -- "report every finding as low/indicative" is a
      // constant answer too. Skipping per-element fields here left that whole
      // family of degenerate strategies unmeasured.
      const roots = new Set<string>(
        spec.contract.fields.filter(perElement).map((f: OracleField) => f.path.split("[]")[0]),
      );
      for (const root of roots) {
        const elements = Array.from({ length: listLen }, () => ({}) as Record<string, unknown>);
        for (const f of spec.contract.fields.filter(perElement)) {
          if (f.path.split("[]")[0] !== root) continue;
          const inner = f.path.split("[].")[1];
          elements.forEach((el, i) => {
            el[inner] = f.kind === "unique" ? `family-${i}` : choice(f);
          });
        }
        put(root, elements);
      }
      for (const f of spec.contract.fields) {
        if (perElement(f) || roots.has(f.path)) continue;
        put(f.path, choice(f));
      }
      return out;
    };
    const maxValues = Math.max(
      ...spec.contract.fields.map((f: { values?: string[] }) => f.values?.length ?? 1),
    );
    for (let i = 0; i < maxValues; i++) {
      for (const flag of [true, false]) {
        // Both an empty list and one long enough to satisfy any `min` in the
        // specs: "return nothing" and "return twelve identical entries" are
        // different degenerate strategies and both have to be priced.
        for (const listLen of [0, 12]) {
          constants.push(
            build((f) => {
              if (f.kind === "enum" || f.kind === "every") return f.values![i % f.values!.length];
              if (f.kind === "bool") return flag;
              if (f.kind === "present") return flag ? {} : null;
              if (f.kind === "count") return [];
              return 0;
            }, listLen),
          );
        }
      }
    }

    const floor = Math.ceil(spec.cases.length / 3);
    for (const ans of constants) {
      const n = spec.cases.filter(
        (c: object) => scoreByContract(spec.contract, c, ans).status === "correct",
      ).length;
      expect(n, `a constant answer cleared ${n}/${spec.cases.length}: ${JSON.stringify(ans)}`).toBeLessThan(
        floor,
      );
    }
  });
});
