/**
 * mcp/tests/eval-core.test.ts — ci/eval-core.mjs, the config-driven scorer that
 * replaces one bespoke harness module per role.
 *
 * Nothing here calls the API. The live path (makeRunOneCall's returned closure)
 * is never invoked; only the pure contract/parse/score functions are imported.
 *
 * What is being defended is the single invariant that made the forge gate
 * harness trustworthy, now generalised: **the prompt states everything the
 * scorer grades**. In the gate harness that held because one hand-written
 * string was pasted into the prompt and also read by the scorer. Here it must
 * hold structurally — buildContractText() and scoreByContract() read the SAME
 * `contract.fields` array, so a field cannot be graded without being stated.
 *
 * The defect this exists to prevent has bitten this session repeatedly: grading
 * an agent on a rule its own agent file never gave it. A harness that can drift
 * will drift.
 */

import { describe, it, expect } from "vitest";
import {
  buildContractText,
  parseContractOutput,
  gradeField,
  scoreByContract,
  getPath,
  buildRolePrompt,
} from "../../ci/eval-core.mjs";

// A contract exercising every field kind, in both output modes.
const JSON_CONTRACT = {
  heading: "Probe Report",
  mode: "json",
  fields: [
    { path: "loss_curve_class", kind: "enum", values: ["healthy", "plateaued", "diverging", "oscillating"] },
    { path: "telemetry_sane", kind: "bool" },
    { path: "hypothesis_verdict", kind: "enum", values: ["confirmed", "refuted", "inconclusive"] },
    { path: "prediction_error_pp", kind: "number", tol: 0.05 },
    { path: "signals", kind: "set" },
  ],
};

const SECTION_CONTRACT = {
  heading: "Capability Gate",
  mode: "section",
  fields: [
    { path: "decision", kind: "enum", values: ["abort", "proceed"] },
    { path: "batch_size", kind: "int_or_word", word: "unchanged" },
  ],
};

