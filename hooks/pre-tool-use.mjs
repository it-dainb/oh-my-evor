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
import { resolveWriteTargets } from './lib/write-targets.mjs';
import { mayPerform, operationFor } from './lib/operations.mjs';
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

function deny(reason, meta = {}) {
  logDecision({ verdict: 'deny', reason, ...meta });
  // Item 4.8: a denial is evidence that an agent wants something it cannot have
  // — either a rule that is wrong or an affordance that is missing. The field
  // run's top rule fired 82 times and produced no data at all.
  emitDenialSignal({
    rule: meta.rule,
    tool: meta.tool ?? input?.tool_name,
    target: meta.target,
    agentType: input?.agent_type,
    reason,
  });
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
  const agentType = (input?.agent_type ?? '').replace(/^oh-my-evor:/, '');
  const isMain = !agentType; // no agent_type ⇒ the main Evor orchestrator

  const filePath = String(ti?.file_path ?? '');
  const cmd = String(ti?.command ?? '');

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
  const pyInvocation = cmdUnquoted.match(/\bpython[0-9.]*\s+(.*)$/);
  const runsTraining =
    !!pyInvocation &&
    !INSPECTION_MODULES.test(pyInvocation[1].trim()) &&
    // `-m evor…` is deliberately NOT here: `python -m evor run` is a CLI
    // invocation, not training, and it is owned by the EVOR GUARD rule below,
    // which names the right replacement tool (evor_run_start + Monitor). Claiming
    // it here would make this rule fire first and report the wrong cause.
    /(\S+\.py\b|-m\s+\S*train\S*)/.test(pyInvocation[1]);

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
    const known = agentType === '' || /^evor-/.test(agentType);
    if (operation && known && !mayPerform(agentType, operation)) {
      const who = agentType || 'Evor (orchestrator)';
      // Main's explanation is that it is orchestrator-only — the same phrase the
      // tool-shaped rule used, because it is the right explanation and PM3 says
      // a denial the model cannot act on stalls the run.
      const roleNote = agentType
        ? ''
        : ' Evor is orchestrator-only: it spawns agents and records results.';
      const ADVICE = {
        'author-code': 'Only evor-forge-junior authors candidate code, and only on its own surface. ' +
                       'Emit your JSON artifact instead, or delegate the code to forge-junior.',
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
      deny(
        `[EVOR GOVERNOR] ${who} may not perform the operation "${operation}"` +
          (opTargets[0] ? ` (target: ${opTargets[0]})` : '') + '.' + roleNote + ' ' +
          (ADVICE[operation] ?? '') +
          ' This rule is scoped to the OPERATION, not to a tool name: the same act through ' +
          'Bash, a heredoc or a redirect is the same act, which is why naming the tool did ' +
          'not hold.',
        { rule: `operation:${operation}`, tool, agentType, target: opTargets[0] },
      );
    }
  } catch (err) {
    logError('operation-authority', err);  // fail-open, but recorded
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
    const BASH_PYTHON_EVOR_RE = /python[0-9.]*\s+-m\s+evor(\b|\.)/;
    // §15C: import evor / from evor... block
    const BASH_IMPORT_EVOR_RE = /\b(import\s+evor|from\s+evor[\s.])/;
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
        if (/evor\s+run\b/.test(cmdG)) replacement = 'evor_run_start + Monitor';
        else if (/evor\s+validate/.test(cmdG)) replacement = 'evor_validate';
        else if (/evor\s+doctor/.test(cmdG)) replacement = 'evor_doctor';
        else if (/evor\.wiki/.test(cmdG)) replacement = 'evor_wiki_add or evor_wiki_query';
        deny(
          `[EVOR GUARD] Direct CLI invocation is not allowed. Use ${replacement} instead.`
        );
      }

      if (BASH_IMPORT_EVOR_RE.test(cmdG) && BASH_RUNS_PYTHON_RE.test(cmdG)) {
        deny(
          `[EVOR GUARD] This operation is not permitted. Use the appropriate evor_* MCP tool instead.`
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
} catch (err) {
  // Fail-open — a governor error must never block legitimate work, but a caught
  // exception must leave a trace or an inert guard is indistinguishable from a
  // permissive one (K-14).
  logError('role-rules', err);
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
          systemMessage:
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
