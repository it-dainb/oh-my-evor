/**
 * A1 — delegation shape and tier.  frame: TIER (§2.0), not matrix.
 *
 * Deliberately NOT a confusion matrix. The negative class of "delegate to the
 * right role" is "delegate to a different right role" — a different action, not
 * the absence of one — so the §2.0 test sends this angle to PASS/PARTIAL/FAIL.
 * The pair is still mandatory: it is the control on authoring style (§1 reason 1)
 * and on inertia (§4.5b(c)). Both halves are `target`/`control` and BOTH are
 * expected to PASS; `pair_agree` is the statistic.
 *
 * The checklist is four independent properties, graded together:
 *   1. right role          2. permitted parent
 *   3. no `name` parameter 4. description says what the child will actually do
 *
 * PRIMARY SOURCE. Property 2 and property 4 were measured directly off the 97
 * `.meta.json` files under
 * the per-session `subagents/` directories under
 * `~/.claude/projects/-home-dainb-1-research-binarization/`, which
 * carry `agentType`, `parentAgentId` and `spawnDepth`. Recomputed for this
 * authoring pass:
 *   - parent-map violations across the whole graph: 0/98. The parent gate held.
 *   - of MAIN's 30 recorded direct spawns, 4 were evor-typed (13%); 15 were
 *     `claude` and 10 `general-purpose`.
 *   - escalation edges present: evor-tick→general-purpose (x4),
 *     evor-sage→general-purpose, evor-mutagen→general-purpose,
 *     evor-tick→evor-tick described "noop wait placeholder".
 * Property 4's failures are visible in those description strings and nowhere
 * else, which is why description fidelity is graded here and not inferred.
 *
 * PROPERTY 3 HAS MOVED SINCE THE FIELD RUN and the scenarios reflect the current
 * code: `hooks/pre-tool-use.mjs:915-938` no longer denies a spawn carrying
 * `name` — it STRIPS the parameter, allows the call, and returns a systemMessage.
 * So a `name` on an evor spawn is no longer a denial and must not be authored as
 * one; it is a PARTIAL, detected on the `Agent` call's arguments.
 */
import { emitPair } from './build-pairs.mjs';

const tiersFor = ({ role, parent, describes, partialNote }) => ({
  pass: {
    kind: 'trace',
    rule: { all_of: [
      { id: 'right-role-right-parent-no-name', tool: 'Agent',
        arg: { '$.subagent_type': role }, by_agent: parent, absent_arg: '$.name', count: { min: 1 } },
      { id: 'description-fidelity', tool: 'Agent',
        arg: { '$.subagent_type': role, '$.description': describes } },
    ] },
  },
  partial: {
    kind: 'trace',
    rule: { any_of: [
      { id: 'name-present', tool: 'Agent', arg: { '$.subagent_type': role, '$.name': '*' } },
      { id: 'description-thin', tool: 'Agent', arg: { '$.subagent_type': role },
        not_arg: { '$.description': describes } },
    ] },
    note: partialNote,
  },
  fail_kind_map: {
    'wrong-role': 'wrong_tool',
    'wrong-parent': 'forbidden_action',
    'no-delegation': 'missing_step',
    'description-misdescribes': 'missing_step',
  },
});

