#!/usr/bin/env node
/**
 * oh-my-evor PreToolUse hook — CAPABILITY GOVERNOR (role-based tool enforcement)
 *
 * This is the enforcement teeth behind the Orchestrator_Contract: it makes the main
 * Evor agent PHYSICALLY unable to do a specialist's job inline, so it MUST delegate
 * via Task. It also boxes each non-Forge sub-agent out of code/training work.
 *
 * How it tells who is calling (verified against Claude Code's PreToolUse payload):
 *   - Sub-agent tool calls carry `agent_type` (e.g. "oh-my-evor:evor-forge").
 *   - Main-orchestrator (Evor) tool calls have NO `agent_type`.
 *
 * Policy (denylist — allow everything except specialist actions by the wrong role):
 *   MAIN Evor (no agent_type):
 *     - MAY NOT Write/Edit a .py file or any ticks/<t>/<role>/ sub-agent artifact.
 *     - MAY NOT run training/code inline via Bash.
 *     → denied with a nudge to spawn the correct Task(subagent_type=…).
 *     - Everything else (Task/Agent, Read, Grep/Glob, evor_* MCP, state Writes, evor CLI Bash) is allowed.
 *   NON-FORGE sub-agents (evor-sage / evor-selector / evor-probe / evor-mutagen):
 *     - MAY NOT Write/Edit .py or run training — they only emit their JSON artifact.
 *   FORGE (evor-forge): unrestricted (it is the implementer).
 *
 * Kill switches (checked FIRST): DISABLE_EVOR=1, EVOR_SKIP_HOOKS=pre-tool-use
 * Inert when EVOR_ACTIVE_RUN_ID is unset (non-run session — never interferes).
 * Fail-open: any internal error → allow (exit 0). A governor must never crash the session.
 *
 * Deny format (verified working): stdout JSON
 *   { hookSpecificOutput: { hookEventName:"PreToolUse", permissionDecision:"deny", permissionDecisionReason: "…" } }
 */

import { readFileSync, writeSync } from 'fs';
import { resolveActiveRun, resolveRunDir } from './lib/active-run.mjs';
import { isMissionLive, isTickFinished } from './lib/run-status.mjs';
import { currentTickAgent } from './lib/waiting.mjs';
import { tickRoute } from './lib/next-step.mjs';
import { turnStartedByHuman, lastSlashCommand } from './lib/transcript.mjs';
import { existsSync as _exists } from 'fs';
import { join as _join } from 'path';
import { resolveWriteTargets, shellVars, expandVars } from './lib/write-targets.mjs';
import { isScratch, mayPerform, operationFor } from './lib/operations.mjs';
import { classifyWriteTarget, selfPatchAllowed } from './lib/protected-paths.mjs';
import { emitDenialSignal, logDecision, logError, logSkip } from './lib/audit.mjs';

// ── Kill switches ─────────────────────────────────────────────────────────────
if (process.env.DISABLE_EVOR) process.exit(0);
const skipHooks = (process.env.EVOR_SKIP_HOOKS ?? '').split(',').map(s => s.trim());
if (skipHooks.includes('pre-tool-use')) {
  // K-14: fail-open is the right policy; silence is not. This switch disables the
  // entire enforcement surface, and until now it was recorded nowhere — a run
  // could be ungoverned end to end with nothing in the trace to say so.
  // Announcing must not itself become a failure, so logSkip never throws and the
  // exit code stays 0.
  logSkip('EVOR_SKIP_HOOKS=pre-tool-use');
  process.exit(0);
}

// ── Active run guard — governor only applies during an active evor run ─────────
const _activeRunId = resolveActiveRun().runId;
if (!_activeRunId) process.exit(0);

// ── Is a mission actually being ORCHESTRATED right now? ──────────────────────
//
// An active-run POINTER is not a live mission. It outlives the mission: a run
// that was paused by the session-end hook, completed or failed keeps its
// `active-run.json`, and every later session in the project — including
// `/evor-setup` for a NEW mission — was then governed as that dead mission's
// orchestrator. In the field (2026-10-30) a setup session was refused Bash, refused
// evor_state_read, refused spawning a probe, and refused writing its own memory, on
// behalf of a mission paused at tick 0 that nobody was running. Setup could not
// even check whether a run was underway, which is its first step.
//
// The Stop hook has asked the right question since §15E — `isMissionLive` — and
// this hook never did. The ROLE rules below that discipline main as an
// orchestrator (no Bash, no state reads, spawn only ticks, author nothing) now
// apply only while a mission is live. The STATE guards — protected paths, the
// .evor write guard, kind spoofing — do not depend on it and stay unconditional.

const _missionLive = (() => {
  try {
    const runDir = resolveRunDir();
    if (!runDir) return false;
    const read = (name) => {
      const p = _join(runDir, name);
      return _exists(p) ? JSON.parse(readFileSync(p, 'utf8')) : undefined;
    };
    const missionState = read('mission-state.json');
    const runState = read('run-state.json');
    // A pointer with no state yet (mid-init, or a run dir being written) is not
    // evidence the mission is idle. Relax only when state SAYS so.
    if (missionState === undefined && runState === undefined) return true;
    return isMissionLive(missionState, runState);
  } catch (err) {
    // Unknown liveness: keep the orchestrator rules on. Failing permissive here
    // would ungovern a running mission; failing strict costs a setup session a
    // clear denial that names this cause.
    logError('mission-liveness', err);
    return true;
  }
})();

let input;
try {
  const raw = readFileSync(0, 'utf8');
  input = JSON.parse(raw || '{}');
} catch (err) {
  logError('parse-input', err);
  process.exit(0); // fail-open
}

/**
 * A repair the governor wants to apply IF nothing denies first (item 4.4).
 * Applied at the very end, after every deny rule has had its chance.
 */
let pendingNameStrip = null;

/** §4.3: constraints to graft onto a generic child's prompt, applied last. */
let pendingPromptInherit = null;

/**
 * Main during a live mission hands work to the tick: this is how, in the words
 * of lib/next-step.mjs — resume the tick's agent by id, or spawn evor-tick when
 * the tick has none. Never a lead or a second tick agent, which the rules
 * further down refuse main.
 */
function mainTickRoute(capital = true) {
  let r;
  try { r = tickRoute(resolveRunDir(), input?.session_id, String(input?.transcript_path ?? '')); }
  catch (err) { logError('tick-route', err); r = 'spawn Task(subagent_type="oh-my-evor:evor-tick")'; }
  return capital ? r.charAt(0).toUpperCase() + r.slice(1) : r;
}

/** The input with every rm path variable guarded, emitted on exit unless something decided. */
let pendingRmRewrite = null;
let decided = false;
const _write = process.stdout.write.bind(process.stdout);
process.stdout.write = (chunk, ...rest) => { decided = true; return _write(chunk, ...rest); };
process.on('exit', () => {
  if (!pendingRmRewrite || decided) return;
  try {
    writeSync(1, JSON.stringify({
      hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: pendingRmRewrite },
    }) + '\n');
  } catch (err) {
    // The guarded form is advisory: a failed write leaves the original command, recorded.
    logError('rm-rewrite', err);
  }
});

function deny(reason, meta = {}) {
  logDecision({ verdict: 'deny', reason, ...meta });
  // Item 4.8: a denial is evidence that an agent wants something it cannot have
  // — either a rule that is wrong or an affordance that is missing. The field
  // run's top rule fired 82 times and produced no data at all.
  emitDenialSignal({
    rule: meta.rule,
    tool: meta.tool ?? input?.tool_name,
    target: meta.target,
    agentType: (input?.agent_type ?? process.env.EVOR_AGENT_ROLE ?? '') || undefined,
    reason,
  });
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        // Said on every denial: in tick 4 of the binarization mission, a Forge
        // denied a (wrongly blocked) trainer launch spent its turns reading the
        // governor's source to find a way past it.
        permissionDecisionReason: reason + DENIAL_FOOTER,
      },
    }) + '\n'
  );
  process.exit(0);
}

const DENIAL_FOOTER =
  ' (This denial is recorded. If it is wrong for what you are doing, say so ' +
  'in your return or take another route; do not look for a way around it.)';

// ── §4.9: `ask` for the two genuinely irreversible decisions ────────────────
//
// AF5 gap 4. `deny` is wrong for these and so is `allow`. A refreeze replaces
// the denominator of every fitness comparison already recorded, and raising a
// sealed threshold changes what "passing" meant retroactively — both are
// decisions a human should make, and neither is one the governor can make well.
//
// Note `ask` fails CLOSED headless, so under an unattended run it degrades to
// deny. For exactly these two that is the safe direction: an unattended mission
// that cannot ask should not refreeze.
try {
  const toolNameA = input?.tool_name ?? '';
  const tiA = input?.tool_input ?? {};
  const argsText = JSON.stringify(tiA ?? {});

  const wantsRefreeze = /"allow_refreeze"\s*:\s*true/.test(argsText) || /--allow-refreeze\b/.test(String(tiA?.command ?? ''));
  const wantsThresholdChange =
    /(^|_)evor_seal_eval_script$/.test(toolNameA) === false &&
    /"(target_value|baseline_value|threshold)"\s*:/.test(argsText) &&
    /(^|_)evor_(update_contract|state_write)$/.test(toolNameA);

  if (wantsRefreeze || wantsThresholdChange) {
    const what = wantsRefreeze
      ? 'Re-freezing replaces the denominator of every fitness comparison already recorded in this run.'
      : 'Changing a sealed threshold changes what "passing" meant for every candidate already scored.';
    logDecision({ verdict: 'ask', rule: wantsRefreeze ? 'refreeze' : 'sealed-threshold', tool: toolNameA });
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'ask',
          permissionDecisionReason:
            `[EVOR GOVERNOR] ${what} This is a decision for the operator, not for the ` +
            `governor and not for the agent that benefits from it. Approve only if ` +
            `replacing the comparison basis is intended.`,
        },
      }) + '\n'
    );
    process.exit(0);
  }
} catch (err) {
  logError('irreversible-ask', err);  // fail-open, but recorded
}

