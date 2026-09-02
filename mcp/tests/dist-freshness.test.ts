/**
 * mcp/tests/dist-freshness.test.ts
 *
 * The MCP server the agents actually talk to is `mcp/dist/index.cjs`, a bundle.
 * Every test in this suite imports TypeScript from `src/`. So a source fix can be
 * written, reviewed, tested, committed and shipped while the running server still
 * executes the old code.
 *
 * This is not hypothetical. Caught mid-session: `dist/index.cjs` was four days
 * stale while `record.ts`, `artifact.ts` and `tree.ts` had all been fixed. Three
 * changes — tree-node metrics, selector schema validation, and removing a dead
 * agent-facing field — were all green in 1009 tests and none of them were in the
 * binary that runs. The next benchmark would have "validated" fixes that were not
 * executing.
 *
 * It is the same defect class this repo keeps producing: something that reads as
 * done and is inert at runtime. The distinguishing feature is always that nothing
 * checked the artifact that actually runs.
 */

import { spawnSync } from "child_process";
import { describe, it, expect } from "vitest";
import { statSync, existsSync, readdirSync } from "fs";
import { join, dirname, resolve } from "path";
import { fileURLToPath } from "url";

const MCP = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DIST = join(MCP, "dist", "index.cjs");
const SRC = join(MCP, "src");

/** Every .ts file under src/, recursively. */
function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return sources(p);
    return e.name.endsWith(".ts") ? [p] : [];
  });
}

describe("the built server is not older than the source it is built from", () => {
  it("dist/index.cjs exists", () => {
    expect(existsSync(DIST), "run `npm run build` in mcp/").toBe(true);
  });

  it("no source file is newer than the bundle", () => {
    const distTime = statSync(DIST).mtimeMs;
    const stale = sources(SRC)
      .filter((f) => statSync(f).mtimeMs > distTime)
      .map((f) => f.slice(MCP.length + 1));

    expect(
      stale,
      `these sources are newer than dist/index.cjs, so the running server does NOT ` +
        `contain them — run \`npm run build\` in mcp/:\n  ${stale.join("\n  ")}`,
    ).toEqual([]);
  });
  // ── The check that was missing, and it cost the whole Phase 8 run ─────────
  //
  // `fsm.ts` used `import.meta.url`, which esbuild rewrites to `undefined` in a
  // CJS bundle, so `fileURLToPath(undefined)` threw at module load and the
  // shipped MCP server could not start AT ALL. Every test passed throughout:
  // vitest runs the TypeScript source as ESM, and the two checks above only
  // assert the bundle EXISTS and is not stale. Nothing executed it.
  //
  // Same class as the hook that passed `node --check` and threw at load —
  // validating a property of the artifact is not the same as running it.
  it("the shipped bundle actually starts", () => {
    const r = spawnSync(process.execPath, [DIST], {
      input: "",                      // empty stdin: the server should exit cleanly
      encoding: "utf8",
      timeout: 30_000,
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? "/tmp" },
    });
    const stderr = r.stderr ?? "";
    expect(
      /ERR_INVALID_ARG_TYPE|ReferenceError|TypeError|Cannot find module|SyntaxError/.test(stderr),
      `mcp/dist/index.cjs failed at load:\n${stderr.slice(0, 800)}`,
    ).toBe(false);
  });

});
