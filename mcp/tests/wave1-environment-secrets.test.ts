/**
 * mcp/tests/wave1-environment-secrets.test.ts — wave-2 RED tests for field-trace
 * category 8 (ENVIRONMENT & SECRETS), lane R, for the findings whose logic lives
 * outside the Python harness.
 *
 * Source lane: docs/field-trace-v1.2.0/lanes/lane-r-environment-hygiene.md
 *
 * These assert the CORRECT invariant and are expected to FAIL until the
 * production change lands. No real credential appears anywhere in this file:
 * every secret-shaped value is synthetic.
 *
 * Findings covered here:
 *   R-07  .deps-ok is a bare 24-byte timestamp that cannot fail
 *   R-14  .mcp.json sends `Bearer ` with an unset ${user_config.hf_token}
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from "fs";
import { join, resolve } from "path";
import { tmpdir } from "os";

const REPO_ROOT = resolve(process.cwd(), "..");
const HOOKS_DIR = join(REPO_ROOT, "hooks");
const SESSION_START = join(HOOKS_DIR, "session-start.mjs");

function runHook(scriptPath: string, env: Record<string, string>) {
  return spawnSync(process.execPath, [scriptPath], {
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", ...env },
    encoding: "utf8",
    timeout: 15000,
  });
}

/** Pre-seed the caches session-start would otherwise compute, except .deps-ok. */
function seedUnrelatedCaches(dir: string) {
  writeFileSync(join(dir, ".uv-ok"), "cached");
  writeFileSync(
    join(dir, ".workspace-class"),
    JSON.stringify({ class: "greenfield", counts: { models: 0, datasets: 0, configs: 0, logs: 0 } }),
  );
}

// ─── R-07 — the dependency sentinel ───────────────────────────────────────────

/**
 * R-07 (HIGH). `.evor/.deps-ok` is a bare 24-byte ISO timestamp. It records no
 * package list, no version set, no interpreter path, and no hash of anything,
 * so once written it CANNOT FAIL: it survives a removed package, a swapped
 * conda env, or a GPU driver reload untouched. Across the 19-hour run it was
 * written once at 03:53 and never revalidated.
 *
 * This is the same defect class as the `return True` stub that v1.2.0 removed
 * from `IntegrityGate._check_no_label_contamination`: a check whose result is
 * constant by construction is not a check, it is a marker that someone once ran
 * one. Both pass unconditionally; neither can ever report the condition it
 * names. The fix is the same in both cases — make the check consume real
 * evidence and let it fail.
 */
