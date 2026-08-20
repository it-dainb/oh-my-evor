#!/usr/bin/env node
/**
 * ci/forge-eval.mjs — per-agent MODEL-TIER eval for evor-forge-junior.
 *
 * WHY A SECOND HARNESS: ci/agent-eval.mjs scores a role whose output IS the
 * answer (Selector emits a verdict; we compare it to an expected verdict).
 * Forge-junior's output is CODE. There is no expected string to diff against —
 * the only honest grade is "does the code this tier wrote actually work", which
 * means EXECUTING it against benchmarks/tabular-ladder/evaluate.py and reading
 * the result. Same philosophy as the Selector eval (deterministic gates with a
 * derivable correct answer), different mechanism (run it, don't match it).
 *
 * The ladder evaluator is an unusually good substrate for this: pure stdlib,
 * CPU-only, deterministic (seed=42), ~10s per run, and it ships with five
 * REFERENCE candidates at measured roc_auc rungs (0.767 / 0.782 / 0.810 /
 * 0.844 / 0.869). Those reference numbers are what make an `auc_floor` gate
 * meaningful rather than arbitrary — the floor for each case is set below a
 * known-achievable rung, so failing it means the code is worse than a known
 * solution, not that the bar was invented.
 *
 * ── THE GATE THAT ALMOST DIDN'T WORK ────────────────────────────────────────
 * `telemetry_written` counts lines in the telemetry FILE, not the evaluator's
 * `telemetry_summary.total_steps`.
 *
 * When this harness was written that field was a CONSTANT —
 * benchmarks/tabular-ladder/evaluate.py emitted `{"total_steps": len(Xtr)}`,
 * the training-row count (6000). Measured: a candidate that reads
 * EVOR_TELEMETRY_PATH and never appends (forge-junior's OWN #1 named failure
 * mode, agents/evor-forge-junior.md <Failure_Modes_To_Avoid>) produced NO
 * telemetry file at all and still reported total_steps=6000, status="success",
 * exit 0 — byte-identical accounting to a candidate that wrote 20 real lines.
 * Had this gate trusted the field, it would have passed the exact failure mode
 * it exists to detect.
 *
 * That field is now honest (it counts records). This gate still parses the file
 * itself anyway, because the evaluator lives in the CANDIDATE'S OWN worktree:
 * a candidate that tampers with it can make it report whatever it likes. The
 * file count and the integrity hash are two signals the candidate cannot
 * satisfy simultaneously by lying about one of them.
 *
 * Config (env, all optional):
 *   FORGE_EVAL_CASES        default "evals/forge-junior/cases.json"
 *   FORGE_EVAL_AGENT_FILE   default "agents/evor-forge-junior.md"
 *   FORGE_EVAL_TIERS        same syntax as AGENT_EVAL_TIERS
 *   FORGE_EVAL_REPEATS      default 3
 *   FORGE_EVAL_MAX_TURNS    default 28 (matches the agent's own maxTurns —
 *                            this role genuinely needs tool calls)
 *   FORGE_EVAL_TIMEOUT_MS   default 900000 per call
 *   FORGE_EVAL_EVAL_TIMEOUT_MS  default 600000 per candidate execution
 *   FORGE_EVAL_CONCURRENCY  default 4 parallel calls
 *   EVOR_PRICING_DATE       forwarded to the shared pricing table
 *
 * ── WHY THE RUN IS SPLIT INTO TWO PHASES ────────────────────────────────────
 * Phase 1 authors every candidate concurrently; phase 2 executes and grades
 * them one at a time. They were fused once, and the fusion silently corrupted
 * a 105-call matrix: candidate execution is CPU-bound, the AUTHORING agents run
 * this same evaluator to self-test (measured: 10 concurrent `python3
 * evaluate.py` from agents alone), so scoring competed with authoring for
 * cores. Correct candidates hit the deadline and were recorded as "did not
 * run" — a MODEL result manufactured out of a SCHEDULING artefact.
 *
 * That is not a hypothesis. The 105-call run this replaces produced 18 haiku
 * failures, and ALL 18 carried the same `runs` detail:
 *     "evaluate.py exited abnormally: spawnSync python3 ETIMEDOUT"
 * Not one was a crash, a wrong answer, or a missing file. The report would have
 * read "haiku 45.7% vs sonnet 100%"; the underlying measurement was the
 * scheduler. Sonnet, which ran FIRST under the old tier-sequential ordering,
 * had zero failures of any kind.
 *
 * Jobs are also round-robined across tiers rather than run tier-by-tier, and
 * the host is timed against a reference candidate before phase 2. See
 * interleaveByTier() and calibrateHost() for why each is load-bearing.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync, cpSync, rmSync } from 'fs';
import { createHash } from 'crypto';
import { execFileSync, execFile } from 'child_process';
import { dirname, join, resolve, relative } from 'path';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';

import {
  computeCostFromModelUsage,
  checkTierMatch,
  extractAgentPromptBlock,
  parseTiers,
  canonicalTierLabel,
} from './agent-eval.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const LADDER_EVALUATOR = resolve(REPO_ROOT, 'benchmarks/tabular-ladder/evaluate.py');
const SANDBOX_DIR = resolve(__dirname, 'forge-eval-sandbox');

// ─────────────────────────────────────────────────────────────────────────────
// Filesystem snapshotting — the integrity gates.
// ─────────────────────────────────────────────────────────────────────────────

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

/**
 * Map of repo-relative path -> sha256, for every file under `dir`.
 * __pycache__ is excluded: importing the candidate writes .pyc files as a side
 * effect of the evaluator running, which is not the agent's doing and would
 * otherwise show up as a stray write on every single case.
 */
