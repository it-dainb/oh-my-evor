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

import { readFileSync } from 'fs';

// ── Kill switches ─────────────────────────────────────────────────────────────
if (process.env.DISABLE_EVOR) process.exit(0);
const skipHooks = (process.env.EVOR_SKIP_HOOKS ?? '').split(',').map(s => s.trim());
if (skipHooks.includes('pre-tool-use')) process.exit(0);

// ── Active run guard — governor only applies during an active evor run ─────────
if (!(process.env.EVOR_ACTIVE_RUN_ID ?? '')) process.exit(0);

let input;
try {
  const raw = readFileSync(0, 'utf8');
  input = JSON.parse(raw || '{}');
} catch {
  process.exit(0); // fail-open
}

function deny(reason) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: reason,
      },
    }) + '\n'
  );
  process.exit(0);
}

try {
  const tool = input?.tool_name ?? '';
  const ti = input?.tool_input ?? {};
  const agentType = (input?.agent_type ?? '').replace(/^oh-my-evor:/, '');
  const isMain = !agentType; // no agent_type ⇒ the main Evor orchestrator

  const filePath = String(ti?.file_path ?? '');
  const cmd = String(ti?.command ?? '');

  // Specialist-action detectors --------------------------------------------------
  // A .py file OR a per-role sub-agent artifact path == authored specialist output.
  const isCodeOrArtifactWrite =
    /\.py$/.test(filePath) ||
    /\/ticks\/[^/]+\/(mutagen|sage|selector|probe|forge)\//.test(filePath);

  // Bash that runs training/model code (but NOT the evor CLI, which is orchestration).
  const runsTraining =
    /\bpython[0-9.]*\b/.test(cmd) &&
    !/\bpython[0-9.]*\s+-m\s+evor(\b|\.)/.test(cmd) &&
    /(\.py\b|\btick\.py\b|\btrain\b|\btorch\b|\.fit\(|\.pt\b|torchvision)/.test(cmd);

  // ── Spawn-hierarchy gate — child agents may be spawned ONLY by their parent ──
  const spawnType = String(ti?.subagent_type ?? '').replace(/^oh-my-evor:/, '');
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
          `spawn it directly — delegate the work to ${requiredParent}, which owns and fans out its own sub-team.`
      );
    }

    // evor-acquirer is dual-parent: Forge (enrich-train) OR main Evor (harden-test).
    if (spawnType === 'evor-acquirer' && !(isMain || agentType === 'evor-forge')) {
      deny(
        `[EVOR GOVERNOR] evor-acquirer may be spawned only by Forge (enrich-train) or Evor ` +
          `(harden-test). ${agentType || 'this agent'} must not spawn it.`
      );
    }
  }

  // ── Research-delegation gate — Mutagen never researches; it delegates to Sage ──
  if (agentType === 'evor-mutagen') {
    if (/Consensus__search|Exa__web|WebSearch|WebFetch|evor_cite/i.test(tool)) {
      deny(
        `[EVOR GOVERNOR] Mutagen does not gather evidence. Emit investigation_queries[] (research angles) ` +
          `for Sage — the orchestrator routes them to Sage, who fans out to Sage-junior researchers. Do not research directly.`
      );
    }
  }

  if (isMain) {
    // Evor is orchestrator-only — it must delegate all authoring/training.
    if ((tool === 'Write' || tool === 'Edit') && isCodeOrArtifactWrite) {
      deny(
        `[EVOR GOVERNOR] Evor is orchestrator-only and must not author code or sub-agent artifacts ` +
          `(${filePath}). Spawn the specialist via Task(subagent_type="oh-my-evor:evor-forge") for code/` +
          `training, or the matching evor-mutagen/sage/selector/probe for its artifact. That sub-agent ` +
          `writes this file — you coordinate and record it.`
      );
    }
    if (tool === 'Bash' && runsTraining) {
      deny(
        `[EVOR GOVERNOR] Evor must not run training/model code inline. Spawn ` +
          `Task(subagent_type="oh-my-evor:evor-forge", …) to implement and run this candidate; Forge writes ` +
          `nodes/<id>/results.json + telemetry, then you call evor_record_node / evor_record_eval.`
      );
    }
  } else if (agentType !== 'evor-forge-junior') {
    // Only evor-forge-junior authors/runs candidate CODE. Everyone else — including the
    // Forge LEAD (now an orchestrator of its dev team) and the architect/critic/analyst —
    // emits JSON artifacts and delegates code to the junior. The lead runs the harness
    // via `python -m evor run …` (allowed; not raw training).
    const isForgeLead = agentType === 'evor-forge';
    if ((tool === 'Write' || tool === 'Edit') && /\.py$/.test(filePath)) {
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
            ? 'Run the harness via `python -m evor run …`; code is written by evor-forge-junior.'
            : 'Only evor-forge-junior runs candidate code.')
      );
    }
  }
} catch {
  // Fail-open — a governor error must never block legitimate work.
}

process.exit(0);