describe("R-07 — dependency sentinel records what it verified", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "evor-r07-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("writes the interpreter and the verified package set, not a bare timestamp", () => {
    seedUnrelatedCaches(tmpDir);
    const res = runHook(SESSION_START, {
      EVOR_ROOT: tmpDir,
      CLAUDE_PLUGIN_ROOT: REPO_ROOT,
    });
    expect(res.status).toBe(0);

    const sentinelPath = join(tmpDir, ".deps-ok");
    expect(existsSync(sentinelPath)).toBe(true);

    const raw = readFileSync(sentinelPath, "utf8");
    let parsed: any;
    expect(
      () => { parsed = JSON.parse(raw); },
      `.deps-ok is not structured evidence — it is ${raw.length} bytes of ${JSON.stringify(raw)}. ` +
      `A marker that records nothing cannot fail; this is the same defect class as a ` +
      `\`return True\` integrity stub.`,
    ).not.toThrow();

    expect(parsed).toHaveProperty("python");
    expect(parsed).toHaveProperty("packages");
    expect(Object.keys(parsed.packages ?? {}).length).toBeGreaterThan(0);
  });

  it("revalidates when the recorded interpreter no longer matches", () => {
    seedUnrelatedCaches(tmpDir);
    // A sentinel that attests a DIFFERENT interpreter than the one now in use.
    writeFileSync(
      join(tmpDir, ".deps-ok"),
      JSON.stringify({
        python: "/opt/conda/envs/some-other-env/bin/python3",
        packages: { pydantic: "2.5.0", pyyaml: "6.0" },
        verified_at: "2026-08-23T03:53:19.779Z",
      }),
    );

    // Point EVOR_PYTHON at an interpreter that cannot import the harness, so a
    // real revalidation must produce the missing-dependency warning.
    const fakePy = join(tmpDir, "fake-python");
    writeFileSync(fakePy, "#!/bin/sh\necho \"ModuleNotFoundError: No module named 'evor'\" >&2\nexit 1\n", { mode: 0o755 });

    const res = runHook(SESSION_START, {
      EVOR_ROOT: tmpDir,
      CLAUDE_PLUGIN_ROOT: REPO_ROOT,
      EVOR_PYTHON: fakePy,
    });

    expect(
      res.stdout,
      "the sentinel attests an interpreter that is not the one in use, and the " +
      "current one cannot import the harness — session-start short-circuited on " +
      "the sentinel's mere existence instead of revalidating",
    ).toMatch(/dependencies are not installed/i);
  });

  it("is invalidated when a previously verified package disappears", () => {
    seedUnrelatedCaches(tmpDir);
    writeFileSync(
      join(tmpDir, ".deps-ok"),
      JSON.stringify({
        // Interpreter matches the hook's default, so the ONLY thing wrong here
        // is the attested package set.
        python: "python3",
        packages: { pydantic: "2.5.0", pyyaml: "6.0", "definitely-not-installed": "1.0.0" },
        verified_at: "2026-08-23T03:53:19.779Z",
      }),
    );

    const res = runHook(SESSION_START, {
      EVOR_ROOT: tmpDir,
      CLAUDE_PLUGIN_ROOT: REPO_ROOT,
    });

    const rewritten = readFileSync(join(tmpDir, ".deps-ok"), "utf8");
    expect(
      rewritten,
      "a sentinel naming a package that is not installed was accepted verbatim; " +
      "a changed environment must invalidate it",
    ).not.toContain("definitely-not-installed");
    expect(res.status).toBe(0);
  });
});

// ─── R-14 — no bearer header with an unresolved placeholder ───────────────────

/**
 * R-14 (LOW). `.mcp.json` declares hf-mcp with
 * `"Authorization": "Bearer ${user_config.hf_token}"`. No hf_token is configured
 * anywhere, so a malformed `Bearer ` header goes out on every call — the server
 * confirmed it by replying that the tools were being used anonymously.
 *
 * The correct behaviour is to omit the header entirely when the token is not
 * configured, rather than sending an empty bearer credential. A declaration
 * that cannot be conditionally omitted must not carry an Authorization header
 * at all.
 */
describe("R-14 — no Authorization header with an unresolvable placeholder", () => {
  const mcpConfig = JSON.parse(readFileSync(join(REPO_ROOT, ".mcp.json"), "utf8"));

  it("declares no Authorization header whose value is a bare placeholder", () => {
    const offenders: string[] = [];
    for (const [name, server] of Object.entries<any>(mcpConfig.mcpServers ?? {})) {
      const headers: Record<string, string> = server?.headers ?? {};
      for (const [header, value] of Object.entries(headers)) {
        if (header.toLowerCase() !== "authorization") continue;
        // `Bearer ${...}` with nothing else: if the placeholder is unset, the
        // wire value is the literal string "Bearer ".
        if (/^\s*Bearer\s+\$\{[^}]*\}\s*$/.test(value)) {
          offenders.push(`${name}.headers.${header} = ${JSON.stringify(value)}`);
        }
      }
    }

    expect(
      offenders,
      "an Authorization header built solely from an unset placeholder sends " +
      "`Bearer ` on every call. Omit the header when no token is configured.",
    ).toEqual([]);
  });

  it("hardcodes no credential in .mcp.json", () => {
    // Regression guard for the good half of R-14: the config is clean on the
    // secret-hygiene axis and must stay that way. Synthetic shapes only.
    const raw = readFileSync(join(REPO_ROOT, ".mcp.json"), "utf8");
    const secretShapes = [
      /\bsk-ant-[A-Za-z0-9_-]{8,}/,
      /\bhf_[A-Za-z0-9]{8,}/,
      /\bs2k-[A-Za-z0-9]{8,}/,
      /\bghp_[A-Za-z0-9]{8,}/,
      /\bAKIA[0-9A-Z]{8,}/,
    ];
    for (const re of secretShapes) {
      expect(raw, `.mcp.json contains a value matching ${re}`).not.toMatch(re);
    }
  });
});