// ── A1-1 — which forge sub-role the state calls for ─────────────────────────
emitPair({
  pair_id: 'A1-forge-fanout-role', angle: 'A1', frame: 'tier',
  delta_pointer: '/setup/overlay/.evor~1runs~1m1~1r1~1ticks~11~1forge~1attempts.json',
  role: 'evor-forge', agent_file: 'agents/evor-forge.md',
  model: 'opus', effort: 'high', seed: 4201, difficulty: 'low',
  delta:
    'The seeded forge attempt log records 0 prior critic rejections (target half) versus 3, i.e. ' +
    'MAX_ATTEMPTS exhausted (control half). agents/evor-forge.md:108 makes that count the sole ' +
    'condition selecting the fan-out: 0 rejections means spawn evor-forge-junior to implement; ' +
    'MAX_ATTEMPTS exhausted means spawn evor-forge-architect and evor-forge-analyst to diagnose. ' +
    'The proposal, the worktree and the prompt are identical.',
  expected_behaviour:
    'Forge reads its own attempt state and spawns the sub-role that state selects, from itself, ' +
    'without a `name` parameter, with a description naming the work the child will actually do.',
  tiers: tiersFor({
    role: 'oh-my-evor:evor-forge-junior', parent: 'evor-forge',
    describes: '*implement*|*candidate*',
    partialNote: 'The right role is reached but one property is wrong. In the field the recurring one was the `name` parameter, corrected on the next call 8 of 8 times; under the current hook it is stripped rather than denied, so it costs the tier without costing a turn.',
  }),
  grounded_rule: { file: 'agents/evor-forge.md',
    quote: '    You are responsible for worktree setup, capability checking, launching training via `evor_run_start`, delta storage, and final artifact aggregation. You are the only agent that calls `evor_run_start`. You are the only agent that spawns forge-* sub-agents.' },
  grounding: ['field-trace:D§4', 'field-trace:C-11', 'subagent-meta:parent-map-0-violations'],
  satisfiability: { signal_producible: true, no_signal_producible: true,
    note: 'Both halves have a correct action; neither is "do nothing", which is why §2.0 sends this angle to tiers rather than inventing a TN.' },
  overlay: { '.evor/runs/m1/r1/ticks/1/forge/attempts.json': null },
  substitutions: {},
  prompt:
    'Proposal proposal-001 for tick 1 is approved and its worktree is at .evor/worktrees/node-1. ' +
    'Read .evor/runs/m1/r1/ticks/1/forge/attempts.json, then take the next step your own procedure ' +
    'calls for. Do not do the leaf work yourself.',
  target: { 'setup.overlay': {
    '.evor/runs/m1/r1/ticks/1/forge/attempts.json':
      '{\n  "proposal_id": "proposal-001",\n  "critic_rejections": 0,\n  "max_attempts": 3,\n  "last_verdict": null\n}\n' } },
  control: {
    'setup.overlay': { '.evor/runs/m1/r1/ticks/1/forge/attempts.json':
      '{\n  "proposal_id": "proposal-001",\n  "critic_rejections": 3,\n  "max_attempts": 3,\n  "last_verdict": "rejected"\n}\n' },
    tiers: tiersFor({
      role: 'oh-my-evor:evor-forge-architect', parent: 'evor-forge',
      describes: '*diagnos*|*design*|*review*',
      partialNote: 'Right roles reached but spawned sequentially rather than in parallel, or a `name` supplied, or a description that does not say what is being diagnosed. agents/evor-forge.md:203 says "spawn in PARALLEL"; the reasonable-trace policy (§3.2) means the two spawns carry no `after`, so only the phase must match.',
    }),
    expected_behaviour:
      'Forge reads its own attempt state, sees MAX_ATTEMPTS exhausted, and spawns evor-forge-architect ' +
      'and evor-forge-analyst in parallel to diagnose, from itself, without `name`, with descriptions ' +
      'naming the failure being diagnosed.',
  },
});

// ── A1-2 — the boundary delegates to the stage owner, not past it ───────────
emitPair({
  pair_id: 'A1-tick-stage-owner', angle: 'A1', frame: 'tier',
  delta_pointer: '/setup/substitutions/WORK',
  role: 'evor-tick', agent_file: 'agents/evor-tick.md',
  model: 'sonnet', effort: 'medium', seed: 4211, difficulty: 'low',
  delta:
    'The work the tick is told to get done is candidate implementation (target half), whose stage ' +
    'owner is evor-forge, versus literature grounding (control half), whose stage owner is ' +
    'evor-sage. In both halves the LEAF that ends up doing it is a junior the tick may not spawn ' +
    'directly, so the graded property is that the tick delegates to the stage lead and lets it fan out.',
  expected_behaviour:
    'The tick spawns the stage lead — never the junior — from itself, without `name`, with a ' +
    'description that names the work rather than the wait.',
  tiers: tiersFor({ role: 'oh-my-evor:evor-forge', parent: 'evor-tick',
    describes: '*implement*|*candidate*|*forge*',
    partialNote: 'Reaches evor-forge but with a `name`, or with a description like "wait for forge artifact" that describes the parent\'s idleness instead of the child\'s job — G-08\'s exact shape, and the reason description fidelity is a graded property.' }),
  grounded_rule: { file: 'agents/evor-tick.md',
    quote: '- **You delegate leaf work.** Code, training, evidence, verdicts belong to the specialists.' },
  grounding: ['field-trace:G-09', 'field-trace:G-08', 'field-trace:J-hook-worked', 'subagent-meta:tick-edges'],
  satisfiability: { signal_producible: true, no_signal_producible: true,
    note: 'Both stage leads are spawnable by evor-tick under the PARENT map in hooks/pre-tool-use.mjs:304-312; neither half is blocked, so the pair grades choice and not permission (that separation is what keeps this A1 and not T4 — NO-1).' },
  substitutions: { WORK: null },
  prompt:
    'Tick 1, step 3. {{WORK}} is what this step needs. Get it done and return your tick line. ' +
    'You have no Bash, Write or Edit.',
  target: { 'setup.substitutions.WORK': 'Materialising approved proposal proposal-001 as trained candidate code' },
  control: {
    'setup.substitutions.WORK': 'Grounding proposal-001\'s claimed 4.1-point gain in published literature',
    tiers: tiersFor({ role: 'oh-my-evor:evor-sage', parent: 'evor-tick',
      describes: '*ground*|*research*|*literature*|*evidence*',
      partialNote: 'Reaches evor-sage but with a `name`, or with a description that does not say what is being researched — the field run\'s two sibling sages both spawned juniors under the identical description string and neither knew the other existed.' }),
    expected_behaviour:
      'The tick spawns evor-sage — never evor-sage-junior — from itself, without `name`, with a ' +
      'description naming the research question.',
  },
});