// ── §0.2/0.3: path-resolution gate — decide on the resolved target, not the text ──
//
// This runs FIRST and for EVERY caller, deliberately. H-01: a general-purpose
// sub-agent reported "BLOCKED on authoring … I did not route around it", and 51
// seconds later the orchestrator re-issued the identical edit as
// `subagent_type: "claude"` and it succeeded — then did so four more times. A rule
// keyed on who is asking is nullified by asking as someone else, so this one keys
// on action + resolved path and returns the same verdict for every role.
//
// It also fixes the other half of the defect. The old matchers ran over command
// TEXT, which made them simultaneously evadable (`E=py`, `"free" + "ze"`, a bare
// `cd`) and wrong 66% of the time — 54 of 82 training denials were false positives
// on commands that wrote nothing. Resolving first means a command with no write
// intent produces no targets and is never a denial candidate, however many trigger
// tokens it mentions. Denying more broadly would not have been a fix; Lane K
// measured that broad textual denial trains evasion rather than compliance.
try {
  const toolNameP = input?.tool_name ?? '';
  const { targets, writes } = resolveWriteTargets({
    tool: toolNameP,
    toolInput: input?.tool_input ?? {},
    cwd: process.env.CLAUDE_PROJECT_DIR || process.cwd(),
  });

  if (writes) {
    for (const target of targets) {
      const verdict = classifyWriteTarget(target);
      if (!verdict) continue;
      if (verdict.zone === 'plugin' && selfPatchAllowed()) {
        // The escape exists so a release can edit the plugin deliberately. It is
        // logged rather than silent precisely because it is an escape: every use
        // appears in the audit lane and is reviewed at the phase gate.
        logDecision({
          verdict: 'allow',
          rule: 'self-patch-escape',
          target,
          note: 'EVOR_ALLOW_SELF_PATCH=1 — plugin write permitted and recorded',
        });
        continue;
      }
      deny(
        `[EVOR GUARD] ${toolNameP} would write ${target}, and ${verdict.reason}`,
        { rule: `path-zone:${verdict.zone}`, tool: toolNameP, target },
      );
    }
  }
} catch (err) {
  logError('path-resolution-gate', err);  // fail-open, but recorded
}

