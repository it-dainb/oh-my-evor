/**
 * mcp/tests/wave1-tier-live-eval.test.ts — the instrument v1.2.0's tier corpus
 * did not have: a role eval that runs WITH the evor MCP server attached and
 * grades the tool calls the role actually emitted.
 *
 * Why this exists (P-04). The 2,320-session tier matrix behind
 * `docs/retier-benchmark-results.md` contains not one `tool_use` block.
 * `ci/role-eval.mjs` shells out to `claude -p` with no MCP config, and
 * `ci/eval-core.mjs` appends "do not call any tool; reason from them directly."
 * Every tier verdict in that document is therefore about a model answering from
 * an inlined payload — a real measurement of a different task. The haiku
 * mangled-prefix defect (`mcp__plugin_oh-my_evor_evor__…`, underscore for
 * hyphen, S3/N-07) could not appear in such a corpus, because a corpus with no
 * tool calls has no tool names to mangle.
 *
 * What this harness adds, and only this:
 *   (a) the MCP server is attached, under the SAME wire prefix production uses
 *       (`mcp__plugin_oh-my-evor_evor__`), so a mis-transcription is expressible;
 *   (b) the run is parsed from `--output-format stream-json`, so every emitted
 *       tool NAME is observable rather than inferred;
 *   (c) the mandated tool call is asserted to have happened, so a role that
 *       answered from prose is not scored as if it had used the tool.
 *
 * Statistical discipline. Both arms come from ONE paired matrix over the SAME
 * agent files: the only variable between arms is `--model`. n per arm is
 * recorded in the report and printed. If the malformed prefix does not appear,
 * that is "not observed at n=X" — it is NOT evidence the defect is absent.
 * At lane D's observed base rate (3 of 17 haiku agents, ~18%), a run of 15
 * calls has a ~5% chance of seeing zero by luck alone, and this harness reports
 * that number rather than implying a refutation.
 *
 * Gating. Live calls cost money and need API access, so the suite runs only
 * under `EVOR_LIVE_EVAL=1`. That is a cost gate, not a `.skip`: with the gate
 * on, every failure is loud, and an unreachable model is an error, never a pass.
 *
 *   EVOR_LIVE_EVAL=1 npx vitest run mcp/tests/wave1-tier-live-eval.test.ts
 *
 * Env: EVOR_LIVE_EVAL_REPEATS (default 5, per role per arm)
 *      EVOR_LIVE_EVAL_CONCURRENCY (default 5)
 *      EVOR_LIVE_EVAL_TIMEOUT_MS (default 300000, per call)
 *      EVOR_LIVE_EVAL_OUT (default docs/field-trace-v1.2.0/red/T7-live-eval-raw.json)
 */

import { describe, it, expect, beforeAll } from "vitest";
import { execFile } from "child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, resolve, join } from "path";
import { fileURLToPath } from "url";
import { extractAgentPromptBlock } from "../../ci/agent-eval.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const LIVE = process.env.EVOR_LIVE_EVAL === "1";

/**
 * The wire prefix production uses. Naming the --mcp-config server key
 * `plugin_oh-my-evor_evor` reproduces it exactly, so the string the three haiku
 * agents mangled is the string this harness puts in front of the model. A
 * shorter key (`evor`) would make the test unable to express the defect.
 */
const SERVER_KEY = "plugin_oh-my-evor_evor";
const CANONICAL_PREFIX = `mcp__${SERVER_KEY}__`;

/**
 * The three roles where the malformed prefix appeared: all haiku, all
 * retiered-to-haiku, all signal-emitting. The sonnet arm is the control.
 * `task` names a bare tool the agent file itself mandates — bare, because that
 * is how the agent files spell it; constructing the `mcp__…__` wire name from
 * the tool listing is precisely the step under test.
 */
