/**
 * A restart stops every agent of the session. An agent cut off mid-call leaves a
 * transcript whose last message is not terminal, so by that test alone it reads as
 * live forever; one last written before the current CLI process started is not live.
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { liveSubagents, cliStartMs } from "../../hooks/lib/waiting.mjs";

let root: string;
afterEach(() => rmSync(root, { recursive: true, force: true }));

function session() {
  root = mkdtempSync(join(tmpdir(), "evor-restart-"));
  const transcript = join(root, "sess.jsonl");
  writeFileSync(transcript, "");
  const dir = join(root, "sess", "subagents");
  mkdirSync(dir, { recursive: true });
  return { transcript, dir };
}

/** An agent whose last message is a pending tool call: live by the message test. */
function midCall(dir: string, id: string, mtimeMs: number) {
  const p = join(dir, `agent-${id}.jsonl`);
  writeFileSync(p, JSON.stringify({ type: "assistant", message: { stop_reason: "tool_use", content: [] } }) + "\n");
  writeFileSync(p.replace(/\.jsonl$/, ".meta.json"), JSON.stringify({ agentType: "oh-my-evor:evor-forge" }));
  utimesSync(p, mtimeMs / 1000, mtimeMs / 1000);
}

describe("live sub-agents across a restart", () => {
  it("drops an agent last written before the CLI started, keeps one written after", () => {
    const { transcript, dir } = session();
    const start = Date.now() - 60_000;
    midCall(dir, "before", start - 3_600_000);
    midCall(dir, "after", start + 30_000);
    const live = liveSubagents("sess", transcript, Date.now(), start);
    expect(live).toHaveLength(1);
  });

  it("keeps the message test alone when the start time is unknown", () => {
    const { transcript, dir } = session();
    midCall(dir, "old", Date.now() - 86_400_000);
    expect(liveSubagents("sess", transcript, Date.now(), null)).toHaveLength(1);
  });

  it("finds a start time on Linux, in the past", () => {
    const t = cliStartMs();
    if (t !== null) expect(t).toBeLessThan(Date.now());
  });
});
