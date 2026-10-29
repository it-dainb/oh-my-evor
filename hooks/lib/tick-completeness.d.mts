/**
 * Types for `tick-completeness.mjs`.
 *
 * The implementation stays plain .mjs because the hooks run from source with no
 * build step, while the MCP server is TypeScript. One implementation, imported
 * by both; this file is only what lets `tsc` see it. Keep it in step with the
 * module — it is a declaration, not a second opinion.
 */

export interface OwedProposal {
  proposal_id: string;
  node_id?: string;
  node_name?: string;
  /** Which of 'node' | 'integrity_verdict' | 'fitness' | 'telemetry' is absent. */
  missing: string[];
}

export function selectedProposals(runDir: string, tick: number): string[];
export function owed(runDir: string, tick: number): OwedProposal[];
export function isTickComplete(runDir: string, tick: number): boolean;
export function describeOwed(list: OwedProposal[]): string;
