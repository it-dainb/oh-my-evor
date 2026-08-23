#!/usr/bin/env node
/**
 * ci/forge-eval-analyze.mjs — read ci/out/forge-eval-*.json and report the tier
 * comparison honestly.
 *
 * WHY THIS IS SEPARATE FROM THE REPORT THE MATRIX PRINTS: gate failures CASCADE.
 * A candidate that fails `runs` — the code did not execute — necessarily also
 * fails auc_floor (no score), telemetry_written (nothing ran to write it),
 * telemetry_fields and telemetry_steps. That is ONE defect, and the raw
 * gate_failures tally counts it as five. Reporting "haiku failed telemetry_written
 * 12 times" when the code never ran at all would send the next fix at the
 * telemetry prompt instead of at whatever stopped it executing.
 *
 * So every attempt is attributed to a single ROOT CAUSE, in precedence order,
 * and the per-gate view is reported only for attempts that got far enough for
 * that gate to mean anything.
 *
 *   node ci/forge-eval-analyze.mjs [report.json]
 */

import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { effortIsInert, canonicalTierLabel } from './agent-eval.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Precedence order. The FIRST match is the root cause; everything after it is
 * downstream of that failure and is not counted as a separate defect.
 */
const ROOT_CAUSE_ORDER = [
  ['cli_error', (r) => r.status === 'cli_error'],
  // BEFORE did_not_run, and deliberately named differently. A candidate killed
  // at the scoring deadline produces a `runs` failure that is byte-identical to
  // code that threw on line 1 — but one is evidence about the MODEL and the
  // other is evidence about the MACHINE. Folding them together is how a
  // 105-call matrix reported correct code as broken. Compare the count here
  // against report.host_calibration before reading anything into a tier's
  // failure rate.
  ['scoring_timeout', (r) => r.timed_out === true],
  ['did_not_run', (r) => r.result?.failed_gates?.includes('runs')],
  ['integrity_violation', (r) =>
    ['evaluate_untouched', 'frozen_splits_untouched'].some((g) => r.result?.failed_gates?.includes(g))],
  ['stray_writes', (r) => r.result?.failed_gates?.includes('no_stray_writes')],
  ['ignored_proposal_exclusion', (r) => r.result?.failed_gates?.includes('forbidden_files_absent')],
  ['no_telemetry', (r) => r.result?.failed_gates?.includes('telemetry_written')],
  ['bad_telemetry', (r) =>
    ['telemetry_fields', 'telemetry_wellformed', 'telemetry_steps'].some((g) =>
      r.result?.failed_gates?.includes(g))],
  ['below_score_floor', (r) => r.result?.failed_gates?.includes('auc_floor')],
];

export function rootCause(record) {
  if (record.status === 'correct') return 'pass';
  for (const [name, test] of ROOT_CAUSE_ORDER) {
    try {
      if (test(record)) return name;
    } catch {
      /* fall through */
    }
  }
  return record.status === 'unparseable' ? 'harness_error' : 'unknown';
}

/**
 * Wilson 95% interval — reported instead of a bare percentage because at n=35
 * a bare "80%" reads far more precisely than the data supports.
 */
export function wilson(correct, n) {
  if (n === 0) return [0, 1];
  const z = 1.96;
  const p = correct / n;
  const d = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / d;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return [Math.max(0, centre - half), Math.min(1, centre + half)];
}

const pct = (x) => `${(x * 100).toFixed(1)}%`;

