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
import { resolveActiveRun } from './lib/active-run.mjs';

// ── Kill switches ─────────────────────────────────────────────────────────────
if (process.env.DISABLE_EVOR) process.exit(0);
const skipHooks = (process.env.EVOR_SKIP_HOOKS ?? '').split(',').map(s => s.trim());
if (skipHooks.includes('pre-tool-use')) process.exit(0);

// ── Active run guard — governor only applies during an active evor run ─────────
const _activeRunId = resolveActiveRun().runId;
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

  // Bash that runs training/model code (the guard blocks python -m evor outright).
  const runsTraining =
    /\bpython[0-9.]*\b/.test(cmd) &&
    /(\.py\b|\btick\.py\b|\btrain\b|\btorch\b|\.fit\(|\.pt\b|torchvision)/.test(cmd);

  // ── Spawn-hierarchy gate — child agents may be spawned ONLY by their parent ──
  const spawnType = String(ti?.subagent_type ?? '').replace(/^oh-my-evor:/, '');

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
    deny(
      `[EVOR GOVERNOR] Spawn oh-my-evor:${spawnType} WITHOUT the \`name\` parameter (got ` +
        `name="${String(ti.name)}"). Passing \`name\` makes it an in-process teammate: the hook ` +
        `matchers stop matching it and it inherits the session model instead of its own \`model:\` ` +
        `frontmatter, so both enforcement and model tiering are silently lost. Re-issue the same ` +
        `call with \`name\` dropped — subagent_type alone identifies the agent.`
    );
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
          `spawn it directly — delegate the work to ${requiredParent}, which owns and fans out its own sub-team.`
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
    // The broad orchestrator-only rule runs AFTER the .evor write-guard below —
    // see §1.3 there. Denying here would shadow the more specific guard and
    // report the wrong rule as the cause.
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
        `[EVOR GUARD] Direct write to an evor state file is not allowed. ` +
        `Use ${replacement} to write this artifact through the proper channel.`
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
          `[EVOR GUARD] Direct CLI invocation is not allowed. Use ${replacement} instead.`
        );
      }

      if (BASH_IMPORT_EVOR_RE.test(cmdG)) {
        deny(
          `[EVOR GUARD] This operation is not permitted. Use the appropriate evor_* MCP tool instead.`
        );
      }

      if (
        (BASH_WRITE_RE.test(cmdG) || BASH_WRITE_FUNCS_RE.test(cmdG) || BASH_CP_MV_RE.test(cmdG)) &&
        !/\.evor[/\\]worktrees[/\\]/.test(cmdG)
      ) {
        deny(
          `[EVOR GUARD] This operation is not permitted. Use the appropriate evor_* MCP tool instead.`
        );
      }
    }
  } catch {
    // Fail-open — guard error must never block legitimate work
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
  const isMainO = !(input?.agent_type ?? '');
  if (isMainO && (toolNameO === 'Bash' || toolNameO === 'Write' || toolNameO === 'Edit')) {
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
      `[EVOR GOVERNOR] Evor is orchestrator-only: it spawns agents and records results, and does ` +
        `not run ${toolNameO} itself (${target}). Delegate this to the agent that owns it — ` +
        `Task(subagent_type="oh-my-evor:evor-probe") to inspect run state or logs, "…evor-forge" for ` +
        `code and training, "…evor-sage" for evidence. Read run state through the evor_* MCP tools ` +
        `rather than the shell.`
    );
  }
} catch {
  // Fail-open — a governor error must never block legitimate work.
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
  const isMainB = !(input?.agent_type ?? '');
  if (isMainB) {
    const BOUNDARY_ABSORBED = new Set([
      'mcp__plugin_oh-my-evor_evor__evor_read_artifact',
      'mcp__plugin_oh-my-evor_evor__evor_tree_read',
      'mcp__plugin_oh-my-evor_evor__evor_state_read',
    ]);
    if (BOUNDARY_ABSORBED.has(toolNameB)) {
      deny(
        `[EVOR GOVERNOR] ${toolNameB.replace('mcp__plugin_oh-my-evor_evor__', '')} belongs inside the ` +
          `tick boundary, not in the mission orchestrator. Spawn ` +
          `Task(subagent_type="oh-my-evor:evor-tick") for the tick; it reads artifacts, tree and ` +
          `state on your behalf and returns a status line plus pointers. If you need detail after ` +
          `the fact, it is behind a pointer the boundary already returned.`
      );
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
          `orchestrator. Spawn Task(subagent_type="oh-my-evor:evor-tick") and let it fan out — ` +
          `spawning leads directly pulls their results into your own context, which is exactly ` +
          `what the boundary exists to prevent.`
      );
    }
  }
} catch {
  // Fail-open — a governor error must never block legitimate work.
}

// ── §15C: Agent-kind spoofing guard (always-on when run is active) ────────────
// Prevents one role from writing into another role's artifact slot.
// Orchestrator (no agent_type) may write handoff kinds.
try {
  const toolNameS = input?.tool_name ?? '';
  const tiS = input?.tool_input ?? {};
  const agentTypeS = (input?.agent_type ?? '').replace(/^oh-my-evor:/, '');
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
    // evor-tick is deliberately absent from AGENT_ROLE_MAP, so this guard skips it
    // entirely: the tick boundary reads every stage's artifact by design — that is
    // the context the orchestrator is denied and evor-tick absorbs on its behalf.

    if (!callerIsMain) {
      const allowed = AGENT_ROLE_MAP[agentTypeS];
      if (allowed) {
        const extra = isReadToolS ? READ_EXTRA_GRANTS[agentTypeS] : undefined;
        const permitted = allowed.has(claimedAgent) || (extra && extra.has(claimedAgent));
        if (!permitted) {
          deny(
            `[EVOR GUARD] This artifact slot is not accessible from your role. Use the correct evor_* tool for your role.`
          );
        }
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