const ROLES = [
  {
    role: "evor-probe",
    declaredTier: "haiku",
    task: [
      "A tick has just completed. Before doing anything else, call `evor_capability`",
      "to read the hardware profile, then call `evor_signal_emit` to emit one",
      "`eda-complete` signal for run_id `t7-live` with a one-sentence summary.",
      "If a tool returns an error, report the error text and continue — do not retry",
      "more than once. Finish by replying with the single word DONE.",
    ].join("\n"),
  },
  {
    role: "evor-sage",
    declaredTier: "haiku",
    task: [
      "You have received one research angle: \"binarization preprocessing for palm-leaf",
      "manuscripts\". Follow your wiki-first rule: call `evor_wiki_query` for that angle",
      "before anything else, then call `evor_capability` to check the hardware profile.",
      "If a tool returns an error, report the error text and continue — do not retry",
      "more than once. Finish by replying with the single word DONE.",
    ].join("\n"),
  },
  {
    role: "evor-selector",
    declaredTier: "haiku",
    task: [
      "You are gating one proposal for run_id `t7-live`. Run the Gotcha Avoidance gate:",
      "call `evor_gotcha_query` for kind `hardware-constraint` at min_confidence 0.8, and",
      "again for kind `runtime-failure`. If a tool returns an error, report the error text",
      "and continue — do not retry more than once. Finish by replying with the single",
      "word DONE.",
    ].join("\n"),
  },
] as const;

const ARMS = ["haiku", "sonnet"] as const;

type CallResult = {
  role: string;
  arm: string;
  repeat: number;
  ok: boolean;
  error: string | null;
  /** model ids the CLI reported billing, e.g. ["claude-haiku-4-5"] */
  models: string[];
  /** true iff the session-init frame listed at least one evor MCP tool */
  mcp_tools_attached: boolean;
  /** every tool_use name emitted, in order */
  tool_names: string[];
  /** names that look like an evor MCP call but do not carry the canonical prefix */
  malformed: string[];
  evor_calls: number;
  wall_ms: number;
  cost_usd: number | null;
};

const results: CallResult[] = [];
let workdir = "";

function agentPromptBlock(role: string): string {
  return extractAgentPromptBlock(readFileSync(resolve(REPO_ROOT, "agents", `${role}.md`), "utf8"));
}

/**
 * A name is an evor MCP call if it mentions evor and carries an `mcp__` prefix.
 * Malformed = it does, but not with the canonical prefix. This is the check
 * that would have surfaced `mcp__plugin_oh-my_evor_evor__evor_signal_emit` in a
 * benchmark rather than in a 19-hour production run.
 */
function isEvorMcpName(name: string): boolean {
  return name.startsWith("mcp__") && /evor/i.test(name);
}

