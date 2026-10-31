/**
 * mcp/tests/write-targets-bypass.test.ts
 *
 * Writes of candidate code or run state hidden behind python constructs the reader
 * does not model (a decoy literal write, os.rename, subprocess, a mode in a variable,
 * a path through /tmp/.., a script written and then run) must still be judged as
 * those operations. Cases live in write-targets-bypass-cases.json (command, cwd /proj/W).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { resolveWriteTargets } from "../../hooks/lib/write-targets.mjs";
import { operationFor } from "../../hooks/lib/operations.mjs";

const cases: [string, string][] = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "write-targets-bypass-cases.json"), "utf8"),
);

describe("python write bypasses are judged", () => {
  for (const [name, command] of cases) {
    it(name, () => {
      const { targets } = resolveWriteTargets({ tool: "Bash", toolInput: { command }, cwd: "/proj/W" });
      expect(["author-code", "write-run-state"]).toContain(operationFor({ tool: "Bash", targets }));
    });
  }
});
