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
const _activeRunId = process.env.EVOR_ACTIVE_RUN_ID ?? '';
if (!_activeRunId) process.exit(0);

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
    // Forge LEAD (an orchestrator of its dev team) and the architect/critic/analyst —
    // emits JSON artifacts and delegates code to the junior. The lead launches evaluation
    // through the evor_run_start MCP tool, not raw training.
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
            ? 'Launch evaluation with the evor_run_start tool; candidate code is written by evor-forge-junior.'
            : 'Only evor-forge-junior runs candidate code.')
      );
    }
  }
} catch {
  // Fail-open — a governor error must never block legitimate work.
}

// ── §3 / §15C: .evor write-guard (ON by default; set EVOR_GUARD_DIRECT_WRITES=0 to disable) ──
// Denies direct writes to .evor/runs/** state artifacts and top-level .evor/*.json.
// ALLOWS .evor/worktrees/** (Forge's code surface) + cache markers.
const _guardDisabled = ['0', 'off', 'false', 'no'].includes(
  (process.env.EVOR_GUARD_DIRECT_WRITES ?? '').trim().toLowerCase()
);
if (!_guardDisabled) {
  try {
    // Path patterns for protected artifacts
    const PROTECTED_RUNS_RE = /[/\\]\.evor[/\\]runs[/\\]/;
    const PROTECTED_TOP_RE  = /[/\\]\.evor[/\\][^/\\]+\.json$/;
    const ALLOW_WORKTREES   = /[/\\]\.evor[/\\]worktrees[/\\]/;
    // Allowed markers: .env, .deps-ok, .uv-ok, .workspace-class, hook-state, cache files
    const ALLOW_MARKERS_RE  = /[/\\]\.evor[/\\]\.[^/\\]+$|[/\\]\.evor[/\\][^/\\]+-throttle\.json$|[/\\]\.evor[/\\]perm-denied-throttle\.json$|[/\\]\.evor[/\\]user-prompt-throttle\.json$/;

    // §15C: Bash write-pattern scanner
    const BASH_WRITE_RE = /(?:>|>>|tee\s)\s*['"]?[^'";\s]*\.evor\/(?:runs|[^/]+\.json)/;
    const BASH_WRITE_FUNCS_RE = /(?:write_text|open\([^)]*\.evor[^)]*['"w]|json\.dump[^)]*\.evor)/;
    const BASH_CP_MV_RE = /\b(?:cp|mv|shutil\.(?:copy|move|copyfile|copytree))\b[^;#\n]*\.evor[/\\](?:runs|[^/\s]+\.json)/;
    // §15C: python -m evor block (python, python3, python3.x etc.) — any invocation
    const BASH_PYTHON_EVOR_RE = /python[0-9.]*\s+-m\s+evor(\b|\.)/;
    // §15C: import evor / from evor... block
    const BASH_IMPORT_EVOR_RE = /\b(import\s+evor|from\s+evor[\s.])/;

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
        `[EVOR GUARD] Direct write to "${filePathG}" is not allowed. ` +
        `Use ${replacement} to write this artifact through the proper channel. ` +
        `(.evor/worktrees/<node_id>/ is the only direct-write surface.)`
      );
    }

    if (toolNameG === 'Bash') {
      if (BASH_PYTHON_EVOR_RE.test(cmdG)) {
        // Extract what they're trying to do to name the right tool
        let replacement = 'the appropriate evor_* MCP tool';
        if (/evor\s+run\b/.test(cmdG)) replacement = 'evor_run_start + Monitor';
        else if (/evor\s+validate/.test(cmdG)) replacement = 'evor_validate';
        else if (/evor\s+doctor/.test(cmdG)) replacement = 'evor_doctor';
        else if (/evor\.wiki/.test(cmdG)) replacement = 'evor_wiki_add or evor_wiki_query';
        deny(
          `[EVOR GUARD] Bash: direct CLI invocation is not allowed. ` +
          `Use ${replacement} to perform this operation through the MCP interface.`
        );
      }

      if (BASH_IMPORT_EVOR_RE.test(cmdG)) {
        deny(
          `[EVOR GUARD] Bash: importing the evor package directly is not allowed. ` +
          `Call the appropriate evor_* MCP tool instead of accessing the package internals.`
        );
      }

      if (
        (BASH_WRITE_RE.test(cmdG) || BASH_WRITE_FUNCS_RE.test(cmdG) || BASH_CP_MV_RE.test(cmdG)) &&
        !/\.evor[/\\]worktrees[/\\]/.test(cmdG)
      ) {
        deny(
          `[EVOR GUARD] Bash: writing to .evor/ state files directly is not allowed. ` +
          `Use the appropriate evor_* tool (evor_write_artifact, evor_state_write, evor_record_node, etc.) ` +
          `to modify evor state. (.evor/worktrees/ is the only direct-write surface.)`
        );
      }
    }
  } catch {
    // Fail-open — guard error must never block legitimate work
  }
}

// ── §15C: Agent-kind spoofing guard (always-on when run is active) ────────────
// Prevents one role from writing into another role's artifact slot.
// Orchestrator (no agent_type) may write handoff kinds.
try {
  const toolNameS = input?.tool_name ?? '';
  const tiS = input?.tool_input ?? {};
  const agentTypeS = (input?.agent_type ?? '').replace(/^oh-my-evor:/, '');
  const callerIsMain = !agentTypeS;

  if (
    (toolNameS === 'mcp__plugin_oh-my-evor_evor__write_artifact' ||
     toolNameS === 'mcp__plugin_oh-my-evor_evor__read_artifact') &&
    tiS?.agent
  ) {
    const claimedAgent = String(tiS.agent);

    // Map caller role → allowed agent values for artifact writes/reads
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

    if (!callerIsMain) {
      const allowed = AGENT_ROLE_MAP[agentTypeS];
      if (allowed && !allowed.has(claimedAgent)) {
        deny(
          `[EVOR GUARD] Agent-kind mismatch: ${agentTypeS} may not write/read artifact slot ` +
          `"${claimedAgent}". Use agent="${[...allowed][0]}" to match your role. ` +
          `(Only the orchestrator may write handoff kinds cross-role.)`
        );
      }
    }
  }
} catch {
  // Fail-open — spoofing guard must never crash the session
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
    // Only inject if the tool plausibly accepts run_id (most evor tools do)
    const NO_RUN_ID_TOOLS = new Set([
      'mcp__plugin_oh-my-evor_evor__capability',
      'mcp__plugin_oh-my-evor_evor__preflight',
      'mcp__plugin_oh-my-evor_evor__doctor',
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
} catch {
  // Fail-open — updatedInput injection errors must never block calls
}

process.exit(0);