export function analyze(report) {
  const byTier = {};
  for (const r of report.raw_records ?? []) {
    (byTier[r.tier] ??= []).push(r);
  }

  const rows = Object.entries(byTier).map(([tier, recs]) => {
    const meta = report.tiers.find((t) => t.tier === tier) ?? {};
    const n = recs.length;
    const correct = recs.filter((r) => r.status === 'correct').length;
    const [lo, hi] = wilson(correct, n);

    const causes = {};
    for (const r of recs) {
      const c = rootCause(r);
      if (c !== 'pass') causes[c] = (causes[c] ?? 0) + 1;
    }

    const byCase = {};
    for (const r of recs) {
      const c = (byCase[r.case_id] ??= { n: 0, correct: 0, causes: {} });
      c.n++;
      if (r.status === 'correct') c.correct++;
      else {
        const rc = rootCause(r);
        c.causes[rc] = (c.causes[rc] ?? 0) + 1;
      }
    }

    const totalCost = recs.reduce((a, r) => a + (r.cost_usd ?? 0), 0);
    const aucs = recs.map((r) => r.result?.roc_auc).filter((x) => typeof x === 'number');

    // How expensive is the CODE this tier writes to actually run? Pass rate
    // cannot answer that — a tier can pass every case with candidates that take
    // 20x longer to score, and under a tighter budget those same candidates
    // become "failures". Median, not mean: one pathological candidate should
    // not be able to make a tier look uniformly slow, and it is the typical
    // candidate that determines whether a budget is survivable.
    const evalMs = recs.map((r) => r.eval_wall_ms).filter((x) => typeof x === 'number');
    const median = (xs) => {
      if (!xs.length) return null;
      const s = [...xs].sort((a, b) => a - b);
      const mid = s.length >> 1;
      return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
    };
    const medianEval = median(evalMs);
    const calMs = report.host_calibration?.wall_ms ?? null;

    return {
      tier,
      label: canonicalTierLabel({ model: meta.model, effort: meta.effort }),
      effort_inert: effortIsInert(meta.model ?? ''),
      n,
      correct,
      pass_rate: n ? correct / n : 0,
      ci95: [lo, hi],
      root_causes: causes,
      by_case: byCase,
      total_cost_usd: totalCost,
      mean_cost_usd: n ? totalCost / n : 0,
      mean_wall_s: n ? recs.reduce((a, r) => a + (r.wall_ms ?? 0), 0) / n / 1000 : 0,
      mean_roc_auc: aucs.length ? aucs.reduce((a, b) => a + b, 0) / aucs.length : null,
      // Only meaningful over attempts that actually produced a score.
      n_scored_auc: aucs.length,
      median_eval_wall_ms: medianEval,
      max_eval_wall_ms: evalMs.length ? Math.max(...evalMs) : null,
      n_eval_timed: evalMs.length,
      eval_vs_calibration: medianEval != null && calMs ? medianEval / calMs : null,
    };
  });

  // canonicalTierLabel() collapses model+effort, which is RIGHT for tier
  // comparisons (haiku's effort dial is inert, so haiku:high and haiku:max are
  // genuinely one configuration and showing them as two invites a false
  // difference). But in a prompt A/B both arms share model AND effort by
  // construction, so collapsing would print two different experiments under one
  // identical label. Where labels collide, fall back to the arm label — the only
  // thing that distinguishes them.
  const seen = {};
  for (const r of rows) seen[r.label] = (seen[r.label] ?? 0) + 1;
  for (const r of rows) if (seen[r.label] > 1) r.label = r.tier;

  return { role: report.role, rows, host_calibration: report.host_calibration ?? null };
}