describe("buildContractText", () => {
  it("states every field the scorer can grade", () => {
    const text = buildContractText(JSON_CONTRACT);
    for (const f of JSON_CONTRACT.fields) {
      expect(text).toContain(f.path);
    }
  });

  it("spells out every legal value of an enum, so the agent is never guessing the vocabulary", () => {
    const text = buildContractText(JSON_CONTRACT);
    for (const v of ["healthy", "plateaued", "diverging", "oscillating"]) {
      expect(text).toContain(v);
    }
  });

  it("emits a fenced JSON skeleton in json mode and bullets in section mode", () => {
    expect(buildContractText(JSON_CONTRACT)).toMatch(/```json/);
    const section = buildContractText(SECTION_CONTRACT);
    expect(section).not.toMatch(/```/);
    expect(section).toMatch(/^## Capability Gate$/m);
    expect(section).toMatch(/^- decision:/m);
  });
});

describe("parseContractOutput", () => {
  it("reads a fenced JSON block out of surrounding prose", () => {
    const out = parseContractOutput(
      'Here is my analysis.\n\n```json\n{"telemetry_sane": false}\n```\n\nDone.',
      JSON_CONTRACT,
    );
    expect(out).toEqual({ telemetry_sane: false });
  });

  it("reads bare JSON with no fence", () => {
    expect(parseContractOutput('{"telemetry_sane": true}', JSON_CONTRACT)).toEqual({ telemetry_sane: true });
  });

  it("returns null when there is no JSON at all", () => {
    expect(parseContractOutput("I could not complete the analysis.", JSON_CONTRACT)).toBeNull();
  });

  it("reads a bounded markdown section without bleeding into the next heading", () => {
    // The regression this pins: the forge report template has a later section
    // whose bullets also match, one of which literally contains the word abort.
    const text = [
      "## Capability Gate",
      "- decision: proceed",
      "- batch_size: 128",
      "",
      "## Team Execution",
      "- Architect verdict: approved | rejected | abort",
    ].join("\n");
    const out = parseContractOutput(text, SECTION_CONTRACT);
    expect(out?.decision).toBe("proceed");
    expect(out?.batch_size).toBe("128");
  });

  it("returns null in section mode when the section is absent", () => {
    expect(parseContractOutput("## Something Else\n- decision: proceed", SECTION_CONTRACT)).toBeNull();
  });
});

describe("getPath", () => {
  it("reads nested fields, which is how the forge reviewers report their checks", () => {
    expect(getPath({ checks: { numeric_stability: "fail" } }, "checks.numeric_stability")).toBe("fail");
  });

  it("returns undefined rather than throwing on a missing intermediate", () => {
    expect(getPath({}, "checks.numeric_stability")).toBeUndefined();
  });
});

describe("gradeField", () => {
  it("matches an enum case-insensitively and tolerates surrounding decoration", () => {
    const f = { path: "decision", kind: "enum", values: ["abort", "proceed"] };
    expect(gradeField(f, "abort", "**Abort**").correct).toBe(true);
    expect(gradeField(f, "abort", "proceed").correct).toBe(false);
  });

  it("does not let one enum value match because it is a substring of the answer's prose", () => {
    // "proceed with caution" is a proceed; "we cannot proceed, abort" is not.
    const f = { path: "decision", kind: "enum", values: ["abort", "proceed"] };
    expect(gradeField(f, "abort", "we cannot proceed, abort").correct).toBe(true);
  });

  it("grades booleans written as strings or as JSON literals", () => {
    const f = { path: "telemetry_sane", kind: "bool" };
    expect(gradeField(f, false, false).correct).toBe(true);
    expect(gradeField(f, false, "false").correct).toBe(true);
    expect(gradeField(f, false, true).correct).toBe(false);
  });

  it("grades numbers within an absolute tolerance", () => {
    // prediction_error_pp is a subtraction, so the tolerance absorbs rounding
    // of the inputs, nothing more. It is absolute: a relative band would widen
    // as the error grows, which is backwards.
    const f = { path: "prediction_error_pp", kind: "number", tol: 0.05 };
    expect(gradeField(f, 0.1, 0.1).correct).toBe(true);
    expect(gradeField(f, 0.1, 0.14).correct).toBe(true);
    expect(gradeField(f, 0.1, 0.15).correct).toBe(true);
    expect(gradeField(f, 0.1, 0.2).correct).toBe(false);
    expect(gradeField(f, 0.1, -0.1).correct).toBe(false);
  });

  it("requires an exact match when no tolerance is declared", () => {
    const f = { path: "collision_rate", kind: "number" };
    expect(gradeField(f, 0.5, 0.5).correct).toBe(true);
    expect(gradeField(f, 0.5, 0.51).correct).toBe(false);
  });

  it("grades an int field exactly", () => {
    const f = { path: "dream_k", kind: "int" };
    expect(gradeField(f, 6, "6").correct).toBe(true);
    expect(gradeField(f, 6, 5).correct).toBe(false);
  });

  it("grades a set unordered and ignoring whitespace", () => {
    const f = { path: "signals", kind: "set" };
    expect(gradeField(f, ["b", "a"], "a, b").correct).toBe(true);
    expect(gradeField(f, ["a"], "a, b").correct).toBe(false);
    expect(gradeField(f, [], "none").correct).toBe(true);
  });

  it("accepts either the sentinel word or the restated value for int_or_word", () => {
    const f = { path: "batch_size", kind: "int_or_word", word: "unchanged" };
    expect(gradeField(f, "unchanged", "unchanged", { restated: 512 }).correct).toBe(true);
    expect(gradeField(f, "unchanged", "512", { restated: 512 }).correct).toBe(true);
    expect(gradeField(f, "unchanged", "128", { restated: 512 }).correct).toBe(false);
    expect(gradeField(f, 128, "128").correct).toBe(true);
  });

  it("distinguishes a null field from a missing one for `present`", () => {
    // probe's benchmark_upgrade_proposal is null-or-object: `null` is a real,
    // correct answer meaning "no proposal", not a failure to answer. Every
    // other kind treats null as unanswered, so this needs its own kind.
    const f = { path: "benchmark_upgrade_proposal", kind: "present" };
    expect(gradeField(f, false, null).correct).toBe(true);
    expect(gradeField(f, false, undefined).correct).toBe(true);
    expect(gradeField(f, true, { reason: "saturation" }).correct).toBe(true);
    expect(gradeField(f, true, null).correct).toBe(false);
    expect(gradeField(f, false, { reason: "saturation" }).correct).toBe(false);
  });

  it("grades the length of an array with `count`", () => {
    // Sage's "2-5 angles per compound query" and "fan-out is mandatory at 2+
    // unresolved angles" are rules about how many, not about which.
    const f = { path: "angles_decomposed", kind: "count" };
    expect(gradeField(f, 3, ["a", "b", "c"]).correct).toBe(true);
    expect(gradeField(f, 3, ["a", "b"]).correct).toBe(false);
    expect(gradeField(f, { min: 2, max: 5 }, ["a", "b"]).correct).toBe(true);
    expect(gradeField(f, { min: 2, max: 5 }, ["a"]).correct).toBe(false);
    expect(gradeField(f, { min: 2, max: 5 }, ["a", "b", "c", "d", "e", "f"]).correct).toBe(false);
    expect(gradeField(f, 0, []).correct).toBe(true);
    expect(gradeField(f, 2, "not an array").correct).toBe(false);
  });

  it("grades a field inside every element of an array with `every`", () => {
    // The count of proposals is not fixed, but "no proposal may be structural
    // at wildness 0.3" has to hold for all of them.
    const f = { path: "proposals[].mutation_tier", kind: "every", values: ["parametric", "structural"] };
    expect(gradeField(f, "parametric", [{ mutation_tier: "parametric" }, { mutation_tier: "parametric" }]).correct).toBe(true);
    expect(gradeField(f, "parametric", [{ mutation_tier: "parametric" }, { mutation_tier: "structural" }]).correct).toBe(false);
  });

  it("does not let `every` pass vacuously on an empty array", () => {
    // An agent that returns nothing must not score as having obeyed the rule.
    const f = { path: "proposals[].mutation_tier", kind: "every", values: ["parametric", "structural"] };
    expect(gradeField(f, "parametric", []).correct).toBe(false);
  });

  it("counts a missing answer as wrong, not as absent", () => {
    const f = { path: "telemetry_sane", kind: "bool" };
    expect(gradeField(f, false, undefined).correct).toBe(false);
  });
});

describe("array-shaped contracts", () => {
  const contract = {
    heading: "Proposals",
    mode: "json",
    fields: [
      { path: "proposals", kind: "count" },
      { path: "proposals[].mutation_tier", kind: "every", values: ["parametric", "structural"] },
    ],
  };

  it("reads the array from the part of the path before the brackets", () => {
    const c = { id: "p", expect: { "proposals[].mutation_tier": "structural", proposals: { min: 2 } } };
    const parsed = { proposals: [{ mutation_tier: "structural" }, { mutation_tier: "structural" }] };
    expect(scoreByContract(contract, c, parsed).status).toBe("correct");
  });

  it("states the per-element rule in the prompt rather than inventing a bogus JSON key", () => {
    const text = buildContractText(contract);
    expect(text).not.toContain('"proposals[].mutation_tier"');
    expect(text).toContain("mutation_tier");
    expect(text).toMatch(/every|each/i);
  });
});

describe("scoreByContract", () => {
  const caseObj = {
    id: "nan-run",
    expect: { telemetry_sane: false, hypothesis_verdict: "inconclusive" },
  };

  it("grades exactly the fields the case states an expectation for", () => {
    const r = scoreByContract(JSON_CONTRACT, caseObj, {
      telemetry_sane: false,
      hypothesis_verdict: "inconclusive",
      loss_curve_class: "diverging",
    });
    expect(r.status).toBe("correct");
    expect(r.checks.map((c: { name: string }) => c.name).sort()).toEqual([
      "hypothesis_verdict",
      "telemetry_sane",
    ]);
  });

  it("never grades a path that the contract does not state", () => {
    // A case file typo must fail loudly, not silently grade an unstated rule.
    expect(() =>
      scoreByContract(JSON_CONTRACT, { id: "x", expect: { telemtry_sane: false } }, {}),
    ).toThrow(/telemtry_sane/);
  });

  it("reports unparseable rather than incorrect when nothing could be read", () => {
    const r = scoreByContract(JSON_CONTRACT, caseObj, null);
    expect(r.status).toBe("unparseable");
    expect(r.checks).toEqual([]);
  });

  it("is all-or-nothing: one wrong field fails the case", () => {
    const r = scoreByContract(JSON_CONTRACT, caseObj, {
      telemetry_sane: false,
      hypothesis_verdict: "confirmed",
    });
    expect(r.status).toBe("incorrect");
    expect(r.reason).toMatch(/hypothesis_verdict/);
  });

  it("skips a field whose gate condition is not met", () => {
    // The gate harness's rule: on an abort there is no junior to configure, so
    // batch_size describes a spawn that will never happen.
    const contract = {
      ...SECTION_CONTRACT,
      fields: [
        SECTION_CONTRACT.fields[0],
        { ...SECTION_CONTRACT.fields[1], gradeWhen: { path: "decision", equals: "proceed" } },
      ],
    };
    const c = { id: "abort", expect: { decision: "abort", batch_size: "unchanged" } };
    const r = scoreByContract(contract, c, { decision: "abort", batch_size: "9999" });
    expect(r.checks.map((k: { name: string }) => k.name)).toEqual(["decision"]);
    expect(r.status).toBe("correct");
  });

  it("resolves a restated-value reference against the case, not the answer", () => {
    const contract = {
      heading: "Gate",
      mode: "section",
      fields: [{ path: "batch_size", kind: "int_or_word", word: "unchanged", restatedFrom: "proposal.batch_size" }],
    };
    const c = { id: "bs", proposal: { batch_size: 64 }, expect: { batch_size: "unchanged" } };
    expect(scoreByContract(contract, c, { batch_size: "64" }).status).toBe("correct");
    expect(scoreByContract(contract, c, { batch_size: "128" }).status).toBe("incorrect");
  });
});

describe("the prompt states everything the scorer grades", () => {
  it("holds structurally: no expectation can name a field absent from the contract text", () => {
    const text = buildContractText(JSON_CONTRACT);
    const graded = ["telemetry_sane", "hypothesis_verdict", "prediction_error_pp", "signals", "loss_curve_class"];
    for (const path of graded) {
      // Every gradable path must be reachable from the text the agent is given.
      expect(text).toContain(path.split(".")[0]);
    }
  });
});

describe("buildRolePrompt", () => {
  const contract = {
    heading: "Probe Report",
    mode: "json",
    fields: [{ path: "telemetry_sane", kind: "bool" }],
  };
  const caseObj = {
    id: "nan-run",
    gate: "sanity",
    note: "the giveaway is that train_loss goes NaN at step 40",
    telemetry: { train_loss: [1.2, 0.9, null] },
    expect: { telemetry_sane: false },
  };
  const prompt = buildRolePrompt("<Agent_Prompt>do the thing</Agent_Prompt>", contract, caseObj);

  it("carries the agent's own prompt block and the output contract", () => {
    expect(prompt).toContain("do the thing");
    expect(prompt).toContain("telemetry_sane");
  });

  it("inlines the case payload the agent has to reason over", () => {
    expect(prompt).toContain("train_loss");
    expect(prompt).toContain("1.2");
  });

  it("leaks neither the expected answer nor the case note", () => {
    // `note` is authoring commentary and `expect` is the answer key. Either one
    // in the prompt turns the benchmark into a reading-comprehension test.
    expect(prompt).not.toContain("the giveaway");
    expect(prompt).not.toMatch(/"expect"/);
    expect(prompt).not.toMatch(/\bnote\b/);
  });

  it("omits the bookkeeping keys that are not part of the scenario", () => {
    expect(prompt).not.toMatch(/"gate"/);
    expect(prompt).not.toMatch(/nan-run/);
  });
});
