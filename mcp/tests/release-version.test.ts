/**
 * mcp/tests/release-version.test.ts — one release version, one writer.
 *
 * The tree carried THREE version strings for one artifact: `plugin.json` at
 * 1.2.1, the npm root at 1.0.2, and `mcp/package.json` at 1.0.2. Neither package
 * is `private`, so all three are meaningful, and nothing compared them — the
 * divergence sat through v1.2.0 and v1.2.1 unnoticed.
 *
 * That is this release's own subject: several descriptions of one fact, with no
 * rule saying which is authoritative. `.claude-plugin/plugin.json` is the
 * release version because it is what the plugin ships and what CHANGELOG
 * documents; these tests make the other two follow it, and make the CHANGELOG's
 * newest entry follow it too, so a release cannot be cut without its own note.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const read = (p: string) => JSON.parse(readFileSync(resolve(REPO_ROOT, p), "utf8"));

const RELEASE = read(".claude-plugin/plugin.json").version as string;

describe("release version — one fact, one writer", () => {
  it("plugin.json carries a semver release version", () => {
    expect(RELEASE, ".claude-plugin/plugin.json has no version").toBeDefined();
    expect(RELEASE).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it.each(["package.json", "mcp/package.json"])("%s matches the release version", (p) => {
    expect(
      read(p).version,
      `${p} disagrees with .claude-plugin/plugin.json (${RELEASE}). One artifact, ` +
        `one version — plugin.json is the writer.`,
    ).toBe(RELEASE);
  });

  it("CHANGELOG's newest entry is this release", () => {
    const changelog = readFileSync(resolve(REPO_ROOT, "CHANGELOG.md"), "utf8");
    const first = /^## \[(\d+\.\d+\.\d+)\]/m.exec(changelog);
    expect(first, "CHANGELOG has no `## [x.y.z]` entry").not.toBeNull();
    expect(
      first![1],
      `CHANGELOG's newest entry is ${first?.[1]} but the release version is ${RELEASE}. ` +
        `A release with no note of its own is a release nobody can read.`,
    ).toBe(RELEASE);
  });
});
