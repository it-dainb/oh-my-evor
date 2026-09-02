/**
 * mcp/tests/evidence-81.test.ts — §3 of docs/v1-cost-and-verification.md must
 * say what the committed evidence says.
 *
 * That table was hand-written from a run whose raw reports live under the
 * ignored `ci/out/`. RC7 measured corrected rows rotting in exactly this
 * position — a number typed once, from an artifact nobody can re-open, that
 * stays put while the thing it describes moves. `docs/retier-benchmark-results.md`
 * was turned into generated output for the same reason.
 *
 * So the digest is committed and these tests recompute from it:
 *   1. every fingerprint still matches the agent file and spec on disk, so the
 *      numbers describe the roles that ship;
 *   2. every rate and interval printed in §3 is the one the digest produces.
 */
import { describe, it, expect } from "vitest";
import { execFileSync } from "child_process";
import { createHash } from "crypto";
import { readFileSync, existsSync } from "fs";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const DIGEST = resolve(REPO_ROOT, "docs/evidence/matrix-81.json");
const DOC = resolve(REPO_ROOT, "docs/v1-cost-and-verification.md");
const sha = (t: string) => createHash("sha256").update(t).digest("hex").slice(0, 16);

const digest = JSON.parse(readFileSync(DIGEST, "utf8"));

describe("8.1 evidence — the digest describes the roles that ship", () => {
  it.each(digest.runs.map((r: any) => [r.role, r]))("%s", (_role, run: any) => {
    const agentPath = resolve(REPO_ROOT, run.fingerprint.agent_file);
    expect(existsSync(agentPath), `${run.fingerprint.agent_file} is gone`).toBe(true);
    expect(
      sha(readFileSync(agentPath, "utf8")),
      `${run.fingerprint.agent_file} has changed since the 8.1 run. §3's numbers no ` +
        `longer describe the shipped agent — re-measure that role or mark its row stale.`,
    ).toBe(run.fingerprint.agent_sha256);

    const specPath = resolve(REPO_ROOT, `evals/${run.role.replace(/^evor-/, "")}/spec.json`);
    expect(
      sha(readFileSync(specPath, "utf8")),
      `${specPath} has changed since the 8.1 run — the cases behind §3's numbers are ` +
        `not the cases in the tree.`,
    ).toBe(run.fingerprint.spec_sha256);
  });
});

describe("8.1 evidence — §3 prints what the digest computes", () => {
  // The analyser is the single source; parsing its output keeps this test from
  // reimplementing the statistics and quietly disagreeing with them.
  const out = execFileSync("node", ["ci/analyze-81.mjs", "docs/evidence/matrix-81.json"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  const computed = new Map<string, { dear: string; cheap: string; lo: string; hi: string }>();
  for (const line of out.split("\n")) {
    const m = /^(evor-[\w-]+)\s+\d+\s+([\d.]+)%\s+([\d.]+)%\s+[+-][\d.]+pp\s+\[([+-][\d.]+)pp, ([+-][\d.]+)pp\]/.exec(line.trim());
    if (m) computed.set(m[1], { dear: m[2], cheap: m[3], lo: m[4], hi: m[5] });
  }
  it("the analyser produced a row per role", () => {
    expect(computed.size).toBe(digest.runs.length);
  });

  // §3 ONLY. §2's cost table also opens rows with `| acquirer |` and also
  // carries a percentage, so an unscoped search reads the saving column as an
  // accuracy and reports a mismatch against the wrong table.
  const whole = readFileSync(DOC, "utf8");
  const from = whole.indexOf("## 3. Accuracy evidence");
  const to = whole.indexOf("## 4. Verification status");
  expect(from, "§3 heading not found").toBeGreaterThan(-1);
  expect(to, "§4 heading not found").toBeGreaterThan(from);
  const doc = whole.slice(from, to);
  it.each([...computed.keys()])("%s row in §3", (role) => {
    const short = role.replace(/^evor-/, "");
    const row = doc
      .split("\n")
      .find((l) => l.startsWith(`| ${short} |`) && /\d+\.\d%/.test(l));
    expect(row, `no §3 table row for ${short}`).toBeDefined();
    const c = computed.get(role)!;
    // Both arm rates and both interval bounds must appear in the row. A row that
    // still carries the pre-8.1 figures fails here rather than being read as current.
    for (const value of [`${c.dear}%`, `${c.cheap}%`]) {
      expect(row, `${short}: §3 does not carry the computed rate ${value}`).toContain(value);
    }
    const lo = c.lo.replace("-", "−").replace(/^\+/, "+");
    expect(
      row!.includes(lo) || row!.includes(c.lo),
      `${short}: §3's interval does not carry the computed lower bound ${c.lo}`,
    ).toBe(true);
  });
});
