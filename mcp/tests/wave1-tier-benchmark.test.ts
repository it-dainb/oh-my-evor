/**
 * mcp/tests/wave1-tier-benchmark.test.ts — wave-1 field trace, category 7
 * (tier and benchmark validity). RED phase: these pin the invariants the
 * v1.2.0 tier claim needed and did not have.
 *
 * The finding this file exists for (P-04): the 2,320-session tier-matrix corpus
 * that justified the retier contains **not one `tool_use` block**. The role
 * prompts carry the agent file's own instructions to call `evor_capability()`
 * and `evor_gotcha_query(...)`, but `ci/role-eval.mjs` shells out to `claude -p`
 * with no MCP server attached and `ci/eval-core.mjs` appends "do not call any
 * tool". So the mandate is inert text, the agent answers from the payload, and
 * a role whose contract depends on a tool result was graded on a run where the
 * tool never existed. That is also why the haiku tool-name defect (S3/N-07) was
 * invisible to the benchmarks: a corpus with no tool calls cannot show a
 * mis-transcribed tool name.
 *
 * What is deliberately NOT here: any test that claims to measure a model's
 * behaviour. Whether haiku mangles an MCP prefix is not a unit-testable
 * property. What is testable is that the repo names the prefix one way
 * everywhere, that the harness records whether tools were attached, and that
 * the shipped agent files agree with the documents and specs that claim to
 * describe them.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, existsSync, statSync } from "fs";
import { join, dirname, resolve } from "path";
import { fileURLToPath } from "url";
import { buildRolePrompt } from "../../ci/eval-core.mjs";
import { extractAgentPromptBlock, buildReport } from "../../ci/agent-eval.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const AGENTS_DIR = resolve(REPO_ROOT, "agents");
const EVALS_DIR = resolve(REPO_ROOT, "evals");

const AGENT_FILES = readdirSync(AGENTS_DIR)
  .filter((f) => f.endsWith(".md"))
  .sort();

function frontmatter(file: string): Record<string, string> {
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

/** role name ("evor-probe") -> declared model, as shipped. */
const SHIPPED_MODEL = new Map<string, string>(
  AGENT_FILES.map((f) => [f.replace(/\.md$/, ""), frontmatter(f).model]),
);

const specs = readdirSync(EVALS_DIR, { withFileTypes: true })
  .filter((d) => d.isDirectory() && existsSync(resolve(EVALS_DIR, d.name, "spec.json")))
  .map((d) => ({
    dir: d.name,
    spec: JSON.parse(readFileSync(resolve(EVALS_DIR, d.name, "spec.json"), "utf8")),
  }));

// ─────────────────────────────────────────────────────────────────────────────
// P-04 — the corpus that graded a tool-using role on a toolless run.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A written tool invocation in the agent's own prompt: `evor_capability()`,
 * "call `evor_wiki_query`", `evor_gotcha_query({...})`. These are the
 * instructions the agent is told to follow; the harness then tells it not to.
 */