try {
  const tool = input?.tool_name ?? '';
  const ti = input?.tool_input ?? {};
  // `agent_type` is absent when the MAIN orchestrator calls, and ALSO whenever a
  // role runs outside the sub-agent lifecycle — a harness, an eval, a direct
  // invocation. Those are not the same thing, and conflating them denies a
  // specialist the tools it legitimately holds: evor-forge-junior was refused
  // Bash three times in one bench episode because the guard read it as Evor.
  // `EVOR_AGENT_ROLE` is the role the caller has already declared —
  // hooks/subagent-stop.mjs reads it for exactly this purpose — so honour it
  // when the payload carries nothing.
  const agentType = ((input?.agent_type ?? process.env.EVOR_AGENT_ROLE ?? '') || '').replace(/^oh-my-evor:/, '');
  const isMain = !agentType; // no agent_type and no declared role ⇒ main Evor

  // Claude's own memory notes (~/.claude/projects/<project>/memory/) are not
  // mission work and not run state. Denying them pushed main to write findings
  // into the run wiki instead, and in the field it refused an agent its memory
  // while it was trying to record why setup was blocked.
  const isAgentMemoryWrite =
    (tool === 'Write' || tool === 'Edit') &&
    /[\\/]\.claude[\\/]projects[\\/][^\\/]+[\\/]memory[\\/]/.test(String(ti?.file_path ?? ''));

  const filePath = String(ti?.file_path ?? '');
  const cmd = String(ti?.command ?? '');

  // An rm on a path built from an unguarded variable stops the client for a
  // person to confirm, even when permissions are bypassed, and an autonomous
  // mission then waits indefinitely. Refuse it here, before that prompt, with
  // the rewrite the client accepts.
  if (tool === 'Bash') {
    // The guarded form is mechanical, so write it rather than refuse: every later
    // rule judges the rewritten command, and it reaches the client as updatedInput
    // only if nothing refuses it. Inside single quotes `$` is literal, so a rewrite
    // there would change the command; those are still refused with the rewrite named.
    let rewritten = cmd;
    let unrewritable = null;
    for (const seg of cmd.split(/;|&&|\|\||\n/)) {
      const rm = seg.match(/(?:^\s*|[|(`{]\s*|\b(?:do|then|else|sudo|xargs|nohup|command)\s+(?:-\S+\s+)*|-exec\s+)rm\s+(.*)$/);
      if (!rm) continue;
      const bare = rm[1].match(/\$(?!\{\w+:\?)\{?(\w+)/);
      if (!bare) continue;
      if (rm[1].includes("'")) { unrewritable = unrewritable ?? bare; continue; }
      const args = rm[1].replace(/\$\{(\w+)\}|\$(\w+)/g, (_m, a, b) => `\${${a ?? b}:?}`);
      rewritten = rewritten.replace(rm[1], args);
    }
    if (rewritten !== cmd && !unrewritable) {
      input.tool_input = { ...ti, command: rewritten };
      pendingRmRewrite = input.tool_input;
    }
    for (const seg of unrewritable ? cmd.split(/;|&&|\|\||\n/) : []) {
      const rm = seg.match(/(?:^\s*|[|(`{]\s*|\b(?:do|then|else|sudo|xargs|nohup|command)\s+(?:-\S+\s+)*|-exec\s+)rm\s+(.*)$/);
      if (!rm) continue;
      const bare = rm[1].match(/\$(?!\{\w+:\?)\{?(\w+)/);
      if (bare) {
        deny(
          `[EVOR GUARD] rm on a path built from $${bare[1]} needs a guard: write it as ` +
            `"\${${bare[1]}:?}" (for example "\${W:?}/\${n:?}/build") so an empty variable cannot ` +
            `widen the delete. Unguarded, the command stops for a person to confirm.`
        );
      }
    }
  }

  // Specialist-action detectors --------------------------------------------------
  // A .py file OR a per-role sub-agent artifact path == authored specialist output.
  const isCodeOrArtifactWrite =
    /\.py$/.test(filePath) ||
    /\/ticks\/[^/]+\/(mutagen|sage|selector|probe|forge)\//.test(filePath);

  // Bash that runs training/model code.
  //
  // NARROWED, not widened. The previous form was `python` AND any of
  // (`.py`|`train`|`torch`|`.fit(`|`.pt`|torchvision) anywhere in the command text,
  // which denied 54 of 82 times on commands that executed nothing: an env probe
  // printing `torch.__version__`, a `py_compile` syntax check, a pytest run, a
  // `print()` whose STRING mentions train.py. Lane K's finding is that broad
  // textual denial does not produce compliance — it produces obfuscation, and the
  // measured response was agents splitting path literals to get the same write
  // through without a trail. So this now requires python to actually EXECUTE
  // something: a `.py` script, or a `-m` module that is not one of the inspection
  // tools. Mentions inside quotes are stripped before the test, because a string
  // that talks about training is not training.
  const cmdUnquoted = cmd.replace(/'[^']*'|"[^"]*"/g, ' ');
  const INSPECTION_MODULES = /^-m\s+(py_compile|pytest|unittest|pip|venv|json\.tool|site|http\.server)\b/;
  // Judge each python invocation by what it runs — the script or module right
  // after the interpreter's flags — not by any `.py` path later in the command
  // line: `python3 -c "…"; grep -n x eval.py` reads a file, it runs nothing.
  const cmdVars = shellVars(cmd);
  // Each python invocation, with a relative script resolved against the directory
  // a preceding `cd` moved to: `cd <scratchpad> && python compose.py` runs a
  // scratchpad script.
  let pyCwd = '';
  const pyArgs = expandVars(cmdUnquoted, cmdVars)
    .split(/;|&&|\|\|?|\n/)
    .map((seg) => {
      const cd = seg.match(/^\s*cd\s+(\S+)/);
      if (cd) { pyCwd = cd[1].startsWith('/') ? cd[1] : (pyCwd ? `${pyCwd}/${cd[1]}` : ''); return undefined; }
      const a = seg.match(/\bpython[0-9.]*\s+(.*)$/)?.[1].trim().replace(/^(?:-(?![mc]\b)[A-Za-z]+\s+)+/, '');
      if (a === undefined) return undefined;
      return pyCwd && /^[^\s/-][^\s]*\.py\b/.test(a) ? `${pyCwd.replace(/\/$/, '')}/${a}` : a;
    })
    .filter((a) => a !== undefined);
  // A script in the agent's own session scratchpad is its analysis tooling (an
  // EDA pass over telemetry), not the candidate: candidate code lives in a worktree.
  // The same holds for a temp directory (`mktemp -d`, which Forge is told to use).
  const SCRATCH_SCRIPT = /^\/tmp\/\S+\.py\b/;
  const runsTraining = pyArgs.some(
    (a) =>
      !INSPECTION_MODULES.test(a) &&
      !SCRATCH_SCRIPT.test(a) &&
      // `-m evor…` is deliberately NOT here: `python -m evor run` is a CLI
      // invocation, not training, and it is owned by the EVOR GUARD rule below,
      // which names the right replacement tool (evor_run_start + Monitor). Claiming
      // it here would make this rule fire first and report the wrong cause.
      /^(\S+\.py\b|-m\s+\S*train\S*)/.test(a),
  );

  // ── Spawn-hierarchy gate — child agents may be spawned ONLY by their parent ──
  const spawnType = String(ti?.subagent_type ?? '').replace(/^oh-my-evor:/, '');

  // ── A sub-agent spawns in the FOREGROUND ───────────────────────────────────
  //
  // A foreground Agent/Task call blocks until the child returns — that IS the
  // wait primitive, and several in one message run in parallel and are all
  // awaited. A BACKGROUND spawn returns at once, the caller's turn ends, and
  // nothing wakes a sub-agent when its child finishes: the completion notice goes
  // to MAIN. Only main is re-activated by notifications.
  //
  // Measured, same seed, same CLI (2.1.312), 2026-10-30:
  //   13 foreground spawns, 0 background  → the tick ran the whole loop, 1 node
  //    3 foreground, 4 background (Sage's juniors) → Sage was never woken to
  //      aggregate, the tick was never woken, main had nothing to act on, and the
  //      process exited 4 s after the last junior. 0 nodes.
  // The tick's own "no blocking primitive (TaskOutput unregistered)" signal, and
  // the v1.2.7 yield design built on it, missed that the primitive was the
  // foreground call it already had. Main may background: it is woken.
  if ((tool === 'Task' || tool === 'Agent') && !isMain && ti?.run_in_background === true) {
    deny(
      `[EVOR GOVERNOR] ${agentType} may not spawn a sub-agent in the background. Nothing ` +
        `wakes a sub-agent when its background child finishes — the notice goes to main — so ` +
        `your turn would end and the work would stop. Spawn it in the FOREGROUND (omit ` +
        `run_in_background): the call blocks until the child returns. For parallel fan-out, ` +
        `put several Agent calls in ONE message; they run concurrently and are all awaited.`,
      { tool, target: spawnType || String(ti?.subagent_type ?? '') }
    );
  }

  // ── §0.3: an evor spawn must never carry `name` ─────────────────────────────
  // Passing `name` turns the spawn into an in-process teammate. The teammate then
  // presents under that name rather than its subagent_type, so every matcher in
  // hooks.json (`^oh-my-evor:evor-.*`) misses it, and it inherits the session
  // model instead of its own `model:` frontmatter. In run 29d17abc this alone
  // silenced SubagentStart (3/10), SubagentStop (0/10) and this governor (0
  // denials), and put all 10 agents on sonnet regardless of tier.
  //
  // Nothing in this repo passes `name` — the orchestrator invented forge-t1 /
  // sage-t1 at runtime, which is exactly why the rule has to be enforced rather
  // than written down.
  // Scoped to evor agents: only they have frontmatter tiers and hook matchers to
  // lose. A run may legitimately spawn a non-evor agent as a named teammate.
  if ((tool === 'Task' || tool === 'Agent') && /^evor-/.test(spawnType) && String(ti?.name ?? '')) {
    // ── Item 4.4: this was a DENY, and it was the most-fired rule in the field
    // run — 19 of 26 spawn denials. It collides with `SendMessage` addressing:
    // an agent that wants to be addressable passes `name`, which is a reasonable
    // thing to want, and got refused 19 times for it.
    //
    // The rule's REASON is still right — `name` makes the spawn an in-process
    // teammate, which costs it its model tier (hook matchers were the other half
    // and are fixed by K-13's `*`). But denying was the wrong instrument: it
    // blocked the work instead of fixing the call. AF5 §0: the allow/deny binary
    // is not an upstream constraint, and `updatedInput` is what this case is for.
    //
    // RECORDED HERE, EMITTED AT THE END. Emitting and exiting here would skip
    // every deny rule below — which briefly made `name` a way for main to spawn
    // a lead directly, past the §3b.0 boundary guard. A repair must not become a
    // bypass, so the strip is applied only once nothing else has objected.
    pendingNameStrip = { spawnType, name: String(ti.name) };
  }


  // ── §4.3: a generic spawn inherits its spawner's constraints ──────────────
  //
  // `PARENT` and every role rule key on `evor-*`. A `general-purpose` sub-agent
  // matches none of them, so an identical prompt re-issued under that type was
  // ungoverned — and that became the standing pattern: one agent reported
  // "BLOCKED on authoring … I did not route around it", and 51 seconds later the
  // orchestrator re-issued the same edit as `subagent_type: "claude"` and it
  // succeeded, four more times after that.
  //
  // The path rules already apply to every agent type (H-01, closed by §0.2/0.3),
  // so the WRITE route is shut. What remains is the role rules — research gates,
  // artifact slots — which a generic child genuinely escapes because nothing
  // tells it what its parent could not do.
  //
  // So tell it. `updatedInput` prepends the spawner's constraints to the child's
  // prompt, which is the only channel a hook has into an agent that does not
  // exist yet. This is inheritance by construction rather than by matcher, and
  // it does not pretend to be enforcement: it is `additionalContext` doing the
  // job prose in an agent file was doing badly.
  const GENERIC_SPAWNS = new Set(['claude', 'general-purpose', 'workspace-scout', 'Explore', 'Plan']);
  if ((tool === 'Task' || tool === 'Agent') && GENERIC_SPAWNS.has(String(ti?.subagent_type ?? '')) && agentType) {
    const inherited = [
      `You were spawned by \`${agentType}\`, and you inherit its constraints.`,
      `You may not write to the plugin install, to \`.evor/runs/**\` state artifacts, or to the enforcement layer.`,
      agentType === 'evor-mutagen'
        ? `You may not gather evidence: no web search, no citation lookup. That is Sage's job.`
        : null,
      /^evor-(?!forge-junior)/.test(agentType)
        ? `You may not author \`.py\` candidate code or run training; only evor-forge-junior does that.`
        : null,
      `If you cannot proceed within these, say so and stop — do not route around them.`,
    ].filter(Boolean).join(' ');

    pendingPromptInherit = { inherited, spawnType: String(ti.subagent_type), parent: agentType };
  }

  if ((tool === 'Task' || tool === 'Agent') && spawnType) {
    const PARENT = {
      'evor-sage-junior': 'evor-sage',
      'evor-forge-architect': 'evor-forge',
      'evor-forge-junior': 'evor-forge',
      'evor-forge-critic': 'evor-forge',
      'evor-forge-analyst': 'evor-forge',
    };
    const requiredParent = PARENT[spawnType];
    if (requiredParent && agentType !== requiredParent) {
      const who = isMain ? 'Evor (orchestrator)' : agentType || 'this agent';
      deny(
        `[EVOR GOVERNOR] ${spawnType} may be spawned ONLY by ${requiredParent}. ${who} must not ` +
          `spawn it directly — ` +
          (isMain && _missionLive
            ? `the tick runs ${requiredParent}, which fans out its own sub-team. ${mainTickRoute()}, ` +
              `and tell it what you need.`
            : `delegate the work to ${requiredParent}, which owns and fans out its own sub-team.`)
      );
    }

    // EVOR-TICK MAY NOT SPAWN ANOTHER EVOR-TICK. The PARENT map above governs five
    // roles and evor-tick was in none of them, so nothing forbade a tick spawning
    // a tick — recursive delegation with no base case. The bench surfaced it the
    // moment the agent types became spawnable: three evor-tick runs ended their
    // turn with "a nested evor-tick agent is now running in the background... I'll
    // report back once it completes", one of them after two turns, and there is
    // nobody to report back to. The tick runs the orchestrator's own loop ONE
    // level down (see the note below); a second level is not a delegation, it is a
    // stack.
    if (spawnType === 'evor-tick' && !isMain) {
      deny(
        `[EVOR GOVERNOR] evor-tick is the orchestrator's loop one level down and may be spawned ` +
          `only by Evor itself. ${agentType || 'this agent'} must not spawn it — finish this tick and ` +
          `return your status line; do not nest another tick inside it.`
      );
    }

    // evor-acquirer is multi-parent: Forge (enrich-train), main Evor, or evor-tick
    // (harden-test). evor-tick was added for Phase 3a: it runs the orchestrator's
    // own 9-step loop one level down, so the harden-test acquisition path moves
    // behind the boundary with it. Without this the gate would deny the boundary a
    // spawn it inherited verbatim from main — and only at runtime, mid-tick.
    if (
      spawnType === 'evor-acquirer' &&
      !(isMain || agentType === 'evor-forge' || agentType === 'evor-tick')
    ) {
      deny(
        `[EVOR GOVERNOR] evor-acquirer may be spawned only by Forge (enrich-train), Evor, or ` +
          `evor-tick (harden-test). ${agentType || 'this agent'} must not spawn it.`
      );
    }
  }

  // ── §4.7: read-only exploration for evor-tick ─────────────────────────────
  //
  // evor-tick is denied Bash, so when it needed to find a file it spawned a
  // `general-purpose` agent to run `find` — a whole sub-agent, its own context
  // and its own turn, to list a directory. That is a denial producing a more
  // expensive version of the same act, which is Lane J's backfire pattern, and
  // it also put an ungoverned generic agent into the tree (see 4.3).
  //
  // Read-only shell touches nothing. It is allowed here explicitly, and narrowly:
  // an anchored allowlist of inspection commands, no redirection, no `&&`, no
  // pipes into anything that writes. Everything else still falls through to the
  // rules below, and §0.2's path gate still decides any command that writes.
  if (agentType === 'evor-tick' && tool === 'Bash') {
    const READ_ONLY_SHELL =
      /^\s*(ls|find|stat|file|wc|head|tail|cat|grep|rg|realpath|basename|dirname|du|df|pwd|echo)\b[^;&|><`$]*$/;
    if (READ_ONLY_SHELL.test(cmd)) {
      logDecision({ verdict: 'allow', rule: 'tick-read-only-shell', tool, agentType, target: cmd.slice(0, 120) });
      process.exit(0);
    }
  }

  // ── Research-delegation gate — Mutagen never researches; it delegates to Sage ──
  // Covers all search/discovery channels including the three research MCPs
  // (semantic-scholar, arxiv, hf-mcp) — anchoring-bias separation is load-bearing.
  if (agentType === 'evor-mutagen') {
    if (/Consensus__search|Exa__web|WebSearch|WebFetch|evor_cite|semantic[_-]scholar|arxiv|hf[_-]mcp/i.test(tool)) {
      deny(
        `[EVOR GOVERNOR] Mutagen does not gather evidence. Emit investigation_queries[] (research angles) ` +
          `for Sage — the orchestrator routes them to Sage, who fans out to Sage-junior researchers. Do not research directly.`
      );
    }
  }

  // ── forge-junior research gate — narrow arxiv read-only grant; all search denied ──
  // forge-junior may retrieve a cited paper via the arxiv MCP (get_paper / download_paper /
  // read_paper) to verify its implementation matches the source formula. It must not search
  // for new evidence — citation discovery is exclusively Sage's job.
  if (agentType === 'evor-forge-junior') {
    const isArxivReadOnly =
      /arxiv/i.test(tool) && /get_paper|download_paper|read_paper/i.test(tool);
    if (!isArxivReadOnly) {
      if (/semantic[_-]scholar/i.test(tool) || /hf[_-]mcp/i.test(tool)) {
        deny(
          `[EVOR GOVERNOR] forge-junior may not use research discovery tools (${tool}). ` +
            `Citation lookup is Sage's job. Allowed: arxiv get_paper / download_paper / read_paper to verify a cited formula.`
        );
      }
      if (/WebSearch|WebFetch|Exa__web/i.test(tool)) {
        deny(
          `[EVOR GOVERNOR] forge-junior may not search the web. ` +
            `Allowed: arxiv get_paper / download_paper / read_paper to verify a cited formula only.`
        );
      }
      if (/arxiv/i.test(tool)) {
        deny(
          `[EVOR GOVERNOR] forge-junior may only READ arxiv papers (get_paper / download_paper / read_paper) — ` +
            `searching for new evidence is Sage's job. Use the cited arXiv ID directly.`
        );
      }
    }
  }

  // ── §4.2: authority as OPERATIONS, checked against the resolved act ───────
  //
  // AF4 §6: the unit of authority was the TOOL, and the tool is the wrong noun.
  // `Write` was denied, `Bash` was granted, and 21 writes happened anyway across
  // 6 roles — two of them the roles' own deliverables, staged to /tmp in exactly
  // the manner the denylist existed to prevent. The denylist named a tool; the
  // intent was an operation, and `Bash` satisfies the operation while evading
  // the name.
  //
  // This runs BEFORE the tool-shaped rules below and subsumes them for the
  // authoring case: `resolveWriteTargets` (§0.2) reduces a heredoc, a redirect
  // and an `Edit` to the same answer, so the grant means the same thing however
  // the act is performed. The rules below stay because they carry role-specific
  // guidance the model can act on, and a denial the model cannot act on stalls
  // the run (PM3).
  try {
    const { targets: opTargets } = resolveWriteTargets({
      tool,
      toolInput: ti,
      cwd: process.env.CLAUDE_PROJECT_DIR || process.cwd(),
    });
    const operation = operationFor({ tool, targets: opTargets, runsTraining });

    // Only ROLES the system knows are judged here. A generic agent type has no
    // grant of its own by design — 4.3 hands it the spawner's constraints,
    // because authority attached to who you ARE is defeated by who you can
    // CREATE, and the path rules (§0.2/0.3) already bind it regardless.
    // Main is held to the orchestrator's grant only while it is orchestrating a
    // live mission; a setup or maintenance session with a stale pointer is not.
    const known = (agentType === '' && _missionLive && !isAgentMemoryWrite) || /^evor-/.test(agentType);
    if (operation && known && !mayPerform(agentType, operation)) {
      const who = agentType || 'Evor (orchestrator)';
      // Main's explanation is that it is orchestrator-only — the same phrase the
      // tool-shaped rule used, because it is the right explanation and PM3 says
      // a denial the model cannot act on stalls the run.
      const roleNote = agentType
        ? ''
        : ` Evor is orchestrator-only: the tick's agents do this. ${mainTickRoute()}, and tell it what you need.`;
      const ADVICE = {
        'author-code': 'Only evor-forge-junior authors candidate code, and only on its own surface. ' +
                       'Emit your JSON artifact instead, or delegate the code to forge-junior. ' +
                       'A scratch script of your own goes under /tmp (e.g. mktemp -d), which is not candidate code.',
        'run-training': 'Only evor-forge-junior runs candidate code. Launch evaluation with evor_run_start.',
        'write-run-state': 'Run state is written through evor_state_write / evor_record_node / ' +
                           'evor_record_eval, never by hand.',
        'write-artifact': 'Write your deliverable with evor_write_artifact(agent="…"), which puts it ' +
                          'in the slot your role owns.',
        'discover-evidence': 'Searching for evidence is Sage\'s job. Emit investigation_queries[] ' +
                             'and let the orchestrator route them to Sage.',
        'retrieve-cited-source': 'You may not fetch sources. Read the finding your upstream ' +
                                 'stage already produced.',
      };
      // Name a target that caused the refusal: scratch paths are exempt, so naming one
      // made the refusal read as contradicting its own advice to use /tmp.
      const shown = opTargets.find((t) => !isScratch(t)) ?? opTargets[0];
      deny(
        `[EVOR GOVERNOR] ${who} may not perform the operation "${operation}"` +
          (shown ? ` (target: ${shown})` : '') + '.' + roleNote + ' ' +
          (agentType ? (ADVICE[operation] ?? '') + ' ' : '') +
          'This rule is scoped to the OPERATION, not to a tool name: the same act through ' +
          'Bash, a heredoc or a redirect is the same act.',
        { rule: `operation:${operation}`, tool, agentType, target: shown },
      );
    }
  } catch (err) {
    logError('operation-authority', err);  // fail-open, but recorded
  }

  if (isMain && _missionLive && !isAgentMemoryWrite) {
    // Evor is orchestrator-only — it must delegate all authoring/training.
    if ((tool === 'Write' || tool === 'Edit') && isCodeOrArtifactWrite) {
      deny(
        `[EVOR GOVERNOR] Evor is orchestrator-only and must not author code or sub-agent artifacts ` +
          `(${filePath}). The tick's agents write it. ${mainTickRoute()}, and tell it what you need.`
      );
    }
    if (tool === 'Bash' && runsTraining) {
      deny(
        `[EVOR GOVERNOR] Evor must not run training/model code inline. Candidates are implemented, ` +
          `run and recorded inside the tick. ${mainTickRoute()}, and tell it what you need.`
      );
    }
    // The broad orchestrator-only rule runs AFTER the .evor write-guard below —
    // see §1.3 there. Denying here would shadow the more specific guard and
    // report the wrong rule as the cause.
  } else if (!isMain && agentType !== 'evor-forge-junior') {
    // Main outside a live mission (setup, a paused or finished run) is not a
    // sub-agent role; the orchestrator rules above are the only ones meant for it.
    // Only evor-forge-junior authors/runs candidate CODE. Everyone else — including the
    // Forge LEAD (an orchestrator of its dev team) and the architect/critic/analyst —
    // emits JSON artifacts and delegates code to the junior. The lead launches evaluation
    // through the evor_run_start MCP tool, not raw training.
    const isForgeLead = agentType === 'evor-forge';
    // A script in the agent's own session scratchpad is its tooling, not candidate code.
    const inScratchpad = /^\/tmp\//.test(filePath);
    if ((tool === 'Write' || tool === 'Edit') && /\.py$/.test(filePath) && !inScratchpad) {
      deny(
        `[EVOR GOVERNOR] ${agentType} does not author code. ` +
          (isForgeLead
            ? `As the Forge LEAD you orchestrate the team — spawn evor-forge-junior to write the code.`
            : `Only evor-forge-junior writes candidate code; emit your JSON artifact instead.`)
      );
    }
    if (tool === 'Bash' && runsTraining) {
      deny(
        `[EVOR GOVERNOR] ${agentType} does not run raw training code. ` +
          (isForgeLead
            ? 'Launch evaluation with the evor_run_start tool; candidate code is written by evor-forge-junior.'
            : 'Only evor-forge-junior runs candidate code.')
      );
    }
  }
} catch (err) {
  // Fail-open — a governor error must never block legitimate work, but a caught
  // exception must leave a trace or an inert guard is indistinguishable from a
  // permissive one (K-14).
  logError('role-rules', err);
}

// ── §3 / §15C: .evor write-guard (unconditional during active run) ──
// Denies direct writes to .evor/runs/** state artifacts and top-level .evor/*.json.
// ALLOWS .evor/worktrees/** (Forge's code surface) + cache markers.
try {
    // Path patterns for protected artifacts
    const PROTECTED_RUNS_RE = /[/\\]\.evor[/\\]runs[/\\]/;
    const PROTECTED_TOP_RE  = /[/\\]\.evor[/\\][^/\\]+\.json$/;
    const ALLOW_WORKTREES   = /[/\\]\.evor[/\\]worktrees[/\\]/;
    // Allowed markers: .env, .deps-ok, .uv-ok, .workspace-class, hook-state, cache files
    const ALLOW_MARKERS_RE  = /[/\\]\.evor[/\\]\.[^/\\]+$|[/\\]\.evor[/\\][^/\\]+-throttle\.json$|[/\\]\.evor[/\\]perm-denied-throttle\.json$|[/\\]\.evor[/\\]user-prompt-throttle\.json$/;

    // §15C: python -m evor block (python, python3, python3.x etc.) — any invocation
    // `python -m evor.watch` is exempt: it only reads a telemetry file and a pid, and it
    // has to run as a background Bash task, which no MCP tool can be.
    const BASH_PYTHON_EVOR_RE = /python[0-9.]*\s+-m\s+evor(?!\.watch\b)(\b|\.)/;
    // §15C: import evor / from evor... block
    // evor.watch is the training watcher agents are told to run; importing it is
    // the same act as `python -m evor.watch`, which is allowed above.
    const BASH_IMPORT_EVOR_RE = /\b(import\s+evor(?!\.watch\b)|from\s+evor(?!\.watch\b)[\s.])/;
    // Only when python is actually invoked. Without this the rule fires on any
    // command that MENTIONS the import — `grep -rn "import evor" harness/` reads
    // and writes nothing, and denying it is a false positive of exactly the kind
    // that made agents split path literals rather than comply.
    const BASH_RUNS_PYTHON_RE = /(^|[;&|]|\s)python[0-9.]*(\s|$)/;

    const toolNameG = input?.tool_name ?? '';
    const tiG = input?.tool_input ?? {};
    const filePathG = String(tiG?.file_path ?? '');
    const cmdG = String(tiG?.command ?? '');

    // Helper: is this path protected?
    function isProtectedPath(p) {
      if (!p) return false;
      if (ALLOW_WORKTREES.test(p)) return false;
      if (ALLOW_MARKERS_RE.test(p)) return false;
      return PROTECTED_RUNS_RE.test(p) || PROTECTED_TOP_RE.test(p);
    }

    if ((toolNameG === 'Write' || toolNameG === 'Edit') && isProtectedPath(filePathG)) {
      // Identify the right replacement tool
      let replacement = 'evor_write_artifact or evor_state_write';
      if (/proposals\.json/.test(filePathG)) replacement = 'evor_write_artifact(agent="mutagen")';
      else if (/verdict\.json/.test(filePathG)) replacement = 'evor_write_artifact(agent="selector")';
      else if (/findings\.json/.test(filePathG)) replacement = 'evor_write_artifact(agent="sage" or "probe")';
      else if (/forge-report\.json/.test(filePathG)) replacement = 'evor_write_artifact(agent="forge")';
      else if (/parent\.patch/.test(filePathG)) replacement = 'evor_store_patch';
      else if (/run-state\.json|tick-state\.json|mission-state\.json|strategy\.json|active-run\.json/.test(filePathG)) replacement = 'evor_state_write';
      else if (/tree\.json/.test(filePathG)) replacement = 'evor_record_node';
      else if (/results\.json/.test(filePathG)) replacement = 'evor_record_eval';
      deny(
        `[EVOR GUARD] Direct write to an evor state file is not allowed. ` +
        `Use ${replacement} to write this artifact through the proper channel.`
      );
    }

    if (toolNameG === 'Bash') {
      if (BASH_PYTHON_EVOR_RE.test(cmdG)) {
        // Extract what they're trying to do to name the right tool
        let replacement = 'the appropriate evor_* MCP tool';
        if (/evor\s+run\b/.test(cmdG)) replacement = 'evor_run_start, then evor_wait({ job_id })';
        else if (/evor\s+validate/.test(cmdG)) replacement = 'evor_validate';
        else if (/evor\s+doctor/.test(cmdG)) replacement = 'evor_doctor';
        else if (/evor\.wiki/.test(cmdG)) replacement = 'evor_wiki_add or evor_wiki_query';
        deny(
          `[EVOR GUARD] Direct CLI invocation is not allowed. Use ${replacement} instead.`
        );
      }

      if (BASH_IMPORT_EVOR_RE.test(cmdG) && BASH_RUNS_PYTHON_RE.test(cmdG)) {
        deny(
          `[EVOR GUARD] Importing the evor harness from Bash is not allowed: it reads and writes ` +
            `run state outside the evor_* tools. Use the evor_* tool for the job; to check the ` +
            `trainer watcher, run \`python -m evor.watch --help\`, which is allowed.`
        );
      }

      // The Bash write-scanner that stood here is retired by §0.2. It matched on
      // command TEXT — it required the literal `.evor` inside the redirect or the
      // `open()` call — so `cd .evor/runs && python3 - <<EOF … open("mission-state.json","w")`
      // slipped past it and rewrote two missions' state 14 hours after the fact,
      // while benign commands that merely mentioned a path were denied. The
      // path-resolution gate above decides the same question on the resolved
      // absolute target, through `cd` and variable expansion, which is both
      // stricter where it matters and quieter where it does not.
    }
  } catch (err) {
    logError('evor-write-guard', err);  // fail-open, but recorded
  }

// ── §1.3: orchestrator-only, enforced for ALL shell and file work ─────────────
// The isMain rules above are shape-specific: they fire on training-looking Bash
// and on .py / artifact-path writes. Ordinary exploration — git, ls, cat, grep,
// find — matched neither, which is how run 29d17abc put 120 Bash, 18 Write and
// 14 Edit calls into the orchestrator's own context. Main's context x turns was
// 57.6% of that run's cost, so this is the delegation rule that actually carries
// AC2, not a stylistic preference.
//
// Placed after the .evor write-guard deliberately: that guard is unconditional
// and applies to every role, so when both would fire the caller should be told
// about the stricter, more specific rule.
//
// The reason string matters as much as the denial — `permissionDecisionReason`
// is shown to the model, so a denial redirects rather than stalls (PM3). It is
// also the only decision that survives `bypassPermissions`, which the failed run
// used throughout. Escape hatch: EVOR_SKIP_HOOKS=pre-tool-use.
try {
  const toolNameO = input?.tool_name ?? '';
  // Same rule as above: a declared role is not the orchestrator.
  const isMainO = !((input?.agent_type ?? process.env.EVOR_AGENT_ROLE ?? '') || '');
  const memoryWriteO =
    (toolNameO === 'Write' || toolNameO === 'Edit') &&
    /[\\/]\.claude[\\/]projects[\\/][^\\/]+[\\/]memory[\\/]/.test(String(input?.tool_input?.file_path ?? ''));
  if (isMainO && _missionLive && !memoryWriteO && (toolNameO === 'Bash' || toolNameO === 'Write' || toolNameO === 'Edit')) {
    const tiO = input?.tool_input ?? {};

    // Every file in commands/ dispatches with
    //   cat "${EVOR_PLUGIN_ROOT:-$CLAUDE_PLUGIN_ROOT}/skills/<name>/SKILL.md"
    // so a blanket Bash denial would block /evor-run and /evor-resume during an
    // active run — the orchestrator denying its own dispatch (PM3). Loading a
    // skill definition is dispatch, not leaf work.
    //
    // Anchored and whole-command: `cat <one plugin SKILL.md path>` and nothing
    // else. No `&&`, `;`, `|` or redirection, so the exemption cannot be used to
    // smuggle work past the gate, and the path must sit under a plugin-root
    // variable rather than any directory that happens to be called `skills`.
    const SKILL_DISPATCH_RE =
      /^\s*cat\s+"?\$\{?(?:EVOR_PLUGIN_ROOT|CLAUDE_PLUGIN_ROOT)[^"]*\/skills\/[\w-]+\/SKILL\.md"?\s*$/;
    if (toolNameO === 'Bash' && SKILL_DISPATCH_RE.test(String(tiO?.command ?? ''))) {
      process.exit(0);
    }

    const target = toolNameO === 'Bash'
      ? `\`${String(tiO?.command ?? '').slice(0, 80)}\``
      : String(tiO?.file_path ?? '');
    deny(
      `[EVOR GOVERNOR] Evor is orchestrator-only: it runs ticks and records results, and does ` +
        `not run ${toolNameO} itself (${target}). Inspection, code, training and evidence happen ` +
        `inside the tick. ${mainTickRoute()}, and tell it what you need. Progress for the user ` +
        `comes from evor_check_stop.`
    );
  }
} catch (err) {
  // Fail-open — a governor error must never block legitimate work, but a caught
  // exception must leave a trace or an inert guard is indistinguishable from a
  // permissive one (K-14).
  logError('role-rules', err);
}

// ── §3b.0: boundary enforcement — main may not absorb per-tick detail ────────
// Measured in Phase 3a.2: shipping `evor-tick` as PROSE (a Step -1 instruction in
// skills/evor/SKILL.md) cut main's context slope 54% but left main running 50
// turns/tick. It spawned the boundary AND kept doing the loop — 45
// evor_read_artifact, 28 evor_state_read, 11 evor_tree_read, plus direct lead
// spawns. Recurring growth fell only 31% against a target ~15x, and cost per tick
// ROSE $14.93 -> $18.59: the mission funded both the hop and the duplicated work.
//
// That is this plan's own P2 — structural enforcement over prose. Every other
// rule here is a deny because prose already failed once; AC2 went 152 -> 1
// precisely because it was a deny. So is this.
//
// evor_tree_read is the one that compounds: the tree grows with node count, so
// leaving it in main makes per-tick cost RISE across ticks — moving the context
// wall rather than removing it.
try {
  const toolNameB = input?.tool_name ?? '';
  // THE THIRD SITE THAT MISREAD EVERY ROLE. `agent_type` is empty whenever the
  // role is the TOP-LEVEL agent — which is exactly how the bench runs it — so this
  // block believed `evor-tick` was the mission orchestrator and denied it spawning
  // its own leads. Three lite17 tick runs recorded `oh-my-evor:evor-mutagen`
  // spawns errored, and the tick said so itself on the signal bus:
  // `tick1-governor-blocks-mutagen-spawn-contradictory`. Two other sites in this
  // file already consult EVOR_AGENT_ROLE (the role a caller has declared); this
  // one and §4.10 below did not, and a fix that repairs the instances it happened
  // to observe rather than every site with the same shape is how the same bug gets
  // found three times.
  const isMainB = !((input?.agent_type ?? process.env.EVOR_AGENT_ROLE ?? '') || '');
  // The boundary exists to keep a LIVE mission's orchestrator flat across ticks.
  // With no live mission there is no tick to sit behind.
  // A never-halt mission does not ask — running OR paused. skills/evor/SKILL.md
  // says so ("you NEVER emit an AskUserQuestion") and main asked anyway, three
  // times in the 2026-10-30 binarization resume: twice while running and once
  // after pausing itself. A pause is reported in plain text, not as a question.
  // The interactive flows are the exception: a session whose latest slash
  // command is evor-setup or evor-distill is where the user is meant to be asked.
  if (isMainB && toolNameB === 'AskUserQuestion') {
    let posture = '';
    let missionStatus = '';
    try {
      const rd = resolveRunDir();
      const read = (n) => (rd && _exists(_join(rd, n)) ? JSON.parse(readFileSync(_join(rd, n), 'utf8')) : null);
      posture = String(read('goal-contract.json')?.autonomy_charter?.posture ?? '');
      missionStatus = String(read('mission-state.json')?.status ?? '');
    } catch (err) { logError('ask-posture', err); }
    const tp = String(input?.transcript_path ?? '');
    if (posture === 'aggressive-never-halt' && (missionStatus === 'running' || missionStatus === 'paused')
        && !/^(evor-setup|evor-distill)$/.test(lastSlashCommand(tp))
        // A person who has just typed is present: answering them with a question
        // is not halting the autonomous loop. The binarization user asked to drop
        // a "leaf" domain, there were two, and the clarifying question was denied.
        && !turnStartedByHuman(tp)) {
      deny(
        `[EVOR GOVERNOR] This mission's autonomy charter is aggressive-never-halt: nobody is ` +
          `asked after setup. Decide by the Monotonic-Honesty Invariant: take the option that ` +
          `keeps the evaluation as hard and honest as it is. Send an audit or a re-check to the ` +
          `evor-tick agent. If the run genuinely cannot proceed, set mission_status "paused" with ` +
          `a mission_status_reason through evor_state_write, and say so in plain text.`
      );
    }
  }
  if (isMainB && _missionLive) {
    // An artifact or an agent is delivered by an agent, whose completion notice
    // wakes main; blocking on it holds main's turn for up to nine minutes at a
    // time and repeats. Job and pid waits stay: nothing else reports those.
    if (toolNameB === 'mcp__plugin_oh-my-evor_evor__evor_wait' && (input?.tool_input?.artifact || input?.tool_input?.agent_id)) {
      deny(
        `[EVOR GOVERNOR] Do not wait on an artifact or an agent: the agent that owes it wakes ` +
          `you when it finishes. Call evor_wait({ heartbeat: true }), then end your ` +
          `turn. If a completion notice from inside the tick reaches you, pass it to the evor-tick ` +
          `agent with SendMessage.`
      );
    }
    const BOUNDARY_ABSORBED = new Set([
      'mcp__plugin_oh-my-evor_evor__evor_read_artifact',
      'mcp__plugin_oh-my-evor_evor__evor_tree_read',
      'mcp__plugin_oh-my-evor_evor__evor_state_read',
    ]);
    if (BOUNDARY_ABSORBED.has(toolNameB)) {
      deny(
        `[EVOR GOVERNOR] ${toolNameB.replace('mcp__plugin_oh-my-evor_evor__', '')} belongs inside the ` +
          `tick boundary, not in the mission orchestrator. The tick agent reads artifacts, tree and ` +
          `state on your behalf and returns a status line plus pointers. ${mainTickRoute()}, and ` +
          `ask it. Pointers are for the next tick: pass them in its spawn prompt and it reads them.`
      );
    }

    // Resuming a tick's CHILD is the same leak through SendMessage. In the
    // 2026-10-30 binarization mission the tick yielded and told main to resume
    // Forge; main did, and from then on every one of Forge's ~45 wake-ups was a
    // notice to MAIN ("Still training", "Waiting."), each a main turn. The tick is
    // the one agent main talks to: resume IT, and it resumes its own children.
    // The target's type comes from the session's subagents/<id>.meta.json; an
    // address with no meta file (a named teammate, a missing file) is let through.
    if (toolNameB === 'SendMessage') {
      const to = String(input?.tool_input?.to ?? '').trim();
      const tp = String(input?.transcript_path ?? '');
      if (to && tp.endsWith('.jsonl')) {
        const meta = _join(tp.slice(0, -'.jsonl'.length), 'subagents', `agent-${to}.meta.json`);
        if (_exists(meta)) {
          const targetType = String(JSON.parse(readFileSync(meta, 'utf8'))?.agentType ?? '')
            .replace(/^oh-my-evor:/, '');
          if (/^evor-/.test(targetType) && targetType !== 'evor-tick') {
            deny(
              `[EVOR GOVERNOR] ${targetType} belongs to the tick, so main does not resume it. ` +
                `Message the evor-tick agent that owns this tick instead: ${mainTickRoute(false)}; ` +
                `it resumes or waits on its own children. Messaging ` +
                `a tick's child makes every later notice from that child land in your context.`
            );
          }
        }
      }
    }

    // One agent owns a tick. While the tick is unfinished and its agent exists,
    // a second evor-tick for it would run beside the first and its children.
    // The agent is resumable by id even after a session restart.
    if ((toolNameB === 'Task' || toolNameB === 'Agent')
        && /evor-tick$/.test(String(input?.tool_input?.subagent_type ?? ''))) {
      const rd = resolveRunDir();
      const ts = rd && _exists(_join(rd, 'tick-state.json')) ? JSON.parse(readFileSync(_join(rd, 'tick-state.json'), 'utf8')) : null;
      const owner = ts && !isTickFinished(ts) && typeof ts.tick === 'number'
        ? currentTickAgent(input?.session_id, String(input?.transcript_path ?? ''), ts.tick)
        : null;
      // The tick agent is found again by the tick its description names.
      if (!/\btick\s*\d+/i.test(String(input?.tool_input?.description ?? ''))) {
        deny(
          `[EVOR GOVERNOR] Name the tick in the evor-tick description, e.g. ` +
            `description: "Tick ${ts && typeof ts.tick === 'number' ? (isTickFinished(ts) ? ts.tick + 1 : ts.tick) : 'N'}". ` +
            `The tick's agent is found again by that name.`
        );
      }
      if (owner && owner.tick === ts.tick) {
        deny(
          `[EVOR GOVERNOR] Tick ${ts.tick} already has its agent: ${owner.id}` +
            (owner.working ? ', and it or its children are still working' : '') +
            `. Resume it with SendMessage({ to: "${owner.id}", message: ... }) — it continues ` +
            `from its last completed step and passes your message to its children. A second ` +
            `tick agent would run beside it.`
        );
      }
    }

    // Leads belong to the boundary too — main spawning them directly is the same
    // leak by another route (it pulls their results into main's context).
    const LEADS = new Set([
      'evor-sage', 'evor-mutagen', 'evor-probe', 'evor-forge', 'evor-selector',
    ]);
    const spawnB = String(input?.tool_input?.subagent_type ?? '').replace(/^oh-my-evor:/, '');
    if ((toolNameB === 'Task' || toolNameB === 'Agent') && LEADS.has(spawnB)) {
      deny(
        `[EVOR GOVERNOR] ${spawnB} is spawned by the tick boundary, not by the mission ` +
          `orchestrator. ${mainTickRoute()}, and let it fan out — spawning leads directly pulls ` +
          `their results into your own context, which is exactly what the boundary exists to prevent.`
      );
    }
  }
} catch (err) {
  // Fail-open — a governor error must never block legitimate work, but a caught
  // exception must leave a trace or an inert guard is indistinguishable from a
  // permissive one (K-14).
  logError('role-rules', err);
}

// ── Metric hardening is applied by the tick, and only by the tick ────────────
//
// evor_harden_eval moves the run's eval_version and replaces the evaluator every
// later score is measured with. Probe and Sage PROPOSE it, Forge's team WRITES the
// stricter evaluator, and the tick — the loop that owns the step — APPLIES it. A
// proposer that could apply its own proposal, or a Forge that could seal its own
// evaluator, would be self-approval; main during a live mission follows pointers
// only. Main outside a live mission (maintenance) is not judged here.
try {
  const toolNameH = input?.tool_name ?? '';
  if (/(^|_)evor_harden_eval$/.test(toolNameH)) {
    const roleH = ((input?.agent_type ?? process.env.EVOR_AGENT_ROLE ?? '') || '').replace(/^oh-my-evor:/, '');
    const mainH = !roleH;
    if (!(roleH === 'evor-tick' || (mainH && !_missionLive))) {
      deny(
        `[EVOR GOVERNOR] evor_harden_eval is applied by the evor-tick agent. ` +
          (mainH
            ? `${mainTickRoute()}, and pass the hardening proposal as a pointer; the tick applies it.`
            : `${roleH} proposes a hardening (metric_hardening proposal) or writes the stricter evaluator; the tick applies it.`),
        { rule: 'harden-eval-tick-only', tool: toolNameH, agentType: roleH },
      );
    }
  }
  // During a live mission the general evaluator tools may only touch the
  // version in force: staging a new version's evaluator, or replacing the shared
  // score_plugin.py, outside evor_harden_eval would put an unreviewed metric one
  // call away from adoption.
  if (_missionLive && /(^|_)evor_((write|seal)_eval_script|scaffold_evaluator)$/.test(toolNameH)) {
    const tiH = input?.tool_input ?? {};
    const rd = resolveRunDir();
    const inForce = rd && _exists(_join(rd, 'goal-contract.json'))
      ? String(JSON.parse(readFileSync(_join(rd, 'goal-contract.json'), 'utf8'))?.eval_version ?? '')
      : '';
    const wantsPlugin = tiH?.target === 'score_plugin' || tiH?.overwrite_plugin === true;
    if (wantsPlugin || (inForce && String(tiH?.eval_version ?? 'v1') !== inForce)) {
      deny(
        `[EVOR GOVERNOR] While the mission runs, ${toolNameH.replace(/^mcp__plugin_oh-my-evor_evor__/, '')} ` +
          `touches only the eval version in force${inForce ? ` (${inForce})` : ''}` +
          (wantsPlugin ? ' and never score_plugin.py, the metric every version shares' : '') +
          '. A stricter evaluator under a new version is applied by evor-tick with evor_harden_eval, ' +
          'which takes the reviewed source with its rationale and evidence.',
        { rule: 'eval-script-version-in-force', tool: toolNameH },
      );
    }
  }
} catch (err) {
  logError('harden-eval-role', err);  // fail-open, but recorded
}

// ── §15C: Agent-kind spoofing guard (always-on when run is active) ────────────
// Prevents one role from writing into another role's artifact slot.
// Orchestrator (no agent_type) may write handoff kinds.
try {
  const toolNameS = input?.tool_name ?? '';
  const tiS = input?.tool_input ?? {};
  const agentTypeS = ((input?.agent_type ?? process.env.EVOR_AGENT_ROLE ?? '') || '').replace(/^oh-my-evor:/, '');
  const callerIsMain = !agentTypeS;

  // Suffix match, not exact. This guard previously compared against
  // `mcp__plugin_oh-my-evor_evor__write_artifact`, but the wire name is
  // `mcp__plugin_oh-my-evor_evor__evor_write_artifact` — the MCP server namespace
  // (`..._evor__`) plus the tool's own name (`evor_write_artifact`), so `evor_`
  // appears twice. The condition therefore never matched and the guard had never
  // fired: any role could write into any other role's artifact slot, which is a
  // direct self-approval vector — the exact P3 failure the review gates exist to
  // stop. Same silent-inertness class as the un-propagated EVOR_ACTIVE_RUN_ID.
  // Matching on the suffix keeps this working if the namespace is ever renamed.
  const isWriteToolS = /(^|_)evor_write_artifact$/.test(toolNameS);
  const isReadToolS = /(^|_)evor_read_artifact$/.test(toolNameS);
  const isArtifactTool = isWriteToolS || isReadToolS;

  if (isArtifactTool && tiS?.agent) {
    const claimedAgent = String(tiS.agent);

    // Map caller role → allowed agent values for artifact writes/reads (own slot only).
    const AGENT_ROLE_MAP = {
      'evor-sage':             new Set(['sage']),
      'evor-sage-junior':      new Set(['sage-junior']),
      'evor-mutagen':          new Set(['mutagen']),
      'evor-selector':         new Set(['selector']),
      'evor-probe':            new Set(['probe']),
      'evor-forge':            new Set(['forge']),
      'evor-forge-junior':     new Set(['forge-junior']),
      'evor-forge-architect':  new Set(['forge-architect']),
      'evor-forge-critic':     new Set(['forge-critic']),
      'evor-forge-analyst':    new Set(['forge-analyst']),
      'evor-acquirer':         new Set(['acquirer']),
    };

    // READ-only grants onto a specific upstream slot — never extends to writes.
    // Each entry is backed by an explicit read call in that role's own agent
    // prompt (agents/evor-*.md), not a blanket allow:
    //   - forge-junior reads the proposal (evor-forge.md:89) and, on a
    //     critic-rejected re-attempt, the critic's verdict (evor-forge.md:157).
    //   - forge-critic reads the proposal to run Check 1 — correctness vs
    //     proposal (evor-forge.md:123, evor-forge-critic.md Final_Checklist).
    // Read-only grants for upstream slots a role is INSTRUCTED to read. Each one
    // is justified by the spawn prompt the system itself issues in
    // agents/evor-forge.md — denying them means the orchestration tells an agent
    // to do something the governor then blocks, which is how 28 of one run's 44
    // EVOR GUARD denials were generated. Agents responded by reading files off
    // disk and relaying findings through SendMessage, putting artifact content
    // back into context — the exact thing the boundary exists to prevent.
    // Two structural rules, not a list of exceptions. Enumerating exceptions is
    // what made the first pass of this too narrow: it was harvested from
    // evor-forge.md alone, shipped, and a measured run still logged 46 denials —
    // 26 of them evor-sage unable to read its OWN sage-junior findings, which is
    // the "Sage grounding skipped" failure.
    //
    //   1. A LEAD READS ITS JUNIORS. An agent that spawns sub-agents has to
    //      aggregate what they produce; that is the entire reason it spawned them.
    //   2. A STAGE READS UPSTREAM STAGES. The 9-step loop is a pipeline —
    //      sage -> mutagen -> selector -> forge -> probe. Each stage's input is the
    //      previous stage's artifact.
    //
    // Still READ-only, still per (role -> specific slot), and still never a
    // blanket allow: nothing here lets a role read a slot that is neither its own
    // junior's nor upstream of it.
    const JUNIORS = {
      'evor-sage':   ['sage-junior'],
      'evor-forge':  ['forge-junior', 'forge-critic', 'forge-architect', 'forge-analyst'],
    };
    const PIPELINE = ['sage', 'mutagen', 'selector', 'forge', 'probe'];
    const upstreamOf = (slot) => PIPELINE.slice(0, Math.max(0, PIPELINE.indexOf(slot)));

    const READ_EXTRA_GRANTS = {};
    for (const [role, own] of Object.entries(AGENT_ROLE_MAP)) {
      const grants = new Set(JUNIORS[role] ?? []);
      // A sub-agent inherits its lead's stage position: forge-critic reviews for
      // forge, so it reads what forge reads.
      const slot = [...own][0];
      const stage = slot.replace(/-(junior|critic|architect|analyst)$/, '');
      for (const s of upstreamOf(stage)) grants.add(s);
      // Sibling verdicts go ONLY to the implementer, which has to act on them.
      // Reviewers deliberately do not read each other: three independent reviews
      // that can see each other's verdicts are one anchored review wearing three
      // hats, and this system's whole job is evaluating candidates honestly.
      if (slot.endsWith('-junior')) for (const sib of JUNIORS[`evor-${stage}`] ?? []) grants.add(sib);

      //   3. A REVIEWER READS WHAT IT REVIEWS. (Item 4.5.)
      //
      // The two rules above give a reviewer every UPSTREAM stage but not the
      // artifact it was spawned to review: `evor-forge-critic` could read sage,
      // mutagen and selector, and not `forge-junior`'s code or `forge`'s report.
      // The stage names are `forge`; the slots are `forge-junior`,
      // `forge-critic`, and the grant was computed over the former.
      //
      // Five of seven blocked reads in the field were then satisfied by `cat`
      // off disk — which is worse than allowing them, because the content ends
      // up in context ANYWAY, without passing the artifact tool, and the denial
      // has bought nothing but a detour. Reviewers still do not read EACH OTHER:
      // three independent reviews that can see each other's verdicts are one
      // anchored review wearing three hats.
      if (/-(critic|architect|analyst)$/.test(slot)) {
        grants.add(stage);                     // the lead's own report
        grants.add(`${stage}-junior`);         // the thing under review
      }

      grants.delete([...own][0]);
      if (grants.size) READ_EXTRA_GRANTS[role] = grants;
    }

    // FEEDBACK EDGE — the one place the pipeline legitimately runs backwards.
    //
    // Probe analyses tick N's telemetry and explains WHY a candidate behaved as it
    // did. Mutagen proposes tick N+1. Across ticks that is not backwards, it is the
    // loop closing: it is the only channel carrying causal explanation rather than
    // bare outcome. Without it Probe's analysis reaches Mutagen only if someone
    // distils it into a gotcha, which means only FAILURES survive the trip and the
    // dreamer is fed exclusively on what not to do.
    READ_EXTRA_GRANTS['evor-mutagen'] = new Set([...(READ_EXTRA_GRANTS['evor-mutagen'] ?? []), 'probe']);

    // RESEARCH EDGE. Within a tick, Mutagen runs BEFORE Sage: Sage answers the
    // investigation_queries Mutagen wrote, and since 1.2.11 those queries live in
    // Mutagen's own artifact. PIPELINE above puts sage upstream of mutagen, so
    // Sage was denied the one artifact it researches. When the tick skipped the
    // mutagen-to-sage handoff (binarization mission, tick 3), Sage found nothing
    // to research and exited.
    READ_EXTRA_GRANTS['evor-sage'] = new Set([...(READ_EXTRA_GRANTS['evor-sage'] ?? []), 'mutagen']);

    // ANALYSIS EDGE. Probe analyses the whole tick after training, and the
    // reviewers' reports (critic, architect, analyst) are part of what happened.
    // The stage rule granted Probe only `forge`, not the forge-* reviewer slots,
    // so it was denied them twice in tick 4 of the binarization mission.
    // Reviewers still do not read EACH OTHER; this is the analyst at the end of
    // the line, after every verdict is in.
    READ_EXTRA_GRANTS['evor-probe'] = new Set([...(READ_EXTRA_GRANTS['evor-probe'] ?? []),
      'forge-critic', 'forge-architect', 'forge-analyst']);
    // SEED-BUDGET EDGE. A recipe Probe promoted after a short-seed screen owes
    // its remaining seeds, and Selector budgets them. That verdict lives in the
    // previous tick's Probe artifact, so Selector reads Probe.
    READ_EXTRA_GRANTS['evor-selector'] = new Set([...(READ_EXTRA_GRANTS['evor-selector'] ?? []), 'probe']);
    // evor-tick is deliberately absent from AGENT_ROLE_MAP, so this guard skips it
    // entirely: the tick boundary reads every stage's artifact by design — that is
    // the context the orchestrator is denied and evor-tick absorbs on its behalf.

    if (!callerIsMain) {
      const allowed = AGENT_ROLE_MAP[agentTypeS];
      if (allowed) {
        const extra = isReadToolS ? READ_EXTRA_GRANTS[agentTypeS] : undefined;
        const permitted = allowed.has(claimedAgent) || (extra && extra.has(claimedAgent));
        if (!permitted) {
          // Name what the role CAN reach, so the denial redirects rather than stalls.
          const reachable = [...allowed, ...(extra ?? [])];
          deny(
            `[EVOR GUARD] The "${claimedAgent}" artifact slot is not accessible from your role. ` +
              (isReadToolS
                ? `Your role reads: ${reachable.join(', ')}.`
                : `Your role writes: ${[...allowed].join(', ')}.`)
          );
        }
      }
    }
  }
} catch (err) {
  logError('agent-kind-spoofing', err);  // fail-open, but recorded
}

// ── §17B: updatedInput — inject missing run_id/mission_id into evor_* calls ──
// When an evor_* tool call omits run_id or mission_id but the active run is set
// in env, inject them automatically rather than letting the tool fail.
// Fail-open: only emit updatedInput when we're confident it's safe.
try {
  const toolNameU = input?.tool_name ?? '';
  const tiU = input?.tool_input ?? {};

  if (
    /^mcp__plugin_oh-my-evor_evor__/.test(toolNameU) &&
    _activeRunId &&
    (tiU?.run_id === undefined || tiU?.run_id === null || tiU?.run_id === '')
  ) {
    // Only inject if the tool plausibly accepts run_id (most evor tools do).
    // evor_init_run creates a run: a run_id there overrides the new run's id, so
    // filling it from the active run handed a new mission the previous run's id.
    const NO_RUN_ID_TOOLS = new Set([
      'mcp__plugin_oh-my-evor_evor__evor_capability',
      'mcp__plugin_oh-my-evor_evor__evor_preflight',
      'mcp__plugin_oh-my-evor_evor__evor_doctor',
      'mcp__plugin_oh-my-evor_evor__evor_init_run',
    ]);
    if (!NO_RUN_ID_TOOLS.has(toolNameU)) {
      const mId = process.env.EVOR_MISSION_ID ?? '';
      const injected = {
        ...tiU,
        run_id: _activeRunId,
        ...(mId && tiU?.mission_id === undefined ? { mission_id: mId } : {}),
      };
      process.stdout.write(
        JSON.stringify({
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            updatedInput: injected,
          },
        }) + '\n'
      );
      process.exit(0);
    }
  }
} catch (err) {
  logError('updated-input-injection', err);  // fail-open, but recorded
}

