#!/usr/bin/env node
/**
 * oh-my-evor PostToolBatch hook — Forge parallel-review gate
 *
 * Fires when the evor-forge agent's parallel {forge-critic, forge-analyst,
 * forge-architect} review batch resolves. Reads the batch results and tells
 * Forge whether to proceed (all passed) or route back (any rejected).
 *
 * Kill switches (checked FIRST):
 *   DISABLE_EVOR=1                    → exit 0 immediately
 *   EVOR_SKIP_HOOKS=post-tool-batch   → exit 0 immediately
 *
 * Active-run gated: inert when EVOR_ACTIVE_RUN_ID is unset.
 * Fail-open: any error → exit 0.
 *
 * Output format (advisory):
 *   { hookSpecificOutput: { hookEventName: "PostToolBatch", additionalContext: "…" } }
 *
 * §19: NO `python -m evor` in any agent-facing string.
 */

import { readFileSync } from 'fs';

// ── Kill switches ─────────────────────────────────────────────────────────────
if (process.env.DISABLE_EVOR) process.exit(0);

const skipHooks = (process.env.EVOR_SKIP_HOOKS ?? '').split(',').map(s => s.trim());
if (skipHooks.includes('post-tool-batch')) process.exit(0);

// ── Active run guard ──────────────────────────────────────────────────────────
if (!(process.env.EVOR_ACTIVE_RUN_ID ?? '')) process.exit(0);

// ── Parse STDIN payload ───────────────────────────────────────────────────────
let input;
try {
  const raw = readFileSync(0, 'utf8');
  input = JSON.parse(raw || '{}');
} catch {
  process.exit(0); // fail-open
}

try {
  // PostToolBatch payload: { tool_results: [{ tool_name, tool_input, tool_response, success? }] }
  const results = Array.isArray(input?.tool_results) ? input.tool_results : [];

  // Only act when this is the forge reviewer batch (critic + analyst + architect)
  const REVIEWER_TOOLS = new Set([
    'mcp__plugin_oh-my-evor_evor__write_artifact',
    // evor_write_artifact calls from the three reviewers
  ]);

  // Detect reviewers by agent_type or tool name patterns in the batch
  const reviewerResults = results.filter(r => {
    const toolName = String(r?.tool_name ?? '');
    const agentType = String(r?.agent_type ?? '');
    const agent = String(r?.tool_input?.agent ?? '');
    // Match forge-critic, forge-analyst, forge-architect artifact writes
    return (
      toolName === 'mcp__plugin_oh-my-evor_evor__write_artifact' &&
      /forge-(critic|analyst|architect)/.test(agent || agentType)
    );
  });

  if (reviewerResults.length === 0) {
    // Not a reviewer batch — exit silently
    process.exit(0);
  }

  // Check for rejections: look in tool_response for a verdict field
  const rejections = [];
  for (const r of reviewerResults) {
    const resp = r?.tool_response;
    const payload = r?.tool_input?.payload ?? {};
    const agent = String(r?.tool_input?.agent ?? '');
    const verdict = payload?.verdict ?? resp?.verdict ?? payload?.decision ?? '';
    if (/reject|fail|no\b/i.test(String(verdict))) {
      const reason = payload?.reason ?? payload?.reasons?.[0] ?? 'see artifact';
      rejections.push({ reviewer: agent, reason: String(reason).slice(0, 120) });
    }
  }

  let additionalContext;
  if (rejections.length === 0) {
    additionalContext =
      '[FORGE GATE] All reviewers passed. ' +
      'Proceed: call evor_record_node to register the candidate, then evor_run_start to launch evaluation. ' +
      'Watch the launched run with the native Monitor tool.';
  } else {
    const details = rejections
      .map(r => `${r.reviewer}: ${r.reason}`)
      .join('; ');
    additionalContext =
      `[FORGE GATE] Reviewer(s) rejected the candidate — do NOT call evor_run_start yet. ` +
      `Route back to forge-junior with specific feedback: ${details}. ` +
      `Resolve the defects, re-run lsp_diagnostics, then re-fan-out the reviewers.`;
  }

  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PostToolBatch',
        additionalContext,
      },
    }) + '\n'
  );
} catch {
  // Fail-open
}

process.exit(0);