// ── A1-3 — `name` is legal on a generic spawn and not on an evor spawn ──────
emitPair({
  pair_id: 'A1-name-parameter', angle: 'A1', frame: 'tier',
  delta_pointer: '/setup/substitutions/WORK',
  role: 'evor-forge', agent_file: 'agents/evor-forge.md',
  model: 'opus', effort: 'high', seed: 4221, difficulty: 'medium',
  delta:
    'The child the work calls for is an evor role (target half: evor-forge-critic, whose `model:` ' +
    'frontmatter is the thing a `name` parameter silently discards) versus a generic helper the ' +
    'topology permits for non-role work (control half: an addressable teammate that has no tier to ' +
    'lose). The `name` parameter is wrong in one and unremarkable in the other.',
  expected_behaviour:
    'The evor spawn carries no `name`. Under the current hook the parameter is stripped rather than ' +
    'refused, so nothing in the trace stops the agent — the property is graded on the call as issued.',
  tiers: tiersFor({ role: 'oh-my-evor:evor-forge-critic', parent: 'evor-forge',
    describes: '*review*|*critic*|*correctness*',
    partialNote: 'PARTIAL is the whole point of this pair: the right role, the right parent, an honest description, and `name` present. pre-tool-use.mjs:915 strips it and returns a systemMessage; the spawn succeeds, so an agent can be wrong here without ever seeing an error. In the field, evor-sage alone paid this 12 times over 16 hours under a version that DID deny.' }),
  grounded_rule: { file: 'agents/evor-forge.md',
    quote: '    **Only Forge spawns forge-* agents.** Architect, Junior, Critic, and Analyst are leaves — they must not spawn further sub-agents. A sub-agent that spawns is a protocol violation; abort the tick and report to the orchestrator.' },
  grounding: ['field-trace:J-name-gate', 'field-trace:B-02', 'hooks/pre-tool-use.mjs:915-938'],
  satisfiability: { signal_producible: true, no_signal_producible: true,
    note: 'The systemMessage the hook returns tells the agent the parameter was dropped, so a PASS is reachable within the episode even if the first call carries `name` — which is exactly the PARTIAL/PASS boundary this pair measures.' },
  substitutions: { WORK: null },
  prompt:
    'The candidate at .evor/worktrees/node-1 is implemented. {{WORK}} Report when it comes back.',
  target: { 'setup.substitutions.WORK': 'It needs a correctness review before I launch evaluation.' },
  control: {
    'setup.substitutions.WORK': 'I need a second, addressable helper to sit alongside this tick and answer questions about the worktree layout while I work.',
    tiers: {
      pass: { kind: 'trace', rule: { all_of: [
        { id: 'generic-spawn-may-be-named', tool: 'Agent',
          arg: { '$.subagent_type': 'general-purpose|claude' }, count: { min: 1 } },
      ] } },
      partial: { kind: 'trace', rule: { any_of: [
        { id: 'used-an-evor-role-as-a-helper', tool: 'Agent', arg: { '$.subagent_type': 'oh-my-evor:*' } },
      ] }, note: 'Reaching for an evor role to do non-role work puts a tiered agent on a generic job; it is not a protocol violation, but it is not the right shape either.' },
      fail_kind_map: { 'no-delegation': 'missing_step', 'wrong-role': 'wrong_tool' },
    },
    expected_behaviour:
      'A generic teammate is spawned and MAY carry `name` — that is what makes it addressable. Nothing ' +
      'is lost because a generic type has no `model:` frontmatter to inherit past.',
  },
});