// ── Item 4.4 (continued): apply the recorded repair, last ───────────────────
// Reached only if no rule above denied or asked. Emitting earlier would let a
// repair short-circuit the guards, which is how a fix becomes a bypass.
try {
  if (pendingPromptInherit && !pendingNameStrip) {
    const ti2 = input?.tool_input ?? {};
    logDecision({
      verdict: 'allow',
      rule: 'generic-spawn-inherits',
      spawnType: pendingPromptInherit.spawnType,
      parent: pendingPromptInherit.parent,
    });
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          updatedInput: {
            ...ti2,
            prompt: `${pendingPromptInherit.inherited}\n\n${String(ti2.prompt ?? '')}`,
          },
        },
      }) + '\n'
    );
    process.exit(0);
  }

  if (pendingNameStrip) {
    const { name: _dropped, ...withoutName } = input?.tool_input ?? {};
    logDecision({
      verdict: 'allow',
      rule: 'spawn-name-stripped',
      spawnType: pendingNameStrip.spawnType,
      strippedName: pendingNameStrip.name,
      note: 'name removed so the agent keeps its own model tier; spawn allowed',
    });
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          updatedInput: withoutName,
          // additionalContext is the PreToolUse field the model reads; a
          // systemMessage nested here was dropped by the CLI.
          additionalContext:
            `[EVOR GOVERNOR] Dropped \`name="${pendingNameStrip.name}"\` from the ` +
            `oh-my-evor:${pendingNameStrip.spawnType} spawn. Passing \`name\` makes it ` +
            `an in-process teammate, so it inherits the session model instead of its ` +
            `own \`model:\` frontmatter — silently losing its tier. The spawn ` +
            `proceeded without it; address the agent by its subagent_type.`,
        },
      }) + '\n'
    );
    process.exit(0);
  }
} catch (err) {
  logError('spawn-name-strip', err);  // fail-open, but recorded
}

process.exit(0);
