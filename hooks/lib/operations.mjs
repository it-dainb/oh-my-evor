/**
 * hooks/lib/operations.mjs — authority as OPERATIONS, not tool names (item 4.2).
 *
 * AF4 §6. The unit of authority was the tool, and the tool is the wrong noun:
 *
 *   `Write` denied, `Bash` granted, writes happened anyway — 21 events across 6
 *   roles. The denylist named a tool; the intent was an operation ("do not
 *   author files"), and `Bash` satisfies the operation while evading the name.
 *   Two of the files staged that way were the roles' actual deliverables,
 *   written to `/tmp` in exactly the manner the denylist exists to prevent.
 *
 * The repo already contained the better model sitting next to the worse one.
 * The `[EVOR GUARD]` path rule is scoped to `(operation, path)`, fires whatever
 * tool is used, and is the one authority expression in the system that did its
 * job every single time. `disallowedTools` is the legacy one beside it.
 *
 * So authority is declared here as what a role MAY DO TO WHAT, and the governor
 * derives `(operation, target)` from the call — which §0.2's `resolveWriteTargets`
 * already does. A rule keyed on the act survives being performed by another
 * tool; a rule keyed on the tool does not.
 */

/** The operations the system distinguishes. Deliberately few. */
export const OPERATIONS = /** @type {const} */ ([
  'author-code',      // create or modify executable candidate code
  'run-training',     // execute a training/evaluation workload
  'write-artifact',   // record a role's own deliverable
  'write-run-state',  // mutate run/mission/tick state
  'discover-evidence',      // SEARCH for sources that were not already known
  'retrieve-cited-source',  // fetch a paper you were already given the id of
]);

// Splitting these two was forced by enforcement, and the split is the point of
// the item. "Read the paper this proposal cites, to check the formula matches"
// and "go find literature" are different acts with different anchoring-bias
// consequences, and a vocabulary that calls both `research` cannot express the
// narrow grant forge-junior legitimately holds.

/**
 * Per-role grants. `may` is exhaustive: an operation not listed is not granted.
 *
 * Scopes are path predicates, not tool names, so a grant means the same thing
 * however the act is performed. `null` scope = the operation is granted
 * wherever the path rules already allow.
 */
const GRANTS = {
  // The orchestrator coordinates and records. It authors nothing — that is the
  // Orchestrator_Contract, and it was previously expressed as "may not Write a
  // .py file", which said nothing about the same file written via Bash.
  '': { may: ['write-run-state'] },

  'evor-tick': { may: ['write-run-state', 'write-artifact'] },

  // Only forge-junior authors candidate code or runs it, and only on its own
  // surface — 0.3 scopes that, and this is the same statement in the vocabulary
  // the rest of the system now uses.
  'evor-forge-junior': {
    // `retrieve-cited-source` but NOT `discover-evidence`: it may fetch a paper
    // a proposal already cites, to check its implementation matches the source
    // formula. Searching for new evidence is Sage's job, and the separation is
    // anchoring-bias control, not bureaucracy.
    may: ['author-code', 'run-training', 'write-artifact', 'retrieve-cited-source'],
    scopes: { 'author-code': 'candidate-surface', 'run-training': 'candidate-surface' },
  },

  // Leads orchestrate their own teams and emit JSON. A lead that could author
  // code would have no reason to spawn the junior that exists to do it.
  'evor-forge': { may: ['write-artifact'] },
  'evor-sage': { may: ['write-artifact', 'discover-evidence', 'retrieve-cited-source'] },
  'evor-sage-junior': { may: ['write-artifact', 'discover-evidence', 'retrieve-cited-source'] },
  'evor-selector': { may: ['write-artifact'] },
  'evor-probe': { may: ['write-artifact'] },
  'evor-acquirer': { may: ['write-artifact', 'discover-evidence', 'retrieve-cited-source'] },

  // Mutagen dreams; it does not gather evidence. Anchoring-bias separation is
  // load-bearing, and expressing it as an operation covers every channel at
  // once rather than enumerating tool names as they are added.
  'evor-mutagen': { may: ['write-artifact'] },

  'evor-forge-architect': { may: ['write-artifact'] },
  'evor-forge-critic': { may: ['write-artifact'] },
  'evor-forge-analyst': { may: ['write-artifact'] },
};

/**
 * What a role may do. Unknown roles — including every generic agent type — get
 * the empty grant, which is why 4.3 hands a generic child its SPAWNER's set:
 * authority attached to *who you are* is defeated by *who you can create*.
 */
export function grantFor(agentType) {
  return GRANTS[String(agentType ?? '')] ?? { may: [] };
}

/** May this role perform this operation at all? */
export function mayPerform(agentType, operation) {
  return grantFor(agentType).may.includes(operation);
}

/** The scope name constraining a granted operation, or null for "unscoped". */
export function scopeFor(agentType, operation) {
  return grantFor(agentType).scopes?.[operation] ?? null;
}

/**
 * Which operation a call performs, derived from the ACT rather than the tool.
 *
 * `targets` comes from `resolveWriteTargets`, so a heredoc, a redirect and an
 * `Edit` all reduce to the same answer — which is the whole point of the item.
 *
 * @returns {string|null} an operation name, or null when the call performs none
 */
export function operationFor({ tool, targets = [], runsTraining = false }) {
  if (runsTraining) return 'run-training';
  // Retrieval of a KNOWN source is not discovery. The arxiv fetch verbs name a
  // paper you already have the id of; everything else is a search.
  if (/arxiv/i.test(tool) && /get_paper|download_paper|read_paper/i.test(tool)) {
    return 'retrieve-cited-source';
  }
  if (/^(WebSearch|WebFetch)$/.test(tool) || /Exa__web|Consensus__search|semantic[_-]scholar|arxiv|hf[_-]mcp/i.test(tool)) {
    return 'discover-evidence';
  }
  if (!targets.length) return null;
  if (targets.some((t) => /\.py$/.test(t))) return 'author-code';
  if (targets.some((t) => /[/\\]\.evor[/\\](runs|[^/\\]+\.json)/.test(t))) return 'write-run-state';
  if (targets.some((t) => /[/\\]ticks[/\\][^/\\]+[/\\]/.test(t))) return 'write-artifact';
  return null;
}
