import { describe, it, expect, afterEach } from "vitest";
import { callBridge } from "../src/subprocess-bridge";
import { writeFileSync, rmSync } from "fs";
import { resolve } from "path";

// _bridgeDir is captured at module load = mcp/bridge (mcp/src/../bridge under vitest).
const BRIDGE_DIR = resolve(__dirname, "..", "bridge");
const FAKE = resolve(BRIDGE_DIR, "__test_fake_bridge.py");

describe("callBridge surfaces structured bridge errors on non-zero exit", () => {
  afterEach(() => { try { rmSync(FAKE); } catch { /* ok */ } });

  it("returns the bridge's stdout JSON error, not a blank 'python exited 1'", () => {
    // mimic integrity_bridge: JSON error on STDOUT, empty STDERR, exit 1
    writeFileSync(
      FAKE,
      'import json,sys\nprint(json.dumps({"error":"Node n1 not found in tree.json","node_id":"n1"}))\nsys.exit(1)\n'
    );
    const r = callBridge("__test_fake_bridge.py", []);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("not found in tree.json"); // surfaced, not swallowed
    expect((r.data as any)?.node_id).toBe("n1");          // structured data available
  });
});
