/**
 * mcp/tests/evor-wait-heartbeat-marker.test.ts
 *
 * The stop hook lets main yield only while a heartbeat wait is armed. The marker
 * that says so must not count as run activity, or arming it would hide a stall.
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { lastActivity, HEARTBEAT_FILE } from "../src/tools/wait.js";

describe("heartbeat marker", () => {
  it("is not run activity", () => {
    const run = join(mkdtempSync(join(tmpdir(), "evor-hb-")), "runs", "m", "r");
    mkdirSync(run, { recursive: true });
    const old = join(run, "tick-state.json");
    writeFileSync(old, "{}");
    const t = (Date.now() - 3_600_000) / 1000;
    utimesSync(old, t, t);
    writeFileSync(join(run, HEARTBEAT_FILE), "{}");
    expect(Date.now() - lastActivity(run)).toBeGreaterThan(3_000_000);
  });
});
