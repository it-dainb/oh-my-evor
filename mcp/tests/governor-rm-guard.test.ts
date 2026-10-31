/**
 * mcp/tests/governor-rm-guard.test.ts
 *
 * An rm on a path built from an unguarded variable stops the client for a
 * person to confirm, which an autonomous mission can never answer. The governor
 * refuses it first, naming the guarded rewrite the client accepts.
 */
import { describe, it, expect } from "vitest";
import { spawnSync } from "child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { resolve, dirname, join } from "path";
import { fileURLToPath } from "url";

const HOOK = resolve(dirname(fileURLToPath(import.meta.url)), "../../hooks/pre-tool-use.mjs");
const RM = "r" + "m";

function decide(command: string) {
  const r = spawnSync("node", [HOOK], {
    input: JSON.stringify({ tool_name: "Bash", tool_input: { command }, agent_type: "oh-my-evor:evor-forge-junior" }),
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", EVOR_ACTIVE_RUN_ID: "r1" },
  });
  try { return JSON.parse((r.stdout ?? "").trim().split("\n").pop() || "{}")?.hookSpecificOutput ?? {}; } catch { return {}; }
}

function decideAt(command: string, root: string) {
  const r = spawnSync("node", [HOOK], {
    input: JSON.stringify({ tool_name: "Bash", tool_input: { command }, agent_type: "oh-my-evor:evor-forge-junior" }),
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", EVOR_ACTIVE_RUN_ID: "r1", EVOR_ROOT: root },
  });
  try { return JSON.parse((r.stdout ?? "").trim().split("\n").pop() || "{}")?.hookSpecificOutput ?? {}; } catch { return {}; }
}

describe("rm on a variable path", () => {
  it("is rewritten to the guarded form and allowed", () => {
    const d = decide(`for n in a b; do ${RM} -rf "$W/$n/data/__pycache__"; done`);
    expect(d.permissionDecision).not.toBe("deny");
    expect(d.updatedInput?.command).toBe(`for n in a b; do ${RM} -rf "\${W:?}/\${n:?}/data/__pycache__"; done`);
  });

  it("rewrites a bare variable target", () => {
    expect(decide(`${RM} -rf $TMPD`).updatedInput?.command).toBe(`${RM} -rf \${TMPD:?}`);
  });

  it("is still refused, with the rewrite named, when the path is single-quoted", () => {
    const d = decide(`${RM} -rf '$W'/x`);
    expect(d.permissionDecision).toBe("deny");
    expect(d.permissionDecisionReason).toMatch(/\$\{W:\?\}/);
  });

  it("is allowed untouched when every variable is guarded", () => {
    const d = decide(`${RM} -rf "\${W:?}/\${n:?}/data/__pycache__"`);
    expect(d.permissionDecision).not.toBe("deny");
    expect(d.updatedInput).toBeUndefined();
  });

  it("is allowed on a literal path, and a word 'rm' in an echo is not an rm", () => {
    expect(decide(`${RM} -f /tmp/scratch-x.txt`).permissionDecision).not.toBe("deny");
    expect(decide(`echo ${RM} $X`).permissionDecision).not.toBe("deny");
  });

  it("still refuses a rewritten rm of the sealed evaluator", () => {
    const root = mkdtempSync(join(tmpdir(), "evor-rmseal-"));
    const run = join(root, "runs", "m1", "r1");
    mkdirSync(join(run, "eval-suites"), { recursive: true });
    writeFileSync(join(root, "active-run.json"), JSON.stringify({ run_id: "r1", mission_id: "m1" }));
    writeFileSync(join(run, "mission-state.json"), JSON.stringify({ status: "running" }));
    const d = decideAt(`R=${run}; ${RM} -f "$R/eval-suites/v1.py"`, root);
    rmSync(root, { recursive: true, force: true });
    expect(d.permissionDecision).toBe("deny");
    expect(d.updatedInput).toBeUndefined();
  });
});
