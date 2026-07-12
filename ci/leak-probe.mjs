#!/usr/bin/env node
/**
 * leak-probe.mjs — BEHAVIORAL leak test with real headless Claude.
 *
 * Runs inside the container with the oh-my-evor plugin loaded (real evor_* MCP
 * tools + their descriptions in the agent's context). Each probe puts Claude in
 * one of the situations the agent-surface leaks used to corrupt, and checks the
 * agent's ACTUAL response for:
 *   - required tokens  (it reached for the right evor_* tool / the given name)
 *   - forbidden tokens (it fabricated an id, or proposed a raw shell-out / path)
 *
 * This is the real test of "did we fix it": the fix was the surface the agent
 * sees, so we ask a real agent what it does when it sees that surface.
 *
 * Auth: subscription creds mounted at ~/.claude/.credentials.json, or
 *       CLAUDE_CODE_OAUTH_TOKEN / ANTHROPIC_API_KEY in env.
 *
 * Output: ci/out/leak-probe-report.json  (+ a human table on stdout)
 */
import { spawnSync } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.env.EVOR_PLUGIN_DIR || "/plugin";
const OUT = join(ROOT, "ci", "out");

// ── Probes: one per leak class the sweep targeted ─────────────────────────────
const PROBES = [
  {
    id: "C4-no-shellout-tool-selection",
    klass: "C4 raw-CLI invitation / C3 path exposure",
    prompt: [
      "You are operating the oh-my-evor plugin, which exposes evor_* MCP tools.",
      "Answer in WORDS ONLY — do NOT call any tools. For each task give the ONE",
      "exact tool name OR shell command you would actually use, labelled a)–e):",
      "a) Check whether a launched training run has finished.",
      "b) Make a node's evaluate.py tamper-proof (immutable) before you score it.",
      "c) Read a finished node's evaluation result.",
      "d) Confirm a node actually wrote its result + telemetry output.",
      "e) Re-read the run's state after your context was compacted.",
    ].join(" "),
    // Each required token = the agent reached for the right tool.
    required: [
      { label: "a→evor_run_status", re: /evor_run_status/i },
      { label: "b→evor_lock_evaluate", re: /evor_lock_evaluate/i },
      { label: "c→evor_read_result", re: /evor_read_result/i },
      { label: "d→evor_verify_artifacts", re: /evor_verify_artifacts/i },
      { label: "e→evor_state_read", re: /evor_state_read/i },
    ],
    // Any forbidden token = the surface still steered it to a raw shell-out / path.
    forbidden: [
      { label: "tail -f", re: /tail\s+-f/i },
      { label: "sha256sum", re: /sha256sum/i },
      { label: "chmod", re: /\bchmod\b/i },
      { label: "cat <file>", re: /\bcat\s+[^\s]*\.(json|jsonl|log|py)/i },
      { label: ".evor/ path", re: /\.evor\/(runs|logs|state)/i },
      { label: "python -c", re: /python3?\s+-c\b/i },
    ],
  },
  {
    id: "C1-no-id-fabrication",
    klass: "C1 fabricated tokens / C2 carried tokens",
    prompt: [
      'You just called evor_record_node and it returned exactly: {"ok":true,"name":"immune-memory-02"}.',
      "You now need to record that node's evaluation via evor_record_eval, which takes a node identifier.",
      "Answer in WORDS ONLY — do not call tools. State (1) the EXACT identifier value you will pass",
      "and (2) where that value came from. Be literal and brief.",
    ].join(" "),
    required: [{ label: "uses the returned name", re: /immune-memory-02/ }],
    forbidden: [
      { label: "fabricated UUID", re: /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}/i },
      { label: "invents/generates an id", re: /(generate|invent|make\s*up|create)\s+(a\s+)?(new\s+)?(uuid|node[_\s-]?id|id\b)/i },
      { label: "claims it needs a separate id", re: /need\s+(a|the)\s+(node[_\s-]?id|uuid|internal id)/i },
    ],
  },
  {
    id: "C3-compaction-rehydrate-no-path",
    klass: "C3 internal-path exposure (compaction restore)",
    prompt: [
      "Your context was just compacted mid-run. A restore note says an oh-my-evor mission is active.",
      "Answer in WORDS ONLY — do not call tools. How do you recover the current run state so you can",
      "continue the tick loop? Name the exact mechanism you would use.",
    ].join(" "),
    required: [{ label: "evor_state_read", re: /evor_state_read/i }],
    forbidden: [
      { label: ".evor/ path", re: /\.evor\/(runs|logs|state)/i },
      { label: "cat/read a json file", re: /\b(cat|read)\b[^.]*\.(json|jsonl)\b/i },
      { label: "run_id token juggling", re: /(paste|remember|carry|reuse)\s+the\s+run[_\s-]?id/i },
    ],
  },
];

function runClaude(prompt) {
  const r = spawnSync(
    "claude",
    ["--plugin-dir", ROOT, "-p", prompt, "--output-format", "json", "--max-turns", "4"],
    { cwd: ROOT, encoding: "utf8", timeout: 240_000 },
  );
  let answer = (r.stdout || "").trim();
  try {
    const env = JSON.parse(answer);
    if (typeof env.result === "string") answer = env.result;
  } catch {
    /* not JSON — keep raw stdout */
  }
  return { answer, status: r.status, stderr: (r.stderr || "").slice(0, 400) };
}

function scoreProbe(p) {
  const { answer, status, stderr } = runClaude(p.prompt);
  const requiredHits = p.required.map((x) => ({ label: x.label, matched: x.re.test(answer) }));
  const forbiddenHits = p.forbidden.filter((x) => x.re.test(answer)).map((x) => x.label);
  const missingRequired = requiredHits.filter((h) => !h.matched).map((h) => h.label);
  const passed = missingRequired.length === 0 && forbiddenHits.length === 0;
  return {
    id: p.id,
    klass: p.klass,
    passed,
    required_matched: requiredHits.filter((h) => h.matched).map((h) => h.label),
    required_missing: missingRequired,
    leaks_found: forbiddenHits,
    exit_status: status,
    stderr: status === 0 ? undefined : stderr,
    answer,
  };
}

console.log("\n oh-my-evor — BEHAVIORAL leak probe (real headless Claude)\n");
const results = [];
for (const p of PROBES) {
  process.stdout.write(` ▶ ${p.id} … `);
  const res = scoreProbe(p);
  results.push(res);
  console.log(res.passed ? "PASS" : `FAIL  (missing: [${res.required_missing}]  leaks: [${res.leaks_found}])`);
}

const allPass = results.every((r) => r.passed);
mkdirSync(OUT, { recursive: true });
writeFileSync(
  join(OUT, "leak-probe-report.json"),
  JSON.stringify({ plugin: "oh-my-evor", verdict: allPass ? "PASS" : "FAIL", results }, null, 2),
);

console.log("\n ── behavior transcript ──");
for (const r of results) {
  console.log(`\n[${r.id}]  ${r.passed ? "PASS" : "FAIL"}  (${r.klass})`);
  if (r.required_missing.length) console.log(`  missing required: ${r.required_missing.join(", ")}`);
  if (r.leaks_found.length) console.log(`  LEAKS: ${r.leaks_found.join(", ")}`);
  console.log("  answer: " + r.answer.replace(/\n/g, "\n          ").slice(0, 900));
}
console.log(`\n verdict: ${allPass ? "PASS" : "FAIL"}   report: ci/out/leak-probe-report.json\n`);
process.exit(allPass ? 0 : 1);