export function render(analysis) {
  const out = [`forge-eval analysis — role=${analysis.role}`, ''];

  // Printed FIRST, before any tier number, because it decides whether the tier
  // numbers mean anything. A known-good reference candidate was timed on the
  // same host under the same serial conditions; if it did not finish, neither
  // did anything else, and the failures below are the machine's, not a model's.
  const cal = analysis.host_calibration;
  if (!cal) {
    out.push('host calibration: ABSENT — this report predates calibration; timeouts are unattributable.', '');
  } else if (!cal.ok) {
    out.push(
      `host calibration: FAILED (${cal.timed_out ? `over the ${cal.budget_ms}ms budget` : cal.error}).`,
      'The reference candidate itself did not score on this host. DO NOT read the tier',
      'comparison below as a statement about the models.',
      '',
    );
  } else {
    out.push(
      `host calibration: reference candidate scored roc_auc ${cal.roc_auc} in ${cal.wall_ms}ms ` +
        `(budget ${cal.budget_ms}ms, ${(cal.wall_ms / cal.budget_ms * 100).toFixed(1)}% used)`,
      '',
    );
  }

  const timeouts = analysis.rows.reduce((a, r) => a + (r.root_causes.scoring_timeout ?? 0), 0);
  if (timeouts > 0) {
    out.push(
      `WARNING: ${timeouts} attempt(s) were KILLED at the scoring deadline, not observed to fail.`,
      'Those are excluded from nothing — they count as failures below — but a tier whose',
      'failures are mostly timeouts has not been shown to write worse code.',
      '',
    );
  }

  out.push(
    ['tier', 'n', 'pass', '95% CI', '$/call', '$ total', 'wall_s', 'eval_s', 'vs_ref', 'mean_auc'].join('\t'),
  );
  for (const r of analysis.rows) {
    out.push(
      [
        r.label,
        r.n,
        pct(r.pass_rate),
        `${pct(r.ci95[0])}–${pct(r.ci95[1])}`,
        `$${r.mean_cost_usd.toFixed(4)}`,
        `$${r.total_cost_usd.toFixed(2)}`,
        r.mean_wall_s.toFixed(0),
        r.median_eval_wall_ms === null
          ? 'n/a'
          : `${(r.median_eval_wall_ms / 1000).toFixed(1)}/${(r.max_eval_wall_ms / 1000).toFixed(0)}max`,
        r.eval_vs_calibration === null ? 'n/a' : `${r.eval_vs_calibration.toFixed(1)}x`,
        r.mean_roc_auc === null ? 'n/a' : `${r.mean_roc_auc.toFixed(4)} (n=${r.n_scored_auc})`,
      ].join('\t'),
    );
  }
  out.push(
    '',
    'eval_s = MEDIAN/max seconds to execute the candidate this tier wrote; vs_ref = median',
    'against the calibrated reference. A tier that passes with candidates 20x the reference',
    'is buying its pass rate with compute, and fails the moment the budget tightens.',
  );

  out.push('', 'ROOT CAUSE of each failure (one per attempt, cascades collapsed):');
  for (const r of analysis.rows) {
    const entries = Object.entries(r.root_causes).sort((a, b) => b[1] - a[1]);
    out.push(`  ${r.label}: ${entries.length ? entries.map(([c, n]) => `${c}=${n}`).join(', ') : 'no failures'}`);
  }

  out.push('', 'per case (pass/n, then root causes):');
  const caseIds = [...new Set(analysis.rows.flatMap((r) => Object.keys(r.by_case)))];
  for (const id of caseIds) {
    out.push(`  ${id}:`);
    for (const r of analysis.rows) {
      const c = r.by_case[id];
      if (!c) continue;
      const causes = Object.entries(c.causes).map(([k, v]) => `${k}=${v}`).join(', ');
      out.push(`    ${r.label}: ${c.correct}/${c.n}${causes ? ` — ${causes}` : ''}`);
    }
  }

  // Cost-effectiveness only makes sense between tiers whose pass rates are not
  // separated by the data. A cheaper tier that fails more is not cheaper.
  out.push('', 'cost per PASSING attempt (the number that actually matters):');
  for (const r of analysis.rows) {
    out.push(
      `  ${r.label}: ${
        r.correct ? `$${(r.total_cost_usd / r.correct).toFixed(4)}` : 'n/a — no passing attempts'
      }`,
    );
  }

  const inert = analysis.rows.filter((r) => r.effort_inert);
  if (inert.length > 1) {
    out.push(
      '',
      `WARNING: ${inert.length} tiers have an inert effort dial and may be the same configuration: ` +
        inert.map((r) => r.tier).join(', '),
    );
  }

  return out.join('\n');
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const path = process.argv[2]
    ? resolve(process.argv[2])
    : resolve(REPO_ROOT, 'ci/out/forge-eval-evor-forge-junior.json');
  const report = JSON.parse(readFileSync(path, 'utf8'));
  console.log(render(analyze(report)));
}