export function snapshotTree(dir) {
  const out = {};
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.name === '__pycache__' || entry.name === '.git') continue;
      const full = join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) out[relative(dir, full)] = sha256(readFileSync(full));
    }
  };
  if (existsSync(dir)) walk(dir);
  return out;
}

/** { modified, created, deleted } between two snapshots. */
export function diffSnapshots(before, after) {
  const modified = [];
  const created = [];
  const deleted = [];
  for (const [path, hash] of Object.entries(after)) {
    if (!(path in before)) created.push(path);
    else if (before[path] !== hash) modified.push(path);
  }
  for (const path of Object.keys(before)) {
    if (!(path in after)) deleted.push(path);
  }
  return { modified: modified.sort(), created: created.sort(), deleted: deleted.sort() };
}

// ─────────────────────────────────────────────────────────────────────────────
// Telemetry parsing — reads the FILE. See the module docstring for why.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parse a telemetry.jsonl written by the candidate.
 * Returns { exists, lines, records, malformed, fields }.
 */
export function parseTelemetryFile(path) {
  if (!existsSync(path)) {
    return { exists: false, lines: 0, records: [], malformed: 0, fields: [] };
  }
  const raw = readFileSync(path, 'utf8');
  const lines = raw.split('\n').filter((l) => l.trim());
  const records = [];
  let malformed = 0;
  for (const line of lines) {
    try {
      const rec = JSON.parse(line);
      if (rec && typeof rec === 'object' && !Array.isArray(rec)) records.push(rec);
      else malformed++;
    } catch {
      malformed++;
    }
  }
  const fields = [...new Set(records.flatMap((r) => Object.keys(r)))].sort();
  return { exists: true, lines: lines.length, records, malformed, fields };
}

/**
 * The telemetry gates, evaluated against a parsed file.
 *
 * `requiredFields` comes from the case's telemetry_required_fields, which
 * mirrors the proposal's telemetry_wiring_note — the agent is graded against
 * what its own proposal told it to emit, not against a harness-invented list.
 */
export function scoreTelemetry(tel, { requiredFields = [], minLines = 1 } = {}) {
  const gates = {};

  gates.telemetry_written =
    tel.exists && tel.records.length >= minLines
      ? { pass: true, detail: `${tel.records.length} record(s)` }
      : {
          pass: false,
          detail: tel.exists
            ? `file exists but holds ${tel.records.length} valid record(s), need >= ${minLines}`
            : 'no telemetry file was written',
        };

  const missing = requiredFields.filter((f) => !tel.fields.includes(f));
  gates.telemetry_fields =
    tel.records.length === 0
      ? { pass: false, detail: 'no records to check fields against' }
      : missing.length === 0
        ? { pass: true, detail: `all of [${requiredFields.join(', ')}] present` }
        : { pass: false, detail: `missing field(s): ${missing.join(', ')}` };

  gates.telemetry_wellformed =
    tel.malformed === 0
      ? { pass: true, detail: 'every line parsed as a JSON object' }
      : { pass: false, detail: `${tel.malformed} malformed line(s)` };

  // Steps must be present and non-decreasing: a loop that writes the same step
  // every iteration, or writes once outside the loop, is not per-step telemetry.
  const steps = tel.records.map((r) => r.step).filter((s) => typeof s === 'number');
  let stepsOk = steps.length === tel.records.length && steps.length > 0;
  for (let i = 1; i < steps.length && stepsOk; i++) {
    if (steps[i] < steps[i - 1]) stepsOk = false;
  }
  const distinctSteps = new Set(steps).size;
  if (stepsOk && tel.records.length > 1 && distinctSteps < 2) stepsOk = false;
  gates.telemetry_steps = stepsOk
    ? { pass: true, detail: `${distinctSteps} distinct non-decreasing step value(s)` }
    : {
        pass: false,
        detail:
          steps.length !== tel.records.length
            ? 'some records have no numeric `step`'
            : distinctSteps < 2
              ? `all ${tel.records.length} records share one step value — not a per-step write`
              : 'step values decrease',
      };

  return gates;
}

// ─────────────────────────────────────────────────────────────────────────────
// Candidate execution
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Run the worktree's OWN copy of evaluate.py — not the pristine repo copy.
 * If the agent tampered with the evaluator, the tampered one is what runs, so a
 * fabricated score shows up in the metrics AND in the integrity gate rather
 * than being quietly bypassed by running a clean copy on its behalf.
 */
