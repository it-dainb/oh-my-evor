/**
 * mcp/tests/no-cwd-relative-paths.test.ts
 *
 * No test may locate repo files relative to `process.cwd()`.
 *
 * Seven test files did, assuming vitest runs from `mcp/` — true under
 * `npm test --workspace=mcp`, false under `npx vitest run mcp/tests/...` from the
 * repo root. From the root those paths pointed one directory too high: every hook
 * spawn in hooks.test.ts died with "Cannot find module", ~189 tests failed for
 * that reason alone, real failures hid among them, and 26 further tests SKIPPED
 * themselves silently. A suite whose result depends on which directory you ran it
 * from is reporting on the directory.
 */

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));

describe("test paths are anchored to the test file", () => {
  it("no test resolves a repo path from process.cwd()", () => {
    const offenders = readdirSync(TEST_DIR)
      .filter((f) => f.endsWith(".ts") && f !== "no-cwd-relative-paths.test.ts")
      .filter((f) =>
        readFileSync(join(TEST_DIR, f), "utf8")
          .split("\n")
          // Code only: a comment quoting the old pattern to explain it is allowed.
          .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
          .some((line) => /resolve\(\s*process\.cwd\(\)/.test(line)),
      );
    expect(
      offenders,
      "use resolve(dirname(fileURLToPath(import.meta.url)), ...) instead",
    ).toEqual([]);
  });
});