function runOne(role: string, task: string, arm: string, repeat: number): Promise<CallResult> {
  const prompt = [
    agentPromptBlock(role),
    "",
    "---",
    "",
    "This is a LIVE run. The evor MCP server is attached and its tools are available",
    "to you; use them as your role description instructs. Do not read or write files",
    "directly in place of a tool call.",
    "",
    task,
  ].join("\n");

  const args = [
    "-p", prompt,
    "--model", arm,
    "--mcp-config", join(workdir, "mcp-config.json"),
    "--strict-mcp-config",
    "--permission-mode", "bypassPermissions",
    "--output-format", "stream-json",
    "--verbose",
    "--max-turns", "8",
  ];

  const t0 = Date.now();
  return new Promise((res) => {
    execFile(
      "claude",
      args,
      { cwd: workdir, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: TIMEOUT_MS },
      (err, stdout) => {
        const wall_ms = Date.now() - t0;
        const base: CallResult = {
          role, arm, repeat,
          ok: false, error: null, models: [],
          mcp_tools_attached: false, tool_names: [], malformed: [],
          evor_calls: 0, wall_ms, cost_usd: null,
        };
        if (!stdout) {
          base.error = `claude produced no output: ${err ? String(err.message).slice(0, 300) : "empty"}`;
          return res(base);
        }
        let sawResult = false;
        for (const line of stdout.split("\n")) {
          if (!line.trim()) continue;
          let o: Record<string, unknown>;
          try { o = JSON.parse(line); } catch { continue; }
          if (o.type === "system" && Array.isArray(o.tools)) {
            if ((o.tools as string[]).some(isEvorMcpName)) base.mcp_tools_attached = true;
          }
          if (o.type === "assistant") {
            const content = (o.message as { content?: { type: string; name?: string }[] })?.content ?? [];
            for (const c of content) if (c.type === "tool_use" && c.name) base.tool_names.push(c.name);
          }
          if (o.type === "result") {
            sawResult = true;
            base.models = Object.keys((o.modelUsage as object) ?? {});
            base.cost_usd = typeof o.total_cost_usd === "number" ? o.total_cost_usd : null;
            if (o.is_error || o.subtype !== "success") {
              base.error = `CLI reported ${String(o.subtype)}: ${String(o.result ?? "").slice(0, 300)}`;
            }
          }
        }
        if (!sawResult) base.error ??= "no result frame in the stream — the call did not complete";
        const evor = base.tool_names.filter(isEvorMcpName);
        base.evor_calls = evor.length;
        base.malformed = [...new Set(evor.filter((n) => !n.startsWith(CANONICAL_PREFIX)))];
        base.ok = base.error === null;
        res(base);
      },
    );
  });
}

const REPEATS = Number(process.env.EVOR_LIVE_EVAL_REPEATS ?? 5);
const CONCURRENCY = Number(process.env.EVOR_LIVE_EVAL_CONCURRENCY ?? 5);
const TIMEOUT_MS = Number(process.env.EVOR_LIVE_EVAL_TIMEOUT_MS ?? 300_000);
const OUT = resolve(
  REPO_ROOT,
  process.env.EVOR_LIVE_EVAL_OUT ?? "docs/field-trace-v1.2.0/red/T7-live-eval-raw.json",
);

/** P(zero observations | true rate p, n draws) — the number that separates
 *  "not observed" from "absent". */
const pZero = (p: number, n: number) => Math.pow(1 - p, n);

