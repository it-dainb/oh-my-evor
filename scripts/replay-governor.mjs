#!/usr/bin/env node
/**
 * scripts/replay-governor.mjs — replay a recorded session through the CURRENT
 * governor and report what would now be denied.
 *
 *   node scripts/replay-governor.mjs <session.jsonl> [...]
 *
 * This answers "would the new build repeat the old mistake?" against real
 * recorded behaviour rather than against a hand-written scenario. Every
 * `tool_use` block in the log is replayed as a PreToolUse payload with its
 * original agent attribution, and the decision is tallied.
 *
 * What it is NOT: evidence that the new build behaves well. It shows only that
 * the calls the old run actually made would now be blocked or allowed. A model
 * facing a denial will do something else, and that something is not in this log.
 * Real behaviour needs a live tick (Phase 2).
 */

import { readFileSync } from 'fs';
import { spawnSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';

const HOOK = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'hooks', 'pre-tool-use.mjs');

const files = process.argv.slice(2);
if (files.length === 0) {
  process.stderr.write('usage: replay-governor.mjs <session.jsonl> [...]\n');
  process.exit(2);
}

// One temp run for the whole replay — the governor only needs to resolve an
// active run id, and re-creating it per call would dominate the runtime.
const dir = mkdtempSync(join(tmpdir(), 'evor-replay-'));
const evorRoot = join(dir, '.evor');
mkdirSync(join(evorRoot, 'runs', 'm1', 'r1'), { recursive: true });
writeFileSync(join(evorRoot, 'active-run.json'), JSON.stringify({ run_id: 'r1', mission_id: 'm1' }));

function decide(payload) {
  const r = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify(payload),
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', EVOR_ROOT: evorRoot },
    encoding: 'utf8',
    timeout: 10_000,
  });
  const out = (r.stdout ?? '').trim();
  if (!out) return { decision: 'allow' };
  try {
    const parsed = JSON.parse(out.split('\n').pop());
    return {
      decision: parsed?.hookSpecificOutput?.permissionDecision ?? 'allow',
      reason: parsed?.hookSpecificOutput?.permissionDecisionReason ?? '',
    };
  } catch {
    return { decision: 'allow' };
  }
}

const tally = { replayed: 0, denied: 0, allowed: 0 };
const deniedByTool = {};
const deniedByRule = {};
const samples = [];
/**
 * Orchestrator leaf calls that are STILL allowed. This is the number that
 * matters: AC2 targets zero, and anything here is either a deliberate exemption
 * or a hole in the gate. Reported as commands, not a count, so a reviewer can
 * tell the two apart.
 */
const allowedOrchestratorLeaf = [];
const LEAF = new Set(['Bash', 'Write', 'Edit']);

try {
  for (const file of files) {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      let rec;
      try {
        rec = JSON.parse(line);
      } catch {
        continue;
      }
      if (rec.type !== 'assistant' || !rec.message) continue;

      for (const b of rec.message.content ?? []) {
        if (b?.type !== 'tool_use') continue;

        const payload = { tool_name: b.name, tool_input: b.input ?? {} };
        // A sidechain block is a subagent's own call. The log does not name the
        // agent, so it is replayed as a generic subagent rather than as main —
        // attributing it to main would manufacture denials that never applied.
        if (rec.isSidechain) payload.agent_type = 'oh-my-evor:evor-sage';

        const { decision, reason } = decide(payload);
        tally.replayed++;
        if (decision === 'deny') {
          tally.denied++;
          deniedByTool[b.name] = (deniedByTool[b.name] ?? 0) + 1;
          const rule = (reason.match(/\[EVOR [A-Z]+\]\s*(.{0,60})/) ?? [, reason.slice(0, 60)])[1];
          deniedByRule[rule] = (deniedByRule[rule] ?? 0) + 1;
          if (samples.length < 8) samples.push({ tool: b.name, reason: reason.slice(0, 160) });
        } else {
          tally.allowed++;
          if (!rec.isSidechain && LEAF.has(b.name)) {
            allowedOrchestratorLeaf.push(
              b.name === 'Bash' ? String(b.input?.command ?? '').slice(0, 120) : `${b.name} ${b.input?.file_path ?? ''}`,
            );
          }
        }
      }
    }
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

process.stdout.write(
  JSON.stringify(
    {
      files,
      tally,
      denied_by_tool: deniedByTool,
      denied_by_rule: deniedByRule,
      allowed_orchestrator_leaf: allowedOrchestratorLeaf,
      samples,
      caveat:
        'Replay shows which recorded calls the current governor would block. It cannot show what ' +
        'the model would have done instead — that requires a live tick.',
    },
    null,
    2,
  ) + '\n',
);
