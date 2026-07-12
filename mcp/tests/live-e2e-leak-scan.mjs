#!/usr/bin/env node
/**
 * LIVE e2e: spawn the REAL built dist/index.cjs over JSON-RPC (stdio) and
 *   (1) scan every tool description + param description for agent-surface leaks,
 *   (2) confirm the two new root-fix tools are registered and actually work live,
 *   (3) assert their responses are name-only / path-free.
 *
 * This catches what vitest (which imports TS directly) cannot: the built .cjs,
 * real tool registration, real schema wiring, real JSON-RPC round-trips.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const DIST = join(fileURLToPath(new URL(".", import.meta.url)), "..", "dist", "index.cjs");

// ── Temp EVOR_ROOT with a materialized node + run for live tool calls ──────────
const root = mkdtempSync(join(tmpdir(), "evor-live-e2e-"));
const MISSION = "m1";
const RUN = "run-live-1";
const NODE = "immune-memory-02";
// evaluate.py for evor_lock_evaluate
const wt = join(root, "worktrees", NODE);
mkdirSync(wt, { recursive: true });
writeFileSync(join(wt, "evaluate.py"), "print('eval')\n", "utf8");
// results + telemetry for evor_verify_artifacts
const nodeDir = join(root, "runs", MISSION, RUN, "nodes", NODE);
mkdirSync(nodeDir, { recursive: true });
writeFileSync(join(nodeDir, "results.json"), JSON.stringify({ score: 0.9 }), "utf8");
writeFileSync(join(nodeDir, "telemetry.jsonl"), '{"step":1}\n', "utf8");

const child = spawn("node", [DIST], {
  stdio: ["pipe", "pipe", "pipe"],
  env: { ...process.env, EVOR_ROOT: root, EVOR_MISSION_ID: MISSION, EVOR_ACTIVE_RUN_ID: RUN },
});

let buf = "";
const pending = new Map();
child.stdout.on("data", (d) => {
  buf += d.toString();
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id != null && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  }
});
child.stderr.on("data", () => { /* server logs — ignore */ });

let idc = 0;
function rpc(method, params) {
  const id = ++idc;
  return new Promise((resolve, reject) => {
    pending.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    setTimeout(() => reject(new Error(`timeout on ${method}`)), 15000);
  });
}

const fail = [];
const pass = [];
function check(name, cond, detail = "") {
  (cond ? pass : fail).push(name + (detail ? ` — ${detail}` : ""));
}

// ── Leak patterns that must NEVER appear on the agent-facing surface ───────────
// (raw-CLI invitations, internal-path exposure, mechanism/jargon leaks)
const LEAK_RULES = [
  [/tail\s+-f/i, "tail -f invitation"],
  [/sha256sum/i, "sha256sum invitation"],
  [/\bchmod\b/i, "chmod invitation"],
  [/python\s+-c/i, "python -c invitation"],
  [/\.evor\/(runs|logs|state)/i, "internal .evor path"],
  [/\b\w+_path\b/i, "*_path field name leak"],
  [/\b(zod|pydantic)\b/i, "schema-lib jargon leak"],
  [/_bridge\.py/i, "bridge filename leak"],
  [/<\s*run_dir\s*>/i, "<run_dir> placeholder leak"],
  // Internal state filenames the agent should never see (evaluate.py is a genuine
  // user-facing genome artifact, so it is deliberately NOT in this list).
  [/\b(signals\.jsonl|tree\.json|goal-contract\.json|run-state\.json|findings\.json|proposals\.json|verdict\.json|forge-report\.json|telemetry\.jsonl|results\.json)\b/i, "internal state filename leak"],
];
// Legit substrings that would false-positive on the *_path rule — none expected
// on descriptions, but allow explicit run_dir INPUT param mentions in prose.
const PATH_ALLOW = [];

async function main() {
  await rpc("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "live-e2e", version: "0" },
  });
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

  const listed = await rpc("tools/list", {});
  const tools = listed?.result?.tools ?? [];
  check("tools/list returns tools", tools.length > 20, `got ${tools.length}`);

  // (1) Full agent-surface leak scan over every tool.
  for (const t of tools) {
    const surfaces = [t.description ?? ""];
    const props = t.inputSchema?.properties ?? {};
    for (const [pname, p] of Object.entries(props)) {
      surfaces.push(pname);                    // param NAME
      surfaces.push(p?.description ?? "");      // param description
    }
    const blob = surfaces.join("\n");
    for (const [re, label] of LEAK_RULES) {
      const m = blob.match(re);
      if (m && !PATH_ALLOW.some((a) => blob.includes(a))) {
        fail.push(`LEAK in ${t.name}: ${label} → "${m[0]}"`);
      }
    }
  }
  if (!fail.some((f) => f.startsWith("LEAK"))) pass.push("no leaks across full tool surface");

  const byName = new Map(tools.map((t) => [t.name, t]));

  // (2) Both root-fix tools registered.
  check("evor_lock_evaluate registered", byName.has("evor_lock_evaluate"));
  check("evor_verify_artifacts registered", byName.has("evor_verify_artifacts"));
  // Param must be `node` not `node_id` (no id re-leak).
  const le = byName.get("evor_lock_evaluate");
  check("lock_evaluate uses `node` param (not node_id)",
    le && le.inputSchema?.properties?.node && !le.inputSchema?.properties?.node_id);

  // (3) LIVE calls — real JSON-RPC round-trip against the built server.
  const lock = await rpc("tools/call", {
    name: "evor_lock_evaluate", arguments: { run_id: RUN, node: NODE },
  });
  const lockText = lock?.result?.content?.[0]?.text ?? "";
  const lockObj = JSON.parse(lockText || "{}");
  check("lock_evaluate live ok", lockObj.ok === true, lockText);
  check("lock_evaluate returns node_name", lockObj.node_name === NODE);
  check("lock_evaluate response has no sha256", !/[a-f0-9]{64}/.test(lockText));
  check("lock_evaluate response has no path", !lockText.includes("/"));

  const verify = await rpc("tools/call", {
    name: "evor_verify_artifacts", arguments: { run_id: RUN, node: NODE },
  });
  const vText = verify?.result?.content?.[0]?.text ?? "";
  const vObj = JSON.parse(vText || "{}");
  check("verify_artifacts live ok", vObj.ok === true, vText);
  check("verify_artifacts booleans present",
    vObj.has_results === true && vObj.has_telemetry === true);
  check("verify_artifacts response has no path", !vText.includes("/"));

  // ── Report ──
  console.log(`\nPASS (${pass.length}):`);
  for (const p of pass) console.log("  ✓ " + p);
  if (fail.length) {
    console.log(`\nFAIL (${fail.length}):`);
    for (const f of fail) console.log("  ✗ " + f);
  }
  child.kill();
  process.exit(fail.length ? 1 : 0);
}

main().catch((e) => { console.error("E2E ERROR:", e.message); child.kill(); process.exit(2); });