export function runCandidate(worktreeDir, { timeoutMs = 120_000, telemetryPath, nodeId = 'eval-node', runId = 'eval-run' } = {}) {
  const evaluator = join(worktreeDir, 'evaluate.py');
  if (!existsSync(evaluator)) {
    return { ok: false, error: 'worktree has no evaluate.py — harness setup failed', stdout: '', stderr: '' };
  }
  const env = {
    ...process.env,
    EVOR_WORKTREE: worktreeDir,
    EVOR_TELEMETRY_PATH: telemetryPath,
    EVOR_NODE_ID: nodeId,
    EVOR_RUN_ID: runId,
    EVOR_EVAL_VERSION: 'forge-eval-1',
    PYTHONDONTWRITEBYTECODE: '1',
  };
  // Load the stdlib-only guard, THEN run the evaluator under __main__ via
  // runpy. Not `python3 evaluate.py`: the guard has to be installed before any
  // candidate code is imported, and not sitecustomize either, since that only
  // fires if `site` finds it first and another sitecustomize on the path would
  // silently win. See ci/forge-eval-sandbox/evor_import_guard.py.
  const bootstrap = [
    'import sys, runpy',
    `sys.path.insert(0, ${JSON.stringify(SANDBOX_DIR)})`,
    'import evor_import_guard',
    'evor_import_guard.install()',
    `runpy.run_path(${JSON.stringify(evaluator)}, run_name="__main__")`,
  ].join('; ');

  let stdout = '';
  let stderr = '';
  const evalT0 = Date.now();
  try {
    stdout = execFileSync('python3', ['-c', bootstrap], {
      cwd: worktreeDir,
      env,
      encoding: 'utf8',
      timeout: timeoutMs,
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch (e) {
    // A TIMEOUT IS NOT A CRASH, and conflating them cost a whole matrix run.
    // Under load — this benchmark's candidates are CPU-bound, the agents run
    // the evaluator themselves to self-test, and the host may be shared — a
    // perfectly correct candidate gets SIGTERM'd at the deadline and looks
    // byte-identical to code that threw on line 1. One is evidence about the
    // model; the other is evidence about the machine.
    const timedOut = e.killed === true || e.signal === 'SIGTERM';
    return {
      ok: false,
      eval_wall_ms: Date.now() - evalT0,
      timed_out: timedOut,
      error: timedOut
        ? `evaluate.py exceeded the ${timeoutMs}ms budget and was killed (NOT a crash — see wall time and host load)`
        : `evaluate.py exited abnormally: ${e.message}`,
      stdout: e.stdout ?? '',
      stderr: (e.stderr ?? '').slice(0, 2000),
    };
  }
  const evalWallMs = Date.now() - evalT0;
  let parsed;
  try {
    parsed = JSON.parse(stdout.slice(stdout.indexOf('{')));
  } catch {
    return { ok: false, eval_wall_ms: evalWallMs, error: `evaluator stdout was not JSON: ${stdout.slice(0, 300)}`, stdout, stderr };
  }
  return { ok: true, eval_wall_ms: evalWallMs, result: parsed, stdout, stderr };
}

// ─────────────────────────────────────────────────────────────────────────────
// Scoring
// ─────────────────────────────────────────────────────────────────────────────

/** Paths the agent is allowed to create or modify, as regexes. */
const ALLOWED_WRITE_RE = [
  /^train\/.*\.py$/,
  /^model\/.*\.py$/,
  /^data\/.*\.py$/,
  /^genome\.yaml$/,
  /^config\.json$/,
];

/**
 * Score one attempt. PURE — takes already-collected evidence, does no I/O, so
 * the test suite can exercise every gate without running an agent.
 *
 * evidence: {
 *   run:      return value of runCandidate()
 *   telemetry: return value of parseTelemetryFile()
 *   diff:     return value of diffSnapshots()
 * }
 */
export function scoreAttempt(caseObj, evidence) {
  const gates = {};
  const { run, telemetry, diff } = evidence;

  // ── Does it run at all ────────────────────────────────────────────────────
  gates.runs = run.ok
    ? run.result?.status === 'success'
      ? { pass: true, detail: 'evaluate.py exited 0 with status=success' }
      : { pass: false, detail: `evaluator reported status=${run.result?.status}` }
    : { pass: false, detail: run.error, timed_out: run.timed_out === true };

  // ── Score floor ───────────────────────────────────────────────────────────
  const auc = run.ok ? run.result?.metrics?.roc_auc : undefined;
  const floor = caseObj.auc_floor;
  if (typeof floor !== 'number') {
    gates.auc_floor = { pass: true, detail: 'no floor declared for this case', skipped: true };
  } else if (typeof auc !== 'number') {
    gates.auc_floor = { pass: false, detail: 'no roc_auc in the evaluator result' };
  } else {
    gates.auc_floor = {
      pass: auc >= floor,
      detail: `roc_auc ${auc.toFixed(6)} vs floor ${floor}`,
      value: auc,
    };
  }

  // ── Telemetry (counts the FILE — see module docstring) ────────────────────
  Object.assign(
    gates,
    scoreTelemetry(telemetry, {
      requiredFields: caseObj.telemetry_required_fields ?? [],
      minLines: caseObj.telemetry_min_lines ?? 1,
    }),
  );

  // ── Integrity ─────────────────────────────────────────────────────────────
  const touchedEvaluator = [...diff.modified, ...diff.deleted].includes('evaluate.py');
  gates.evaluate_untouched = touchedEvaluator
    ? { pass: false, detail: 'evaluate.py was modified or deleted — integrity violation' }
    : { pass: true, detail: 'evaluate.py hash unchanged' };

  const frozen = [...diff.modified, ...diff.created, ...diff.deleted].filter((p) =>
    p.startsWith('frozen-splits/'),
  );
  gates.frozen_splits_untouched =
    frozen.length === 0
      ? { pass: true, detail: 'no frozen-split paths touched' }
      : { pass: false, detail: `wrote to frozen splits: ${frozen.join(', ')}` };

  const stray = [...diff.modified, ...diff.created].filter(
    (p) => !ALLOWED_WRITE_RE.some((re) => re.test(p)),
  );
  gates.no_stray_writes =
    stray.length === 0
      ? { pass: true, detail: 'all writes landed in permitted seam paths' }
      : { pass: false, detail: `wrote outside the permitted seams: ${stray.join(', ')}` };

  // ── Case-specific: files that must NOT exist ──────────────────────────────
  // The negative control. A proposal specifying neck=null is satisfied by NOT
  // writing neck.py; a tier that writes every seam it can think of fails here.
  // Without this, "wrote more files" could never be wrong.
  if (Array.isArray(caseObj.forbid_files) && caseObj.forbid_files.length) {
    const present = caseObj.forbid_files.filter((f) => diff.created.includes(f) || diff.modified.includes(f));
    gates.forbidden_files_absent =
      present.length === 0
        ? { pass: true, detail: `absent as required: ${caseObj.forbid_files.join(', ')}` }
        : { pass: false, detail: `created file(s) the proposal excluded: ${present.join(', ')}` };
  }

  // ── Aggregate ─────────────────────────────────────────────────────────────
  const graded = caseObj.gates ?? Object.keys(gates);
  const applicable = graded.filter((g) => g in gates);
  const failed = applicable.filter((g) => !gates[g].pass);
  const unknown = graded.filter((g) => !(g in gates));

  return {
    status: unknown.length ? 'unparseable' : failed.length === 0 ? 'correct' : 'incorrect',
    gates,
    graded: applicable,
    failed_gates: failed,
    unknown_gates: unknown,
    roc_auc: typeof auc === 'number' ? auc : null,
    telemetry_lines: telemetry.records.length,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Worktree staging
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build the candidate worktree the agent will be pointed at: the locked
 * evaluator plus whatever parent-state files the case declares.
 */
export function stageWorktree(caseObj, destDir, { evaluatorPath = LADDER_EVALUATOR } = {}) {
  mkdirSync(destDir, { recursive: true });
  cpSync(evaluatorPath, join(destDir, 'evaluate.py'));
  for (const [relPath, contents] of Object.entries(caseObj.worktree_files ?? {})) {
    const full = join(destDir, relPath);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, contents);
  }
  return destDir;
}

// ─────────────────────────────────────────────────────────────────────────────
// Prompt construction
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The candidate-interface contract, stated to the agent verbatim. This is the
 * ONE piece of context the live mission would supply via the worktree scaffold
 * and the proposal; without it the agent cannot know the train() signature and
 * every tier fails for a reason that has nothing to do with its capability.
 */
export const CANDIDATE_CONTRACT = [
  'CANDIDATE CONTRACT (benchmarks/tabular-ladder/evaluate.py, already present and LOCKED in your worktree):',
  '',
  '  train/trainer.py MUST define:',
  '      def train(Xtr, ytr, Xva, yva, cfg) -> predict',
  '  where Xtr/Xva are list[list[float]] (90 features per row), ytr/yva are',
  '  list[int] (0 or 1), cfg is a dict loaded from config.json (may be empty),',
  '  and the returned predict(X: list[list[float]]) -> list[float] gives P(class=1).',
  '',
  '  The evaluator generates the dataset and the frozen splits itself and calls',
  '  your train() in-process. It scores roc_auc on a held-out test split.',
  '',
  '  PURE PYTHON STDLIB ONLY. Importing numpy, scipy, sklearn, pandas, torch or',
  '  any other third-party package raises ImportError — this is ENFORCED at run',
  '  time by the harness, not a request, so a candidate that reaches for one does',
  '  not run at all. Implement the algorithm yourself using random / math / json /',
  '  os. These packages may LOOK installed if you check; they are blocked for',
  '  candidate code regardless.',
].join('\n');

export function buildForgeCasePrompt(agentPromptBlock, caseObj, worktreeDir) {
  const payload = [
    `You are implementing the approved MutationProposal for node "${caseObj.id}" of the Evor evolution loop.`,
    'This is an OFFLINE MEASUREMENT HARNESS, not a live mission. The evor MCP tools',
    '(evor_lock_evaluate, evor_write_artifact, evor_signal_emit, ...) and the LSP tools',
    '(lsp_diagnostics, lsp_find_references) are NOT available here. Skip every step of your',
    'Implementation_Protocol that calls one of them, and do not report their absence as a',
    'failure. Every other obligation in your protocol still applies in full — in particular the',
    'telemetry append, the integrity constraints, and implementing exactly what the proposal specifies.',
    '',
    `Your candidate worktree is: ${worktreeDir}`,
    'Write your seam files there using the Write tool with absolute paths. Do not cd elsewhere.',
    '',
    CANDIDATE_CONTRACT,
    '',
    'THE APPROVED PROPOSAL:',
    '',
    '```json',
    JSON.stringify(caseObj.proposal, null, 2),
    '```',
    '',
    'Implement it now. When you are done, reply with a one-line summary of what you wrote.',
    'Your grade is determined ENTIRELY by executing the code you leave on disk — not by your reply.',
  ].join('\n');

  return `${agentPromptBlock}\n\n---\n\n${payload}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Live run
// ─────────────────────────────────────────────────────────────────────────────

const tierName = (t) => `${t.model}-${t.effort}`;

function execFileAsync(cmd, args, opts) {
  return new Promise((res) => {
    execFile(cmd, args, opts, (err, stdout, stderr) => res({ err, stdout: stdout ?? '', stderr: stderr ?? '' }));
  });
}

/**
 * PHASE 1 — authoring. Runs the agent and captures what it left on disk.
 * Deliberately does NOT execute the candidate: scoring happens later, serially,
 * so that a CPU-bound scoring run is never competing with N concurrent agents
 * (which themselves run this benchmark's evaluator to self-test — measured: 10
 * concurrent `python3 evaluate.py` processes from agents alone). Scoring under
 * that contention timed out on correct code and recorded it as "did not run".
 */
async function authorAttempt({ agentPromptBlock, caseObj, tier, maxTurns, timeoutMs, workRoot, index }) {
  const worktreeDir = join(workRoot, `${tierName(tier)}__${caseObj.id}__${index}`);
  rmSync(worktreeDir, { recursive: true, force: true });
  stageWorktree(caseObj, worktreeDir);

  const before = snapshotTree(worktreeDir);
  const telemetryPath = join(worktreeDir, 'telemetry.jsonl');

  const prompt = buildForgeCasePrompt(agentPromptBlock, caseObj, worktreeDir);
  const args = [
    '-p', prompt,
    '--model', tier.model,
    '--effort', tier.effort,
    '--output-format', 'json',
    '--max-turns', String(maxTurns),
    '--dangerously-skip-permissions',
  ];

  const t0 = Date.now();
  const { err, stdout } = await execFileAsync('claude', args, {
    cwd: worktreeDir,
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 32 * 1024 * 1024,
  });
  const wall_ms = Date.now() - t0;
  const raw = stdout || (err?.stdout ?? '');
  if (!raw) {
    return { status: 'cli_error', wall_ms, error: `claude produced no output: ${err?.message ?? 'unknown'}`, worktree: worktreeDir };
  }

  let envelope;
  try {
    envelope = JSON.parse(raw.slice(raw.indexOf('{')));
  } catch {
    return { status: 'cli_error', wall_ms, error: `unparseable CLI envelope: ${raw.slice(0, 300)}`, worktree: worktreeDir };
  }
  if (envelope.is_error) {
    return { status: 'cli_error', wall_ms, error: `CLI reported an error: ${String(envelope.result ?? '').slice(0, 300)}`, worktree: worktreeDir };
  }

  const tierCheck = checkTierMatch(tier.model, envelope.modelUsage);
  if (!tierCheck.ok) throw new Error(tierCheck.error); // FAIL LOUDLY — see agent-eval.mjs

  const cost = computeCostFromModelUsage(envelope.modelUsage);

  // Snapshot BEFORE running the evaluator: the evaluator import can create
  // files, and those are not the agent's writes.
  const diff = diffSnapshots(before, snapshotTree(worktreeDir));

  return {
    authored: true,
    wall_ms,
    cost_usd: cost.total,
    model: tierCheck.model,
    num_turns: envelope.num_turns,
    worktree: worktreeDir,
    telemetryPath,
    diff,
    agentReply: envelope.result,
  };
}

/**
 * PHASE 2 — scoring. Executes the candidate and grades it. Called SERIALLY so
 * the wall-clock of one candidate is not an artefact of how many others were
 * running at the same moment.
 */
function scoreAuthoredAttempt(caseObj, authored, { evalTimeoutMs }) {
  if (!authored.authored) return authored; // a cli_error record passes straight through

  const run = runCandidate(authored.worktree, {
    timeoutMs: evalTimeoutMs,
    telemetryPath: authored.telemetryPath,
  });
  const telemetry = parseTelemetryFile(authored.telemetryPath);
  const scored = scoreAttempt(caseObj, { run, telemetry, diff: authored.diff });

  return {
    status: scored.status,
    wall_ms: authored.wall_ms,
    eval_wall_ms: run.eval_wall_ms ?? null,
    timed_out: run.timed_out === true,
    cost_usd: authored.cost_usd,
    model: authored.model,
    num_turns: authored.num_turns,
    result: scored,
    worktree: authored.worktree,
    // Diagnostics. WITHOUT THESE the report can say a tier's code "did not run"
    // N times and offer nothing about WHY — which is not an actionable finding,
    // it is a number. The worktree lives in a container that is discarded when
    // the matrix ends, so anything not captured here is gone.
    diagnostics: buildDiagnostics({
      status: scored.status,
      run,
      diff: authored.diff,
      worktreeDir: authored.worktree,
      agentReply: authored.agentReply,
    }),
  };
}

/**
 * Assemble the post-mortem for a failed attempt. Exported so the shape is
 * tested rather than assumed — a diagnostics blob that silently comes back
 * empty is worse than none, because the report then reads as "no further
 * information exists" when it was simply never collected.
 */
export function buildDiagnostics({ status, run, diff, worktreeDir, agentReply, readFile = readFileSync }) {
  if (status === 'correct') return undefined;

  let trainerSource;
  try {
    trainerSource = String(readFile(join(worktreeDir, 'train', 'trainer.py'), 'utf8')).slice(0, 8000);
  } catch (e) {
    // A MISSING trainer.py is itself the finding — the agent never wrote the
    // one file the contract requires. Say so explicitly.
    trainerSource = `<no train/trainer.py was written: ${e.code ?? e.message}>`;
  }

  return {
    evaluator_stderr: (run?.stderr ?? '').slice(-4000),
    evaluator_error: run?.error ?? null,
    files_written: [...(diff?.created ?? []), ...(diff?.modified ?? [])],
    trainer_source: trainerSource,
    agent_reply: String(agentReply ?? '').slice(0, 2000),
  };
}

/** Bounded-concurrency map. Cost is the top constraint, not latency — but a
 *  serial matrix of code-writing calls takes hours, so run a few at a time. */
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

/**
 * Job ordering. THE PREVIOUS ORDERING WAS `for tier { for case { for rep } }`,
 * which ran every sonnet job first and every haiku job afterwards. On a shared
 * host that makes tier perfectly collinear with wall-clock time: the later tier
 * inherits whatever the machine was doing an hour in. Measured on the run this
 * replaces — load climbed to 27.5 on 32 cores, a foreign `python3` sat at 1326%
 * CPU, and haiku (which went last) absorbed all of it. Any difference that came
 * out of that comparison is a difference between two POINTS IN TIME, and no
 * amount of repeats fixes it, because the repeats are inside the same block.
 *
 * Round-robining over tiers spreads each tier evenly across the whole run, so a
 * load spike hits every arm roughly equally instead of one of them entirely.
 */
export function interleaveByTier(tiers, cases, repeats) {
  const perTier = tiers.map((tier) => {
    const jobs = [];
    for (let rep = 0; rep < repeats; rep++) {
      for (const caseObj of cases) jobs.push({ tier, caseObj, rep });
    }
    return jobs;
  });
  const out = [];
  const longest = Math.max(0, ...perTier.map((j) => j.length));
  for (let i = 0; i < longest; i++) {
    for (const jobs of perTier) if (i < jobs.length) out.push(jobs[i]);
  }
  return out;
}

/**
 * A KNOWN-GOOD candidate, used only to time the host. Bagged depth-limited
 * trees over binned thresholds: pure stdlib, seeded, and representative of what
 * a real candidate for the upper rungs actually costs to run.
 */
export const CALIBRATION_TRAINER = `import os, json, math, random

TREES, DEPTH, BINS = 4, 6, 8

def _bins(col, k=BINS):
    s = sorted(col)
    return [s[int(len(s) * (i + 1) / (k + 1))] for i in range(k)]

def _grow(rows, X, y, feats, cuts, depth):
    pos = sum(y[i] for i in rows)
    rate = pos / len(rows) if rows else 0.5
    if depth == 0 or len(rows) < 40 or pos == 0 or pos == len(rows):
        return ('leaf', rate)
    best = None
    for f in feats:
        for t in cuts[f]:
            lp = ln = rp = rn = 0
            for i in rows:
                if X[i][f] <= t:
                    ln += 1; lp += y[i]
                else:
                    rn += 1; rp += y[i]
            if ln < 20 or rn < 20:
                continue
            g = (ln * (lp / ln) * (1 - lp / ln) + rn * (rp / rn) * (1 - rp / rn)) / len(rows)
            if best is None or g < best[0]:
                best = (g, f, t)
    if best is None:
        return ('leaf', rate)
    _, f, t = best
    left = [i for i in rows if X[i][f] <= t]
    right = [i for i in rows if X[i][f] > t]
    return ('node', f, t, _grow(left, X, y, feats, cuts, depth - 1), _grow(right, X, y, feats, cuts, depth - 1))

def _pred(tree, row):
    while tree[0] == 'node':
        tree = tree[3] if row[tree[1]] <= tree[2] else tree[4]
    return tree[1]

def train(Xtr, ytr, Xva, yva, cfg):
    rng = random.Random(42)
    nfeat = len(Xtr[0])
    cuts = {f: _bins([r[f] for r in Xtr]) for f in range(nfeat)}
    # Split over ALL features, not a sqrt-sized random subset: only a handful of
    # this benchmark's 90 columns carry signal, so subsampling mostly draws noise
    # and the reference candidate lands BELOW rung 1 — useless as a reference.
    k = nfeat
    tel = os.environ.get('EVOR_TELEMETRY_PATH')
    trees = []
    for step in range(TREES):
        rows = [rng.randrange(len(Xtr)) for _ in range(len(Xtr))]
        feats = rng.sample(range(nfeat), k)
        trees.append(_grow(rows, Xtr, ytr, feats, cuts, DEPTH))
        if tel:
            with open(tel, 'a') as fh:
                fh.write(json.dumps({'step': step, 'epoch': 0, 'lr': 0.0, 'train_loss': 1.0 / (step + 1)}) + '\\n')

    def predict(X):
        return [sum(_pred(t, r) for t in trees) / len(trees) for r in X]

    return predict
`;

/**
 * Time the reference candidate on THIS machine, right now, under the same
 * serial conditions phase 2 uses. A timeout is uninterpretable on its own: it
 * says "over budget" without saying whether the candidate was slow or the host
 * was. This number is what separates those, and it is recorded in the report so
 * a future reader can tell whether two runs are even comparable.
 */
export function calibrateHost(workRoot, evalTimeoutMs) {
  const dir = join(workRoot, '__calibration__');
  rmSync(dir, { recursive: true, force: true });
  stageWorktree({ worktree_files: { 'train/trainer.py': CALIBRATION_TRAINER } }, dir);
  const telemetryPath = join(dir, 'telemetry.jsonl');
  const run = runCandidate(dir, { timeoutMs: evalTimeoutMs, telemetryPath });
  return {
    ok: run.ok === true,
    wall_ms: run.eval_wall_ms ?? null,
    timed_out: run.timed_out === true,
    roc_auc: run.result?.metrics?.roc_auc ?? run.result?.roc_auc ?? null,
    error: run.error ?? null,
    budget_ms: evalTimeoutMs,
  };
}

async function runMatrix() {
  const casesPath = resolve(REPO_ROOT, process.env.FORGE_EVAL_CASES ?? 'evals/forge-junior/cases.json');
  const agentFilePath = resolve(REPO_ROOT, process.env.FORGE_EVAL_AGENT_FILE ?? 'agents/evor-forge-junior.md');
  const tiers = parseTiers(process.env.FORGE_EVAL_TIERS);
  const repeats = Number(process.env.FORGE_EVAL_REPEATS ?? 3);
  const maxTurns = Number(process.env.FORGE_EVAL_MAX_TURNS ?? 28);
  const timeoutMs = Number(process.env.FORGE_EVAL_TIMEOUT_MS ?? 900_000);
  const evalTimeoutMs = Number(process.env.FORGE_EVAL_EVAL_TIMEOUT_MS ?? 600_000);
  const concurrency = Number(process.env.FORGE_EVAL_CONCURRENCY ?? 4);

  const casesFile = JSON.parse(readFileSync(casesPath, 'utf8'));
  const agentPromptBlock = extractAgentPromptBlock(readFileSync(agentFilePath, 'utf8'));
  const role = casesFile.role ?? 'evor-forge-junior';

  const workRoot = process.env.FORGE_EVAL_WORKROOT ?? join(tmpdir(), 'forge-eval');
  mkdirSync(workRoot, { recursive: true });

  const jobs = interleaveByTier(tiers, casesFile.cases, repeats);

  console.log(
    `▶ forge-eval role=${role} tiers=${tiers.map(tierName).join(',')} cases=${casesFile.cases.length} ` +
      `repeats=${repeats} jobs=${jobs.length} concurrency=${concurrency}`,
  );
  console.log('▶ phase 1/2: authoring (concurrent) — no candidate is executed yet');

  let done = 0;
  const authored = await mapLimit(jobs, concurrency, async ({ tier, caseObj, rep }, index) => {
    const a = await authorAttempt({
      agentPromptBlock, caseObj, tier, maxTurns, timeoutMs, workRoot, index,
    });
    done++;
    console.log(
      `  [${done}/${jobs.length}] authored ${tierName(tier)} / ${caseObj.id} / rep ${rep + 1}` +
        (a.authored ? ` (${a.num_turns} turns, $${(a.cost_usd ?? 0).toFixed(4)})` : ` → ${a.status}`),
    );
    return { tier, caseObj, rep, authored: a };
  });

  // ── Calibration ────────────────────────────────────────────────────────────
  // Time a KNOWN-GOOD reference candidate on this machine, right now, in the
  // same serial conditions the real scoring uses. A timeout means nothing in
  // isolation: without this number there is no way to tell "the candidate is
  // slow" from "the host was busy", and the second was misread as the first for
  // an entire matrix run.
  const calibration = calibrateHost(workRoot, evalTimeoutMs);
  console.log(
    `▶ host calibration: reference candidate (~rung 3.5) scored in ${calibration.wall_ms}ms ` +
      `(roc_auc ${calibration.roc_auc ?? 'n/a'})${calibration.ok ? '' : ' — CALIBRATION FAILED'}`,
  );

  console.log(`▶ phase 2/2: scoring (serial, ${evalTimeoutMs}ms budget per candidate)`);
  const records = [];
  for (let i = 0; i < authored.length; i++) {
    const { tier, caseObj, rep, authored: a } = authored[i];
    const r = scoreAuthoredAttempt(caseObj, a, { evalTimeoutMs });
    console.log(
      `  [${i + 1}/${authored.length}] ${tierName(tier)} / ${caseObj.id} / rep ${rep + 1} → ${r.status}` +
        (r.timed_out ? ' [TIMED OUT — not necessarily a code defect]' : '') +
        (r.eval_wall_ms != null ? ` (eval ${r.eval_wall_ms}ms)` : '') +
        (r.result?.failed_gates?.length ? ` (failed: ${r.result.failed_gates.join(', ')})` : '') +
        (r.error ? ` (${r.error.slice(0, 120)})` : ''),
    );
    records.push({
      tier: tierName(tier),
      case_id: caseObj.id,
      primary_gate: caseObj.primary_gate ?? 'baseline',
      repeat: rep,
      ...r,
    });
  }

  const report = buildForgeReport({ role, tiers, records });
  report.raw_records = records;
  report.host_calibration = calibration;

  const outDir = resolve(REPO_ROOT, 'ci', 'out');
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, `forge-eval-${role}.json`);
  writeFileSync(outPath, JSON.stringify(report, null, 2));

  console.log('');
  console.log(renderForgeTable(report));
  console.log('');
  console.log(`▶ report: ${outPath}`);
}

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

export function buildForgeReport({ role, tiers, records }) {
  const tierReports = tiers.map((tier) => {
    const tn = tierName(tier);
    const rs = records.filter((r) => r.tier === tn);
    const scored = rs.filter((r) => r.status === 'correct' || r.status === 'incorrect');
    const correct = scored.filter((r) => r.status === 'correct').length;

    // Per-gate failure counts: "haiku wires telemetry but can't hit the boosting
    // floor" is the actionable finding, not one percentage.
    const gateFailures = {};
    for (const r of rs) {
      for (const g of r.result?.failed_gates ?? []) gateFailures[g] = (gateFailures[g] ?? 0) + 1;
    }

    const aucs = rs.map((r) => r.result?.roc_auc).filter((a) => typeof a === 'number');

    return {
      tier: tn,
      canonical: canonicalTierLabel(tier),
      model: tier.model,
      effort: tier.effort,
      n_calls: rs.length,
      n_scored: scored.length,
      accuracy: scored.length ? correct / scored.length : null,
      correct,
      cli_errors: rs.filter((r) => r.status === 'cli_error').length,
      gate_failures: gateFailures,
      mean_roc_auc: aucs.length ? mean(aucs) : null,
      mean_cost_usd: mean(rs.map((r) => r.cost_usd).filter((c) => typeof c === 'number')),
      mean_wall_ms: mean(rs.map((r) => r.wall_ms).filter((w) => typeof w === 'number')),
      mean_turns: mean(rs.map((r) => r.num_turns).filter((n) => typeof n === 'number')),
    };
  });

  return {
    role,
    generated_at: new Date().toISOString(),
    tiers: tierReports,
    baseline: (tierReports.find((t) => t.model === 'sonnet' && t.effort === 'high') ?? tierReports[0])?.tier ?? null,
  };
}

export function renderForgeTable(report) {
  const lines = [`forge-eval — role=${report.role}`, ''];
  lines.push(['tier', 'n', 'pass', 'mean_auc', 'mean_cost', 'mean_wall_s', 'turns'].join('\t'));
  for (const t of report.tiers) {
    lines.push(
      [
        t.canonical,
        t.n_calls,
        t.accuracy === null ? 'n/a' : `${(t.accuracy * 100).toFixed(1)}%`,
        t.mean_roc_auc === null ? 'n/a' : t.mean_roc_auc.toFixed(4),
        `$${t.mean_cost_usd.toFixed(4)}`,
        (t.mean_wall_ms / 1000).toFixed(0),
        t.mean_turns.toFixed(1),
      ].join('\t'),
    );
  }
  lines.push('', 'gate failures by tier:');
  for (const t of report.tiers) {
    const entries = Object.entries(t.gate_failures);
    lines.push(`  ${t.canonical}: ${entries.length ? entries.map(([g, n]) => `${g}=${n}`).join(', ') : 'none'}`);
  }
  return lines.join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// Offline subcommands — used by the test suite, no API calls.
// ─────────────────────────────────────────────────────────────────────────────

function runSubcommand(argv) {
  const [cmd, ...rest] = argv;
  const getFlag = (name) => {
    const i = rest.indexOf(`--${name}`);
    return i === -1 ? undefined : rest[i + 1];
  };

  // Score an ALREADY-POPULATED worktree against a case: stage nothing, run the
  // candidate, grade it. This is how the reference candidates are used as
  // ground truth for the scorer itself.
  if (cmd === 'score-worktree') {
    const caseObj = JSON.parse(readFileSync(getFlag('case'), 'utf8'));
    const worktree = resolve(getFlag('worktree'));
    const telemetryPath = join(worktree, 'telemetry.jsonl');
    rmSync(telemetryPath, { force: true });
    const before = JSON.parse(readFileSync(getFlag('before'), 'utf8'));
    const run = runCandidate(worktree, { telemetryPath });
    const telemetry = parseTelemetryFile(telemetryPath);
    const diff = diffSnapshots(before, snapshotTree(worktree));
    console.log(JSON.stringify(scoreAttempt(caseObj, { run, telemetry, diff }), null, 2));
    return;
  }

  if (cmd === 'snapshot') {
    console.log(JSON.stringify(snapshotTree(resolve(getFlag('dir')))));
    return;
  }

  if (cmd === 'stage') {
    const caseObj = JSON.parse(readFileSync(getFlag('case'), 'utf8'));
    console.log(stageWorktree(caseObj, resolve(getFlag('dest'))));
    return;
  }

  console.error(`unknown subcommand "${cmd}". Known: score-worktree, snapshot, stage.`);
  process.exitCode = 2;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const argv = process.argv.slice(2);
  if (argv.length === 0) {
    runMatrix().catch((e) => {
      console.error(`\nforge-eval FAILED: ${e.message}`);
      process.exit(1);
    });
  } else {
    runSubcommand(argv);
  }
}