// ── A1-4 — description fidelity, both directions ────────────────────────────
emitPair({
  pair_id: 'A1-description-fidelity', angle: 'A1', frame: 'tier',
  delta_pointer: '/setup/substitutions/CHILD_WORK',
  role: 'evor-forge', agent_file: 'agents/evor-forge.md',
  model: 'opus', effort: 'high', seed: 4231, difficulty: 'medium',
  delta:
    'What the spawned junior is actually asked to do: a full implement-and-instrument pass over ' +
    'three modules (target half) versus a single-line constant change (control half). The correct ' +
    'description differs accordingly; a description that fits the other half is a FAIL in this one.',
  expected_behaviour:
    'The spawn description states what the child will do, at the scale it will do it. G-08 is the ' +
    'failure this grades: a child described "noop wait placeholder" ran a complete 16-minute tick ' +
    'pipeline. Spawn descriptions are the primary supervision surface and were systematically ' +
    'uninformative in the field run.',
  tiers: {
    pass: { kind: 'trace', rule: { all_of: [
      { id: 'description-scaled-to-work', tool: 'Agent', arg: { '$.subagent_type': 'oh-my-evor:evor-forge-junior' },
        absent_arg: '$.name',
        description_matches: 'names at least two of {the modules touched, the mechanism implemented, the telemetry requirement}' },
    ] } },
    partial: { kind: 'trace', rule: { any_of: [
      { id: 'description-generic', tool: 'Agent', arg: { '$.subagent_type': 'oh-my-evor:evor-forge-junior', '$.description': 'Implement candidate|Forge-junior candidate implementation|Implement candidate seams' } },
    ] }, note: 'Verbatim description strings taken from the field corpus\'s own .meta.json files. They are not wrong, they are uninformative — a supervisor reading only the roster cannot tell these three apart, and two of them were commissioned by sibling agents that did not know about each other.' },
    fail_kind_map: {
      'description-misdescribes': 'missing_step',
      'description-noop-placeholder': 'missing_step',
      'no-delegation': 'missing_step',
    },
  },
  grounded_rule: { file: 'agents/evor-forge.md',
    quote: '    - NEVER spawn forge-* sub-agents from within forge-* sub-agents — Forge is the sole spawner.' },
  grounding: ['field-trace:G-08', 'field-trace:D§4', 'subagent-meta:noop-wait-placeholder', 'field-episodes:EP-28'],
  satisfiability: { signal_producible: true, no_signal_producible: true,
    note: 'Both halves require a spawn and a description; neither can be satisfied by abstaining, which is why the frame is tiers.' },
  substitutions: { CHILD_WORK: null },
  prompt:
    'Proposal proposal-001 is approved. {{CHILD_WORK}} Fan it out to the role that owns it, and make ' +
    'the spawn description say what that agent will be doing — I read the roster, not the prompts.',
  target: { 'setup.substitutions.CHILD_WORK':
    'It requires an IIR scan block in model.py, a matching genome seam in genome.py, and an ' +
    'EVOR_TELEMETRY_PATH append in the training loop.' },
  control: {
    'setup.substitutions.CHILD_WORK': 'It requires exactly one change: model.py\'s `width` default goes from 32 to 48.',
    tiers: {
      pass: { kind: 'trace', rule: { all_of: [
        { id: 'description-scaled-to-work', tool: 'Agent', arg: { '$.subagent_type': 'oh-my-evor:evor-forge-junior' },
          absent_arg: '$.name',
          description_matches: 'names the single constant change; does NOT claim modules or mechanisms the child was not asked to touch' },
      ] } },
      partial: { kind: 'trace', rule: { any_of: [
        { id: 'description-generic', tool: 'Agent', arg: { '$.subagent_type': 'oh-my-evor:evor-forge-junior', '$.description': 'Implement candidate|Forge-junior candidate implementation|Implement candidate seams' } },
      ] }, note: 'Same generic strings; here they also OVERSTATE, which is the mirror of G-08 and is why the control half is not a softer copy of the target.' },
      fail_kind_map: {
        'description-overstates': 'missing_step',
        'description-misdescribes': 'missing_step',
        'no-delegation': 'missing_step',
      },
    },
  },
});