function mandatedToolCalls(prompt: string): string[] {
  const hits = new Set<string>();
  for (const m of prompt.matchAll(/\b(evor_[a-z_]+)\s*\(/g)) hits.add(m[1]);
  for (const m of prompt.matchAll(/\bcalls?\s+`?(evor_[a-z_]+)/gi)) hits.add(m[1]);
  return [...hits].sort();
}

const NO_TOOL_INSTRUCTION = "do not call any tool";

describe("P-04 — a role-eval prompt may not mandate a tool call it also forbids", () => {
  // The correct states are: attach the MCP server and grade the tool call, or
  // neutralise the mandate the way ci/agent-eval.mjs's buildCasePrompt does for
  // selector ("Gates H002 and Gotcha Avoidance require live state ... score both
  // pass unconditionally and do not let them affect the verdict"). Emitting both
  // instructions and then scoring the answer is neither.
  it.each(specs)("$dir", ({ spec }) => {
    const agentFile = resolve(REPO_ROOT, spec.agent_file);
    const block = extractAgentPromptBlock(readFileSync(agentFile, "utf8"));
    const prompt: string = buildRolePrompt(block, spec.contract, spec.cases[0]);

    const mandated = mandatedToolCalls(prompt);
    const forbids = prompt.toLowerCase().includes(NO_TOOL_INSTRUCTION);

    expect(
      mandated.length > 0 && forbids,
      `the prompt orders the agent to call [${mandated.join(", ")}] and then forbids all tool ` +
        `calls. Whatever those calls would have returned is graded from the payload instead, ` +
        `so this arm measures the prompt, not the role.`,
    ).toBe(false);
  });
});

describe("P-04 — the report records whether MCP tools were attached", () => {
  it("buildReport stamps the tool-availability basis of the run", () => {
    // The meta-finding: v1.2.0's tier claim rests on a corpus with zero tool_use
    // blocks, and nothing in the report says so. A future tier claim must not be
    // makeable from a toolless corpus without that being visible in the artifact
    // the claim is read from.
    const report = buildReport({
      role: "evor-probe",
      tiers: [{ model: "haiku", effort: "medium" }],
      records: [
        {
          tier: "haiku (effort inert)",
          case_id: "c1",
          primary_gate: "baseline",
          repeat: 0,
          status: "correct",
          wall_ms: 1000,
          cost_usd: 0.01,
        },
      ],
    });

    expect(
      Object.prototype.hasOwnProperty.call(report, "mcp_tools_attached"),
      "buildReport() emitted no `mcp_tools_attached` field, so a report produced " +
        "without an MCP server is indistinguishable from one produced with it. " +
        `keys: ${Object.keys(report).join(", ")}`,
    ).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// S3 / N-07 — MCP prefix consistency. NOT a test of model transcription.
// ─────────────────────────────────────────────────────────────────────────────

describe("S3/N-07 — every source that names the MCP prefix names it identically", () => {
  const SERVERS = Object.keys(
    JSON.parse(readFileSync(resolve(REPO_ROOT, ".mcp.json"), "utf8")).mcpServers,
  );
  const SCAN_DIRS = ["agents", "skills", "hooks", "commands", "mcp/src", "harness/evor"];
  const SCAN_FILES = readdirSync(resolve(REPO_ROOT, "ci"))
    .filter((f) => f.endsWith(".mjs"))
    .map((f) => join("ci", f));

  function walk(dir: string, out: string[] = []): string[] {
    if (!existsSync(dir)) return out;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p, out);
      else if (statSync(p).size < 2_000_000) out.push(p);
    }
    return out;
  }

  const files = [
    ...SCAN_DIRS.flatMap((d) => walk(resolve(REPO_ROOT, d))),
    ...SCAN_FILES.map((f) => resolve(REPO_ROOT, f)),
  ];

  it("scans a non-empty set of sources", () => {
    expect(files.length).toBeGreaterThan(10);
  });

  it("uses `mcp__plugin_oh-my-evor_<server>__` and no other spelling", () => {
    const offenders: string[] = [];
    for (const f of files) {
      const text = readFileSync(f, "utf8");
      for (const m of text.matchAll(/mcp__plugin_[A-Za-z0-9_-]+__/g)) {
        const token = m[0];
        // Other plugins' servers are not ours to police.
        if (!/evor/i.test(token)) continue;
        const parsed = /^mcp__plugin_oh-my-evor_([A-Za-z0-9-]+)__$/.exec(token);
        if (!parsed || !SERVERS.includes(parsed[1])) {
          offenders.push(`${f.replace(REPO_ROOT + "/", "")}: ${token}`);
        }
      }
    }
    expect(offenders, `declared servers: ${SERVERS.join(", ")}`).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// evor-acquirer / evor-tick — eval coverage per declared role.
// ─────────────────────────────────────────────────────────────────────────────

describe("every declared role has eval coverage", () => {
  // `evor-acquirer` was retiered to haiku and never spawned once in the 19-hour
  // run, so its retier is unmeasured in the field. Offline coverage is the only
  // thing a test can hold: a role with no spec and no case file cannot be
  // measured at all, in either direction.
  it.each(AGENT_FILES.map((f) => f.replace(/\.md$/, "")))("%s", (role) => {
    const short = role.replace(/^evor-/, "");
    const dir = resolve(EVALS_DIR, short);
    const covered =
      existsSync(resolve(dir, "spec.json")) || existsSync(resolve(dir, "cases.json"));
    expect(
      covered,
      `no evals/${short}/spec.json and no evals/${short}/cases.json — this role's tier ` +
        `is asserted, never measured`,
    ).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// D — tier conformance between the shipped files, the specs and the doc.
// ─────────────────────────────────────────────────────────────────────────────

describe("D — the eval specs measure the tier the role actually ships on", () => {
  // A spec whose `current` arm is not the shipped model measures a retier that
  // did not happen. Re-running it produces a number about a configuration no
  // agent runs, which is the failure mode ci/role-eval.mjs's loud tier check
  // exists to prevent one level down.
  it.each(specs)("$dir", ({ dir, spec }) => {
    const current = spec.arms.find((a: { label?: string }) => /current/i.test(a.label ?? ""));
    expect(current, "no arm labelled `current`").toBeDefined();
    const role: string = spec.role;
    expect(
      current.model,
      `evals/${dir}/spec.json calls \`${current.model}\` the current arm, but ` +
        `agents/${role}.md ships \`${SHIPPED_MODEL.get(role)}\``,
    ).toBe(SHIPPED_MODEL.get(role));
  });
});

describe("D — the benchmark document describes the tiers that shipped", () => {
  const doc = readFileSync(resolve(REPO_ROOT, "docs/retier-benchmark-results.md"), "utf8");

  // ITEM 7.4 CHANGED THIS DOCUMENT'S SHAPE, DELIBERATELY.
  //
  // It was hand-maintained with no generator and was one of FOUR descriptions of
  // which model each role ships on; RC7 measured corrected rows rotting within
  // 26 hours. It is now GENERATED from `agents/*.md` frontmatter by
  // `ci/generate-tier-doc.mjs`, so it cannot disagree with the build — it is read
  // from the build.
  //
  // The old six-column table carried `was | $ | now | $ | saving`. Those cost
  // columns were measurements, and reproducing them in a generated file would be
  // asserting numbers no longer being measured — RC7's exact error. The
  // generated table states what SHIPS, which is a fact about the frontmatter,
  // and Phase 8 re-measures the rest. The parser follows.
  const adopted = [...doc.matchAll(
    /^\|\s*`?([a-z][a-z-]*)`?\s*\|\s*(opus|sonnet|haiku)\s*\|/gim,
  )].map((m) => ({ role: `evor-${m[1]}`, now: m[2] }));

  it("states a final tier for at least one role", () => {
    expect(adopted.length).toBeGreaterThan(0);
  });

  it("matches every agent file it names", () => {
    const drift = adopted
      .filter((r) => SHIPPED_MODEL.has(r.role) && SHIPPED_MODEL.get(r.role) !== r.now)
      .map((r) => `${r.role}: doc says ${r.now}, agents/${r.role}.md declares ${SHIPPED_MODEL.get(r.role)}`);
    expect(
      drift,
      "docs/retier-benchmark-results.md is the evidence the retier rests on; where it " +
        "disagrees with the shipped frontmatter, one of the two is describing a build " +
        "that does not exist",
    ).toEqual([]);
  });
});