describe.runIf(LIVE)("T7 live tool-name eval (EVOR_LIVE_EVAL=1)", () => {
  beforeAll(async () => {
    workdir = mkdtempSync(join(tmpdir(), "t7-live-eval-"));
    mkdirSync(join(workdir, "evor-root"), { recursive: true });
    writeFileSync(
      join(workdir, "mcp-config.json"),
      JSON.stringify({
        mcpServers: {
          [SERVER_KEY]: {
            command: "node",
            args: [resolve(REPO_ROOT, "mcp/dist/index.cjs")],
            env: { EVOR_ROOT: join(workdir, "evor-root") },
          },
        },
      }),
    );

    // One paired matrix: the same agent files and the same prompts, differing
    // only in --model. Interleaving the arms in one queue also keeps any
    // service-side drift from landing on one arm.
    const jobs: { role: string; task: string; arm: string; repeat: number }[] = [];
    for (let r = 0; r < REPEATS; r++) {
      for (const spec of ROLES) for (const arm of ARMS) {
        jobs.push({ role: spec.role, task: spec.task, arm, repeat: r });
      }
    }

    let next = 0;
    await Promise.all(
      Array.from({ length: Math.min(CONCURRENCY, jobs.length) }, async () => {
        for (;;) {
          const i = next++;
          if (i >= jobs.length) return;
          const j = jobs[i];
          const r = await runOne(j.role, j.task, j.arm, j.repeat);
          results.push(r);
          process.stdout.write(
            `  ${j.arm}/${j.role} #${j.repeat + 1}: ${r.ok ? "ok" : "ERR"} ` +
              `models=[${r.models.join(",")}] evor_calls=${r.evor_calls} ` +
              `malformed=${r.malformed.length} (${(r.wall_ms / 1000).toFixed(0)}s)\n`,
          );
        }
      }),
    );

    const byArm = Object.fromEntries(
      ARMS.map((a) => {
        const rows = results.filter((r) => r.arm === a);
        return [a, {
          n_calls: rows.length,
          n_ok: rows.filter((r) => r.ok).length,
          models: [...new Set(rows.flatMap((r) => r.models))],
          calls_with_a_tool_call: rows.filter((r) => r.evor_calls > 0).length,
          total_evor_tool_calls: rows.reduce((s, r) => s + r.evor_calls, 0),
          calls_with_a_malformed_name: rows.filter((r) => r.malformed.length > 0).length,
          malformed_names: [...new Set(rows.flatMap((r) => r.malformed))],
          total_cost_usd: rows.reduce((s, r) => s + (r.cost_usd ?? 0), 0),
        }];
      }),
    );
    writeFileSync(
      OUT,
      JSON.stringify(
        {
          generated_at: new Date().toISOString(),
          canonical_prefix: CANONICAL_PREFIX,
          repeats_per_role_per_arm: REPEATS,
          roles: ROLES.map((r) => r.role),
          power_note:
            `at lane D's observed base rate of 3/17 haiku agents (0.176), P(zero malformed | ` +
            `n=${results.filter((r) => r.arm === "haiku").length}) = ` +
            `${pZero(3 / 17, results.filter((r) => r.arm === "haiku").length).toFixed(3)}`,
          by_arm: byArm,
          records: results,
        },
        null,
        2,
      ),
    );
    process.stdout.write(`\n  wrote ${OUT}\n${JSON.stringify(byArm, null, 2)}\n`);
  }, 3_600_000);

  it("every call completed — an unreachable model is an error, not a pass", () => {
    const failed = results.filter((r) => !r.ok).map((r) => `${r.arm}/${r.role}#${r.repeat}: ${r.error}`);
    expect(results.length, "the matrix produced no records at all").toBeGreaterThan(0);
    expect(failed).toEqual([]);
  });

  it("the evor MCP server was attached to every call", () => {
    // The whole point: a tier number from a run with no server attached is a
    // number about a different task. This is the guard v1.2.0's corpus lacked.
    const detached = results
      .filter((r) => !r.mcp_tools_attached)
      .map((r) => `${r.arm}/${r.role}#${r.repeat}`);
    expect(detached, "these calls were graded with no evor tools available").toEqual([]);
  });

  it.each(ARMS)("%s: every call actually invoked a mandated evor tool", (arm) => {
    const rows = results.filter((r) => r.arm === arm);
    expect(rows.length, `no records for arm ${arm}`).toBeGreaterThan(0);
    const silent = rows
      .filter((r) => r.evor_calls === 0)
      .map((r) => `${r.role}#${r.repeat} (tools emitted: ${r.tool_names.join(", ") || "none"})`);
    expect(
      silent,
      `n=${rows.length} calls on ${arm}; these answered without calling any evor tool, so the ` +
        `role's contract was graded on prose. This is the P-04 failure mode reproduced live.`,
    ).toEqual([]);
  });

  it.each(ARMS)("%s: every emitted evor tool name carries the canonical prefix", (arm) => {
    const rows = results.filter((r) => r.arm === arm);
    const bad = rows
      .filter((r) => r.malformed.length)
      .map((r) => `${r.role}#${r.repeat}: ${r.malformed.join(", ")}`);
    expect(
      bad,
      `n=${rows.length} calls on ${arm}, ` +
        `${rows.reduce((s, r) => s + r.evor_calls, 0)} evor tool calls total. ` +
        `Canonical prefix: ${CANONICAL_PREFIX}. NOTE: an empty list here means NOT OBSERVED at ` +
        `this n, not absent — at lane D's 3/17 base rate, P(zero | n=${rows.length}) = ` +
        `${pZero(3 / 17, rows.length).toFixed(3)}.`,
    ).toEqual([]);
  });
});