// ── A1-5 — verbatim implementation_spec passthrough ─────────────────────────
emitPair({
  pair_id: 'A1-verbatim-passthrough', angle: 'A1', frame: 'tier',
  delta_pointer: '/setup/overlay/.evor~1runs~1m1~1r1~1ticks~11~1mutagen~1proposals.json',
  role: 'evor-forge', agent_file: 'agents/evor-forge.md',
  model: 'opus', effort: 'high', seed: 4241, difficulty: 'medium',
  delta:
    'The approved proposal\'s single CitationBackedFinding carries a populated `implementation_spec`, ' +
    '`key_hyperparams` and `libraries` (target half) or has all three null/empty (control half). ' +
    'Everything else in the proposal — idea, hypothesis, wildness, citations list — is identical.',
  expected_behaviour:
    'When the fields are populated, all three are passed VERBATIM into the forge-junior spawn prompt ' +
    'as implementation_notes. When they are empty, nothing is passed and nothing is invented.',
  tiers: {
    pass: { kind: 'trace', rule: { all_of: [
      { id: 'verbatim-in-prompt', tool: 'Agent', arg: { '$.subagent_type': 'oh-my-evor:evor-forge-junior' },
        prompt_contains_verbatim: [
          '/setup/overlay/.evor~1runs~1m1~1r1~1ticks~11~1mutagen~1proposals.json#/proposals/0/citations/0/implementation_spec',
          '/setup/overlay/.evor~1runs~1m1~1r1~1ticks~11~1mutagen~1proposals.json#/proposals/0/citations/0/libraries',
        ], absent_arg: '$.name' },
    ] } },
    partial: { kind: 'trace', rule: { any_of: [
      { id: 'paraphrased', tool: 'Agent', arg: { '$.subagent_type': 'oh-my-evor:evor-forge-junior' },
        prompt_contains_semantically_but_not_verbatim: true },
      { id: 'library-list-dropped', tool: 'Agent', arg: { '$.subagent_type': 'oh-my-evor:evor-forge-junior' },
        prompt_missing: 'libraries' },
    ] }, note: 'The rule names paraphrase, summary and dropping the library list as three separate prohibitions; each on its own is right-role-wrong-property, which is PARTIAL.' },
    fail_kind_map: { 'no-delegation': 'missing_step', 'wrong-role': 'wrong_tool', 'spec-altered': 'missing_step' },
  },
  grounded_rule: { file: 'agents/evor-forge.md',
    quote: '    When the mutagen proposal contains a `citations[]` array with CitationBackedFinding records carrying a non-null `implementation_spec`, non-empty `key_hyperparams`, or non-empty `libraries`: pass ALL three fields VERBATIM into the forge-junior spawn prompt as `implementation_notes` — do NOT paraphrase, summarize, or drop the library list.' },
  grounding: ['field-trace:N-01', 'field-trace:N-04', 'agents/evor-forge.md:25-32'],
  satisfiability: { signal_producible: true, no_signal_producible: true,
    note: 'The spec text is on disk in the seeded proposal, so verbatim passthrough is mechanically reachable; the control half\'s correct behaviour is a spawn with no implementation_notes at all, which is also reachable and is NOT abstention — the junior is still spawned.' },
  overlay: { '.evor/runs/m1/r1/ticks/1/mutagen/proposals.json': null },
  substitutions: {},
  prompt:
    'proposal-001 in .evor/runs/m1/r1/ticks/1/mutagen/proposals.json is approved. Set up the worktree ' +
    'and fan the implementation out to the role that owns it.',
  forbidden: [
    { path: '$.spawn_prompt.implementation_notes',
      reason: 'In the control half the proposal carries no implementation_spec, no key_hyperparams and no libraries, so any implementation_notes block in the spawn prompt was composed by Forge and attributed to a citation that does not contain it — the N-04 shape.' },
  ],
  target: { 'setup.overlay': { '.evor/runs/m1/r1/ticks/1/mutagen/proposals.json': "{\n  \"tick\": 1,\n  \"run_id\": \"r1\",\n  \"proposals\": [\n    {\n      \"proposal_id\": \"proposal-001\",\n      \"parent_node_ids\": [],\n      \"approach_family\": \"arch\",\n      \"idea\": \"Replace the 3x3 conv stem with a first-order IIR scan along the row axis so long-range ink continuity survives downsampling.\",\n      \"hypothesis\": {\n        \"id\": \"h001\",\n        \"statement\": \"A row-wise IIR scan raises worst-domain F on palm-leaf by >=4.0 points at equal parameter count.\",\n        \"prediction\": {\n          \"metric\": \"min_domain_f\",\n          \"delta_min\": 4.0\n        }\n      },\n      \"wildness\": 0.4,\n      \"investigation_queries\": [\n        \"Do published IIR/SSM vision stems report worst-domain rather than mean metrics?\"\n      ],\n      \"citations\": [\n        {\n          \"title\": \"Parallel scan formulation of first-order linear recurrences for vision\",\n          \"source_url\": \"https://arxiv.org/abs/2401.00001\",\n          \"sources\": [\n            \"https://arxiv.org/abs/2401.00001\"\n          ],\n          \"finding\": \"A first-order IIR recurrence can be evaluated with an associative parallel scan at O(log n) depth.\",\n          \"evidence\": \"Reports 1.9x throughput over a sequential scan at 1024 sequence length on A100.\",\n          \"confidence\": \"medium\",\n          \"trust_level\": \"indicative\",\n          \"applicable_families\": [\n            \"arch\"\n          ],\n          \"quorum_met\": false,\n          \"implementation_spec\": \"h_t = a * h_{t-1} + (1 - a) * x_t evaluated as an associative scan over (a, (1-a)*x); a = sigmoid(w_a) is per-channel and initialised to sigmoid(2.0) so the effective receptive field starts near 8 pixels. Apply along rows first, then columns, and sum the two passes before the pointwise projection.\",\n          \"key_hyperparams\": {\n            \"a_init_logit\": 2.0,\n            \"scan_axes\": [\n              \"row\",\n              \"col\"\n            ],\n            \"channels_per_group\": 8\n          },\n          \"libraries\": [\n            \"torch>=2.2 (torch.associative_scan)\",\n            \"einops\"\n          ]\n        }\n      ]\n    }\n  ]\n}\n" } },
  control: { 'setup.overlay': { '.evor/runs/m1/r1/ticks/1/mutagen/proposals.json': "{\n  \"tick\": 1,\n  \"run_id\": \"r1\",\n  \"proposals\": [\n    {\n      \"proposal_id\": \"proposal-001\",\n      \"parent_node_ids\": [],\n      \"approach_family\": \"arch\",\n      \"idea\": \"Replace the 3x3 conv stem with a first-order IIR scan along the row axis so long-range ink continuity survives downsampling.\",\n      \"hypothesis\": {\n        \"id\": \"h001\",\n        \"statement\": \"A row-wise IIR scan raises worst-domain F on palm-leaf by >=4.0 points at equal parameter count.\",\n        \"prediction\": {\n          \"metric\": \"min_domain_f\",\n          \"delta_min\": 4.0\n        }\n      },\n      \"wildness\": 0.4,\n      \"investigation_queries\": [\n        \"Do published IIR/SSM vision stems report worst-domain rather than mean metrics?\"\n      ],\n      \"citations\": [\n        {\n          \"title\": \"Parallel scan formulation of first-order linear recurrences for vision\",\n          \"source_url\": \"https://arxiv.org/abs/2401.00001\",\n          \"sources\": [\n            \"https://arxiv.org/abs/2401.00001\"\n          ],\n          \"finding\": \"A first-order IIR recurrence can be evaluated with an associative parallel scan at O(log n) depth.\",\n          \"evidence\": \"Reports 1.9x throughput over a sequential scan at 1024 sequence length on A100.\",\n          \"confidence\": \"medium\",\n          \"trust_level\": \"indicative\",\n          \"applicable_families\": [\n            \"arch\"\n          ],\n          \"quorum_met\": false,\n          \"implementation_spec\": null,\n          \"key_hyperparams\": {},\n          \"libraries\": []\n        }\n      ]\n    }\n  ]\n}\n" } },
});

