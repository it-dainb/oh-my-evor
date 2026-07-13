---
name: evor-gotchas
description: Inspect accumulated Gotchas (failures + hardware limits) and the hardware capability profile
argument-hint: "[--kind K] [--scope S] [--min-confidence C] [--evor-root DIR] [--run-dir DIR]"
level: 2
skills: [oh-my-evor:evor-mcp]
---

<Purpose>
evor-gotchas surfaces the accumulated failure knowledge so operators and agents can
understand what constraints and failures the Evor engine has encountered.

It shows:
  1. The hardware CapabilityProfile (gpu_arch, vram_gb, supported dtypes, available libs)
     probed at preflight time.
  2. GotchaEntry records managed by the harness and queried via evor_gotchas_list (global
     and optionally mission-scoped).

Gotcha kinds:
  hardware-constraint  — probed at preflight; describes what this machine cannot do
                         (e.g. no GPU, arch < sm_90 so no flash-attn v3).
  runtime-failure      — captured automatically by the harness during evaluation
                         when OOM / NaN / missing-dep / checkpoint failures occur.
  approach-deadend     — written by Probe when a family of mutations consistently fails
                         to improve over multiple ticks.
</Purpose>

<Use_When>
- User says "show gotchas", "list failures", "what hardware constraints exist", or runs `/evor-gotchas`
- Before starting a mission to understand hardware limits
- After a run to review what failures were captured
- When debugging why Selector is rejecting proposals (gotcha_avoidance gate failures)
- To verify preflight ran and capability.json was written
</Use_When>

<Do_Not_Use_When>
- User wants general environment health — use `/evor-doctor`
- User wants to validate contracts — use `/evor-validate`
</Do_Not_Use_When>

<Steps>

## Step 1 — Resolve arguments

Parse optional arguments:
- `--kind K`            Filter to: `runtime-failure`, `hardware-constraint`, `approach-deadend`
- `--scope S`           Filter to: `global` or `mission`
- `--min-confidence C`  Float 0.0–1.0 threshold (default 0.0 = show all)
- `--evor-root DIR`     Path to .evor/ root (default: .evor in cwd)
- `--run-dir DIR`       Path to active run directory for mission-scoped gotchas

## Step 2 — Query gotchas

Call `evor_gotchas_list` with the applicable filters:

```
evor_gotchas_list({
  kind: "runtime-failure" | "hardware-constraint" | "approach-deadend",  // optional
  scope: "global" | "mission",                                            // optional
  min_confidence: 0.7,                                                    // optional
  evor_root: ".evor",                                                     // optional
  run_dir: "<active-run-dir>"                                             // optional
})
```

## Step 3 — Present the capability profile

If capability_profile is present, show a summary table:

```
=== Hardware Capability Profile ===
  GPU:           NVIDIA A100 80GB PCIe (sm_80)
  VRAM:          79.2 GB
  Supported dtypes: fp32, fp16, bf16
  Available libs:   flash-attn, xformers, triton
  CUDA version:  12.1
  CPU only:      False
  Probed at:     2026-07-04T10:00:00Z

  [WARN] flash-attn v3 unavailable: requires sm_90, detected sm_80
```

If capability_profile is None, note that preflight has not been run.

## Step 4 — Present the gotchas table

```
=== Gotchas (N total) ===

[hardware-constraint] flash-attn-v3-requires-sm90  confidence=1.00  occurrences=1
  Avoidance: flash-attn v3 (FA3) requires CUDA sm_90. Use flash-attn v2 instead.
  Last seen: 2026-07-04T10:00:00Z

[runtime-failure] cuda-oom  confidence=0.84  occurrences=3
  Context: batch_size=256, node_id=node-abc
  Resolution: CUDA OOM: batch_size 256→128, gradient_accumulation_steps 1→2
  Avoidance: Avoid batch_size >= 256 on this task.
  Last seen: 2026-07-04T12:30:00Z

(no approach-deadend gotchas yet)
```

Status icons in summary:
  ✓  confidence < 0.5   — low confidence, informational only
  ⚠  confidence 0.5–0.8 — moderate; agents should prefer alternatives
  ✗  confidence >= 0.8  — high confidence hard block; Selector will reject violations

## Step 5 — Suggest next steps

If hardware-constraint gotchas with confidence >= 1.0 are present:
  "These hardware constraints are HARD BLOCKS. Mutagen and Selector will
   enforce them automatically. No action required."

If runtime-failure gotchas with confidence >= 0.8 are present:
  "These runtime failures will cause Selector to reject proposals that
   reproduce the triggering configuration. Review the avoidance field."

If no capability.json exists:
  "Run /evor-setup to probe hardware capability and register hardware-constraint gotchas."

</Steps>

<Tool_Usage>
- `evor_gotchas_list` — query all accumulated gotchas, optionally filtered by kind/scope/confidence
- `evor_state_read` — read capability profile from active run state
</Tool_Usage>
