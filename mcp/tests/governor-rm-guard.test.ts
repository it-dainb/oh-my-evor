/**
 * mcp/tests/governor-rm-guard.test.ts
 *
 * An rm on a path built from an unguarded variable stops the client for a
 * person to confirm, which an autonomous mission can never answer. The governor
 * refuses it first, naming the guarded rewrite the client accepts.
 */
import { describe, it, expect } from "vitest";
import { spawnSync } from "child_process";
import { resolve, dirname } from "path";
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

describe("rm on a variable path", () => {
  it("is refused when the variable is unguarded, with the guarded rewrite", () => {
    const d = decide(`for n in a b; do ${RM} -rf "$W/$n/data/__pycache__"; done`);
    expect(d.permissionDecision).toBe("deny");
    expect(d.permissionDecisionReason).toMatch(/\$\{W:\?\}/);
  });

  it("is refused for a bare variable target", () => {
    expect(decide(`${RM} -rf $TMPD`).permissionDecision).toBe("deny");
  });

  it("is allowed when every variable is guarded", () => {
    expect(decide(`${RM} -rf "\${W:?}/\${n:?}/data/__pycache__"`).permissionDecision).not.toBe("deny");
  });

  it("is allowed on a literal path, and a word 'rm' in an echo is not an rm", () => {
    expect(decide(`${RM} -f /tmp/scratch-x.txt`).permissionDecision).not.toBe("deny");
    expect(decide(`echo ${RM} $X`).permissionDecision).not.toBe("deny");
  });
});