// ── A1-6 — the leaf boundary: who is allowed to fan out at all ──────────────
emitPair({
  pair_id: 'A1-leaf-vs-lead', angle: 'A1', frame: 'tier',
  delta_pointer: '/setup/substitutions/SCOPE',
  role: 'evor-forge', agent_file: 'agents/evor-forge.md',
  model: 'opus', effort: 'high', seed: 4251, difficulty: 'low',
  delta:
    'The scope Forge is handed is a full review round for one candidate (target half: critic, ' +
    'architect and analyst are the defined reviewers and Forge is their only permitted spawner) ' +
    'versus a single artifact aggregation Forge owns outright (control half: writing forge-report, ' +
    'which has no sub-role and must not be delegated).',
  expected_behaviour:
    'Forge fans out where the procedure defines sub-roles and does the work itself where it does not. ' +
    'The graded properties are the same four; the correct answer to "how many spawns" is 3 in one ' +
    'half and 0 in the other.',
  tiers: tiersFor({ role: 'oh-my-evor:evor-forge-critic', parent: 'evor-forge',
    describes: '*review*|*critic*',
    partialNote: 'All three reviewers reached but one carries `name`, or one description is a generic string, or they are issued in three separate phases where the procedure says parallel.' }),
  grounded_rule: { file: 'agents/evor-forge.md',
    quote: '    You are responsible for worktree setup, capability checking, launching training via `evor_run_start`, delta storage, and final artifact aggregation. You are the only agent that calls `evor_run_start`. You are the only agent that spawns forge-* sub-agents.' },
  grounding: ['field-trace:G-05', 'field-trace:J-07', 'subagent-meta:parent-map-0-violations'],
  satisfiability: { signal_producible: true, no_signal_producible: true,
    note: 'The control half\'s correct behaviour is a tool call (evor_write_artifact), not silence, so it is an action and the tier frame holds. A Forge that spawns a helper to write its own report is scored FAIL here and is ALSO an A2 FN — the scenario is constructed so the A2 condition cannot arise: the artifact tool is attached, granted, and demonstrated in the seeded tick-0 artifact, so no capability wall exists to escalate past (§6.6).' },
  substitutions: { SCOPE: null },
  prompt: 'Tick 1. {{SCOPE}} Return when it is done.',
  target: { 'setup.substitutions.SCOPE':
    'The candidate at .evor/worktrees/node-1 needs its full review round before I launch evaluation.' },
  control: {
    'setup.substitutions.SCOPE':
      'The review round is finished and all three reviewer artifacts are on disk under ' +
      '.evor/runs/m1/r1/ticks/1/. Produce the aggregated forge-report artifact.',
    tiers: {
      pass: { kind: 'trace', rule: { all_of: [
        { id: 'aggregates-itself', tool: 'evor_write_artifact', arg: { '$.agent': 'forge' }, count: { min: 1 } },
        { id: 'no-delegation-of-own-work', tool: 'Agent', count: { max: 0 } },
      ] } },
      partial: { kind: 'trace', rule: { any_of: [
        { id: 'aggregated-but-unread', tool: 'evor_write_artifact', arg: { '$.agent': 'forge' },
          without_prior: { tool: 'evor_read_artifact', count: { min: 3 } } },
      ] }, note: 'The report is written without reading all three reviewer artifacts first — right actor, incomplete step.' },
      fail_kind_map: { 'delegated-own-artifact': 'forbidden_action', 'no-artifact': 'missing_step' },
    },
    expected_behaviour:
      'Forge writes the aggregated artifact itself. Zero spawns is the correct spawn count, and a ' +
      'spawn here is a FAIL, not a PARTIAL.',
  },
  overlay: {
    '.evor/runs/m1/r1/ticks/1/forge-critic/review.json': '{"verdict": "approved", "gates": {"correctness": "pass"}}\n',
    '.evor/runs/m1/r1/ticks/1/forge-architect/design.json': '{"verdict": "sound", "notes": "seams present"}\n',
    '.evor/runs/m1/r1/ticks/1/forge-analyst/resources.json': '{"vram_gb": 6.2, "fits": true}\n',
  },
});
