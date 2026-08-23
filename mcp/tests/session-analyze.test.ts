/**
 * mcp/tests/session-analyze.test.ts — Phase 2 instrumentation (RALPLAN-DR REV 5)
 *
 * Phase 2 is a hard gate: one clean tick, measured. Nothing measures it today —
 * the plan's observability section notes per-agent turns, tool calls, cache-read
 * tokens, cost and wall-clock are all uninstrumented.
 *
 * The trap this suite exists to pin: a session JSONL line is one CONTENT BLOCK,
 * not one turn, and the message-level `usage` object is stamped on EVERY block of
 * the same message. Summing naively multiplies both turn counts and token totals
 * by the average blocks-per-message. In the recorded run that factor is 553/287 =
 * 1.93x — an error large enough to flip a tier decision, since the opus→sonnet
 * break-even sits at +29% turn inflation.
 *
 * Cost weighting follows the Anthropic first-party schedule: cache-read is 0.1x
 * input, 5-minute cache-write is 1.25x input.
 */

import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { join, dirname, resolve } from "path";
import { fileURLToPath } from "url";
import { tmpdir } from "os";
import { spawnSync } from "child_process";

const SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), "../../scripts/session-analyze.mjs");

function analyze(lines: unknown[]) {
  const dir = mkdtempSync(join(tmpdir(), "evor-analyze-"));
  try {
    const file = join(dir, "session.jsonl");
    writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    const r = spawnSync(process.execPath, [SCRIPT, file], { encoding: "utf8", timeout: 60_000 });
    if (r.status !== 0) throw new Error(`analyzer failed: ${r.stderr}`);
    return JSON.parse(r.stdout);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** One assistant content block belonging to message `id`. */
function block(
  id: string,
  content: unknown[],
  // `usage` carries nested objects too (cache_creation, server_tool_use), not
  // just token counts.
  usage: Record<string, unknown>,
  extra: Record<string, unknown> = {},
) {
  // `model` belongs on the message, everything else on the record — otherwise a
  // model override lands at the top level where nothing reads it, and the case
  // silently measures the default model.
  const { model, ...rest } = extra as { model?: string };
  return {
    type: "assistant",
    timestamp: "2026-07-26T12:00:00.000Z",
    isSidechain: false,
    message: { id, model: model ?? "claude-opus-5", role: "assistant", content, usage },
    ...rest,
  };
}

const USAGE = {
  input_tokens: 10,
  output_tokens: 100,
  cache_read_input_tokens: 1_000,
  cache_creation_input_tokens: 50,
};

describe("session-analyze — turn and token accounting", () => {
  it("counts one turn per message id, not per content block", () => {
    const out = analyze([
      block("msg_1", [{ type: "text", text: "thinking" }], USAGE),
      block("msg_1", [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }], USAGE),
      block("msg_2", [{ type: "tool_use", id: "t2", name: "Read", input: {} }], USAGE),
    ]);
    expect(out.totals.turns, "3 blocks spanning 2 messages is 2 turns").toBe(2);
  });

  it("counts usage once per message id, not once per block", () => {
    const out = analyze([
      block("msg_1", [{ type: "text", text: "a" }], USAGE),
      block("msg_1", [{ type: "text", text: "b" }], USAGE),
      block("msg_1", [{ type: "text", text: "c" }], USAGE),
    ]);
    expect(out.totals.cache_read_input_tokens, "one message, counted once").toBe(1_000);
    expect(out.totals.output_tokens).toBe(100);
  });

  it("counts every tool call, even when several share one message", () => {
    const out = analyze([
      block("msg_1", [
        { type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } },
        { type: "tool_use", id: "t2", name: "Bash", input: { command: "pwd" } },
      ], USAGE),
    ]);
    // Tool calls are per block; turns are per message. Conflating them is what
    // produced the earlier "10 calls / 39 min" miscount.
    expect(out.totals.tool_calls).toBe(2);
    expect(out.totals.tools.Bash).toBe(2);
    expect(out.totals.turns).toBe(1);
  });

  it("separates the main session from sidechain subagents", () => {
    const out = analyze([
      block("msg_1", [{ type: "tool_use", id: "t1", name: "Bash", input: {} }], USAGE),
      block("msg_2", [{ type: "tool_use", id: "t2", name: "Read", input: {} }], USAGE, { isSidechain: true }),
    ]);
    expect(out.main.turns).toBe(1);
    expect(out.subagents.turns).toBe(1);
    expect(out.main.tools.Bash).toBe(1);
    expect(out.main.tools.Read).toBeUndefined();
  });

  it("prices cache reads at 0.1x input and cache writes at 1.25x", () => {
    const out = analyze([
      block("msg_1", [{ type: "text", text: "a" }], {
        input_tokens: 0,
        output_tokens: 0,
        cache_read_input_tokens: 1_000_000,
        cache_creation_input_tokens: 0,
      }),
    ]);
    // Opus 5 input is $5/Mtok, so 1M cache-read tokens = $0.50.
    expect(out.cost.by_model["claude-opus-5"]).toBeCloseTo(0.5, 5);
  });

  // ── Reconciled against what the CLI actually charged ──────────────────────
  //
  // Everything above (and the mirror suite in agent-eval.test.ts) checks this
  // analyzer against our own second copy of the same pricing table. On
  // 2026-08-21 the first external check was finally possible —
  // ci/out/bench-tick-raw.json carries per-model `costUSD` straight from the
  // CLI — and the analyzer was 38% low. These cases pin each cause with the
  // exact numbers from that envelope.

  it("takes the largest usage seen for a message id, not the first block's", () => {
    // The documented rule was "usage is stamped on every block of the same
    // message, so charge the first and skip the rest". True for the cache
    // fields — they reconciled to the token — and false for output_tokens,
    // which grows block by block. First-block-wins recorded 19,720 sonnet
    // output tokens against 142,226 billed, a 7.2x undercount; on haiku it was
    // 183 against 60,540. Max is exact wherever first-wins was exact, so it is
    // a strict improvement rather than a different guess.
    const out = analyze([
      block("msg_1", [{ type: "text", text: "a" }], {
        input_tokens: 10, output_tokens: 5,
        cache_read_input_tokens: 1_000, cache_creation_input_tokens: 200,
      }),
      block("msg_1", [{ type: "text", text: "b" }], {
        input_tokens: 10, output_tokens: 900,
        cache_read_input_tokens: 1_000, cache_creation_input_tokens: 200,
      }),
    ]);
    expect(out.totals.turns, "still one message, one turn").toBe(1);
    expect(out.totals.output_tokens).toBe(900);
    expect(out.totals.cache_read_input_tokens, "unchanged — max equals first here").toBe(1_000);
    expect(out.totals.cache_creation_input_tokens).toBe(200);
  });

  it("charges a 1-hour cache write at 2x input, not 1.25x", () => {
    // The opus main session wrote all 77,140 of its cache tokens at the 1h TTL.
    // At the flat 1.25x the analyzer modelled $1.481971; the CLI charged
    // $1.771245. 2x reproduces it to six decimals.
    const out = analyze([
      block("msg_1", [{ type: "text", text: "a" }], {
        input_tokens: 0, output_tokens: 0,
        cache_read_input_tokens: 0, cache_creation_input_tokens: 1_000_000,
        cache_creation: { ephemeral_1h_input_tokens: 1_000_000, ephemeral_5m_input_tokens: 0 },
      }),
    ]);
    // Opus input is $5/Mtok, so 1M tokens of 1h write = $10.
    expect(out.cost.by_model["claude-opus-5"]).toBeCloseTo(10.0, 5);
  });

  it("still charges a 5-minute cache write at 1.25x", () => {
    const out = analyze([
      block("msg_1", [{ type: "text", text: "a" }], {
        input_tokens: 0, output_tokens: 0,
        cache_read_input_tokens: 0, cache_creation_input_tokens: 1_000_000,
        cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 1_000_000 },
      }),
    ]);
    expect(out.cost.by_model["claude-opus-5"]).toBeCloseTo(6.25, 5);
  });

  it("assumes the 5-minute rate when no TTL split is reported", () => {
    const out = analyze([
      block("msg_1", [{ type: "text", text: "a" }], {
        input_tokens: 0, output_tokens: 0,
        cache_read_input_tokens: 0, cache_creation_input_tokens: 1_000_000,
      }),
    ]);
    expect(out.cost.by_model["claude-opus-5"]).toBeCloseTo(6.25, 5);
  });

  it("prices sonnet-5 at the $3/$15 list rate the CLI actually bills", () => {
    // The table applied a $2/$10 "introductory through 2026-08-31" rate. The
    // bench tick ran on 2026-08-21, inside that window, and the CLI charged
    // sonnet $12.486398 for 610 in / 142,226 out / 15,078,189 cache-read /
    // 1,554,059 cache-write. $3/$15 with a 1.25x write reproduces that figure
    // exactly; $2/$10 gives $8.324265. The introductory rate is documented but
    // is not what this account is charged, and assuming it understated the
    // largest line item in every measurement by a third.
    const out = analyze([
      block("msg_1", [{ type: "text", text: "a" }], {
        input_tokens: 610, output_tokens: 142_226,
        cache_read_input_tokens: 15_078_189, cache_creation_input_tokens: 1_554_059,
      }, { model: "claude-sonnet-5" }),
    ]);
    expect(out.cost.by_model["claude-sonnet-5"]).toBeCloseTo(12.486398, 5);
  });

  it("charges web searches, which were free in the model and are not", () => {
    // $0.01/request. Trivial next to the rest, but it was the last cent
    // standing between the model and the CLI's total.
    const out = analyze([
      block("msg_1", [{ type: "text", text: "a" }], {
        input_tokens: 0, output_tokens: 0,
        cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
        server_tool_use: { web_search_requests: 3 },
      }),
    ]);
    expect(out.cost.by_model["claude-opus-5"]).toBeCloseTo(0.03, 6);
  });

  it("reports wall-clock from first to last timestamp", () => {
    const out = analyze([
      { ...block("msg_1", [{ type: "text", text: "a" }], USAGE), timestamp: "2026-07-26T12:00:00.000Z" },
      { ...block("msg_2", [{ type: "text", text: "b" }], USAGE), timestamp: "2026-07-26T15:42:00.000Z" },
    ]);
    expect(out.wall_clock.seconds).toBe(3 * 3600 + 42 * 60);
  });

  it("survives malformed lines rather than aborting the analysis", () => {
    const dir = mkdtempSync(join(tmpdir(), "evor-analyze-bad-"));
    try {
      const file = join(dir, "s.jsonl");
      writeFileSync(file, ["{not json", JSON.stringify(block("msg_1", [{ type: "text", text: "a" }], USAGE))].join("\n"));
      const r = spawnSync(process.execPath, [SCRIPT, file], { encoding: "utf8", timeout: 60_000 });
      expect(r.status).toBe(0);
      const out = JSON.parse(r.stdout);
      expect(out.totals.turns).toBe(1);
      expect(out.malformed_lines).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("session-analyze — enforcement observability", () => {
  it("counts hook fires so an inert enforcement layer is visible", () => {
    const out = analyze([
      block("msg_1", [{ type: "text", text: "a" }], USAGE, { hookCount: 2 }),
      block("msg_2", [{ type: "text", text: "b" }], USAGE, { hookCount: 1 }),
      block("msg_3", [{ type: "text", text: "c" }], USAGE),
    ]);
    // Run 29d17abc's whole diagnosis was "the net wasn't weak, it was
    // disconnected" — a number that was never surfaced anywhere.
    expect(out.hooks.total_fires).toBe(3);
    expect(out.hooks.messages_with_hooks).toBe(2);
  });

  it("counts orchestrator Bash/Write/Edit — the AC2 number", () => {
    const out = analyze([
      block("msg_1", [{ type: "tool_use", id: "t1", name: "Bash", input: {} }], USAGE),
      block("msg_2", [{ type: "tool_use", id: "t2", name: "Write", input: {} }], USAGE),
      block("msg_3", [{ type: "tool_use", id: "t3", name: "Read", input: {} }], USAGE),
      block("msg_4", [{ type: "tool_use", id: "t4", name: "Bash", input: {} }], USAGE, { isSidechain: true }),
    ]);
    expect(out.ac2.orchestrator_leaf_tool_calls, "Bash+Write+Edit in main only").toBe(2);
  });

  it("flags spawns that pass `name` — the teammate-conversion root cause", () => {
    const out = analyze([
      block("msg_1", [{ type: "tool_use", id: "t1", name: "Agent", input: { subagent_type: "oh-my-evor:evor-sage", name: "sage-t1" } }], USAGE),
      block("msg_2", [{ type: "tool_use", id: "t2", name: "Agent", input: { subagent_type: "oh-my-evor:evor-forge" } }], USAGE),
    ]);
    expect(out.spawns.total).toBe(2);
    expect(out.spawns.named).toBe(1);
    expect(out.spawns.named_examples).toContain("oh-my-evor:evor-sage");
  });
});

describe("session-analyze — hook fires are counted where they actually land", () => {
  it("counts injected hook markers on attachment/user records, not just hookCount", () => {
    // The AC1 metric read `hookCount` on `assistant` records. Hook-injected text
    // actually lands on `attachment` and `user` records, which carry no hook*
    // field at all — so the metric reported 0 fires for a run with 42 injection
    // records across 17 transcripts. It was pointed at the wrong record type.
    const out = analyze([
      { type: "attachment", content: "[EVOR LAW] Use evor_* MCP tools to change evor state." },
      { type: "user", content: "[EVOR GOVERNOR] Evor is orchestrator-only." },
      { type: "attachment", content: "[EVOR CONTEXT] Active mission in progress." },
      block("msg_1", [{ type: "text", text: "ordinary turn" }], USAGE),
    ]);
    expect(out.hooks.total_fires).toBe(3);
  });

  it("does not count ordinary assistant text that merely mentions a hook", () => {
    const out = analyze([
      block("msg_1", [{ type: "text", text: "the governor would deny that" }], USAGE),
    ]);
    expect(out.hooks.total_fires).toBe(0);
  });
});
