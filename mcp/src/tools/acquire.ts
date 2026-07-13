/**
 * tools/acquire.ts
 * evor_check_leakage — server-side acquisition dedup / near-dup gate (AREA 2).
 *
 * Moves the Deduplication_Protocol logic out of agent prose so agents never
 * see the algorithm or thresholds.  The harness (evor.acquire) owns all
 * sha256 exact-match, per-modality near-dup, and intra-batch dedup logic.
 *
 * evor_check_leakage — check candidate paths against a forbidden eval split;
 *                      returns accepted set + drop counts + collision_log.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { resolveRunPaths } from "../run-store.js";
import { callPythonModule } from "../subprocess-bridge.js";

// ── Core function (exported for tests) ───────────────────────────────────────

/**
 * Run the acquisition leakage check via `python -m evor.acquire check-leakage`.
 *
 * The harness computes exact sha256 collisions + per-modality near-dup checks
 * (image phash Hamming≤8, text MinHashLSH Jaccard≥0.8, tabular L2<1% range)
 * and optional intra-batch dedup.
 *
 * Returns accepted_paths + drop counts + collision_log (path+collision_type only;
 * no internal run paths are exposed in the log).
 */
export function checkLeakage(
  candidatePaths: string[],
  modality: "image" | "text" | "tabular",
  forbiddenSplitPath: string,
  runDir: string,
  nearDup: boolean = true,
  intraBatch: boolean = true,
): ReturnType<typeof callPythonModule> {
  return callPythonModule("evor.acquire", [
    "check-leakage",
    "--run-id", runDir,
    "--candidate-paths", JSON.stringify(candidatePaths),
    "--modality", modality,
    "--forbidden-split", forbiddenSplitPath,
    "--near-dup", nearDup ? "true" : "false",
    "--intra-batch", intraBatch ? "true" : "false",
  ], { timeout: 120_000 });
}

// ── Tool registration ─────────────────────────────────────────────────────────

export function registerAcquireTools(server: McpServer): void {
  server.tool(
    "evor_check_leakage",
    "Acquisition dedup / near-dup gate. Call before integrating any new data to ensure " +
    "zero candidates collide with the frozen eval split (exact sha256 match or near-dup). " +
    "Checks: exact content hash collision, per-modality near-dup (image phash Hamming≤8, " +
    "text MinHashLSH Jaccard≥0.8, tabular L2<1% of feature range), and optional intra-batch " +
    "dedup. Returns the accepted set, per-category drop counts, and a collision_log " +
    "(path + collision_type only — no internal paths or thresholds exposed). " +
    "A false negative (letting a collision through) is an inviolable integrity failure.",
    {
      run_id: z.string().describe("Active run identifier"),
      candidate_paths: z
        .array(z.string())
        .describe("Absolute paths to candidate data files to check"),
      modality: z
        .enum(["image", "text", "tabular"])
        .describe("Data modality — determines which near-dup algorithm is applied"),
      forbidden_split: z
        .string()
        .describe(
          "Path to the frozen test split JSON (e.g. frozen-splits/<eval_version>-test.json) " +
          "that candidates must not collide with"
        ),
      near_dup: z
        .boolean()
        .optional()
        .describe("Enable per-modality near-dup check (default true)"),
      intra_batch: z
        .boolean()
        .optional()
        .describe("Enable intra-batch dedup across the candidate set (default true)"),
    },
    async ({ run_id, candidate_paths, modality, forbidden_split, near_dup, intra_batch }) => {
      const missionId = process.env.EVOR_MISSION_ID;
      const paths = resolveRunPaths(run_id, missionId);

      const result = checkLeakage(
        candidate_paths,
        modality,
        forbidden_split,
        paths.runDir,
        near_dup ?? true,
        intra_batch ?? true,
      );

      if (!result.ok) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ ok: false, error: result.error }),
            },
          ],
        };
      }

      // Strip any full run-dir prefix from collision_log paths so the agent
      // never receives internal filesystem layout details.
      const data = result.data as Record<string, unknown> | null;
      const safeData =
        data && typeof data === "object"
          ? {
              ...data,
              collision_log: Array.isArray(data.collision_log)
                ? (data.collision_log as Array<{ path: string; collision_type: string }>).map(
                    ({ path, collision_type }) => ({
                      // Return only the basename so no internal paths leak
                      path: path.split("/").at(-1) ?? path,
                      collision_type,
                    })
                  )
                : [],
            }
          : data;

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(safeData),
          },
        ],
      };
    }
  );
}
