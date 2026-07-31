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
});
