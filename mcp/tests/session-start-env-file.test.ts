/**
 * mcp/tests/session-start-env-file.test.ts
 *
 * Shell commands see a SessionStart hook's variables only through the export
 * lines it appends to $CLAUDE_ENV_FILE; without them `python -m evor.watch`
 * cannot import the harness from the candidate's interpreter.
 */
import { describe, it, expect } from "vitest";
import { spawnSync } from "child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, dirname, resolve } from "path";
import { fileURLToPath } from "url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

describe("session-start exports the harness to shell commands", () => {
  it("appends PYTHONPATH and the plugin root to CLAUDE_ENV_FILE", () => {
    const dir = mkdtempSync(join(tmpdir(), "evor-envfile-"));
    const envFile = join(dir, "env.sh");
    writeFileSync(join(dir, ".deps-ok"), "cached");
    spawnSync("node", [join(ROOT, "hooks/session-start.mjs")], {
      input: "{}",
      encoding: "utf8",
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: dir, CLAUDE_ENV_FILE: envFile, CLAUDE_PLUGIN_ROOT: ROOT, EVOR_ROOT: join(dir, ".evor") },
      cwd: dir,
    });
    const text = readFileSync(envFile, "utf8");
    rmSync(dir, { recursive: true, force: true });
    expect(text).toMatch(new RegExp(`^export PYTHONPATH='${join(ROOT, "harness")}`, "m"));
    expect(text).toMatch(/^export EVOR_PLUGIN_ROOT=/m);
  });
});
