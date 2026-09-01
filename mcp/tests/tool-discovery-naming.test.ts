/**
 * §0.6 — the documented ToolSearch form must resolve a tool that exists.
 *
 * AF4/G-01. Every evor tool registers as `mcp__plugin_oh-my-evor_evor__evor_<name>`:
 * the MCP server namespace plus the tool's own name, so `evor_` appears twice.
 * `ToolSearch("select:…")` matches the exact registered name, so the bare
 * `evor_write_artifact` resolves nothing — and it does so SILENTLY, returning an
 * empty result rather than an error.
 *
 * `skills/evor-mcp/SKILL.md` used to instruct exactly that bare form. Mutagen
 * followed it five times, re-read the skill, tried the CLI, and finally delegated
 * the write to another agent; a `general-purpose` helper in the same run asked for
 * the prefixed name and had the tool first try. Mutagen never held the tool it was
 * told to use. That is a discovery defect, not misuse — and it is the kind that
 * rots back in silently, because the skill file and the registration live apart
 * and nothing compared them. This test is the comparison.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "fs";
import { join, dirname, resolve } from "path";
import { fileURLToPath } from "url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const MCP_PREFIX = "mcp__plugin_oh-my-evor_evor__";
const SKILL = join(REPO, "skills", "evor-mcp", "SKILL.md");

/** Every name passed to `server.tool("<name>", …)` across the tool modules. */
function registeredTools(): Set<string> {
  const dir = join(REPO, "mcp", "src", "tools");
  const names = new Set<string>();
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".ts"))) {
    const src = readFileSync(join(dir, f), "utf8");
    for (const m of src.matchAll(/server\.tool\(\s*\n?\s*"([a-z0-9_]+)"/g)) names.add(m[1]);
  }
  return names;
}

describe("§0.6 — tool discovery", () => {
  const tools = registeredTools();
  const skill = readFileSync(SKILL, "utf8");

  it("the tool modules actually register tools (the harvest regex is not stale)", () => {
    expect(tools.size).toBeGreaterThan(10);
    expect(tools.has("evor_write_artifact")).toBe(true);
  });

  it("every name the skill tells an agent to `select:` is a real registered tool", () => {
    const selected = [...skill.matchAll(/ToolSearch\("select:([^"]+)"\)/g)]
      .flatMap((m) => m[1].split(",").map((s) => s.trim()))
      .filter(Boolean)
      // `…evor_<name>` is the template that teaches the rule, not a name to resolve.
      // Placeholders are excluded; anything concrete must resolve.
      .filter((s) => !s.includes("<"));
    expect(selected.length, "no ToolSearch select: examples found — the regex is stale").toBeGreaterThan(0);

    const unresolvable = selected.filter((name) => {
      if (!name.startsWith(MCP_PREFIX)) return true;          // bare name: select: cannot match it
      return !tools.has(name.slice(MCP_PREFIX.length));        // prefixed but no such tool
    });
    expect(
      unresolvable,
      "`select:` matches the exact registered name. A bare `evor_<name>` matches nothing and " +
        "returns an EMPTY RESULT rather than an error, so an agent following the instruction " +
        "cannot tell the instruction is wrong — it just retries. That is G-01.",
    ).toEqual([]);
  });

  it("the skill states the prefix rule, so a reader can derive names it does not list", () => {
    expect(
      skill.includes(MCP_PREFIX),
      "an agent needing a tool the examples omit must be able to construct the name",
    ).toBe(true);
  });

  it("the skill tells an agent what to do when a select: comes back empty", () => {
    expect(
      /returns nothing|comes back empty|resolves nothing/i.test(skill) && /capability-gap/i.test(skill),
      "five identical retries was the measured response to an empty result. The recovery path " +
        "— keyword search once, then emit a capability-gap signal — has to be written down.",
    ).toBe(true);
  });
});
