/**
 * mcp/tests/skill-command-name-collision.test.ts
 *
 * `commands/<n>.md` and `skills/<n>/SKILL.md` share the address `oh-my-evor:<n>`,
 * and the COMMAND wins. For a human typing `/evor` that is harmless — the stub's
 * dispatch says "read the SKILL.md" and the session has Bash. For an agent that
 * names the skill in its `skills:` frontmatter it is not: the agent receives the
 * ~1.3KB stub instead of the ~40KB procedure.
 *
 * Measured in binarization-worldmodel-recall-2026-09: evor-tick declares
 * `disallowedTools: Bash` and the stub's dispatch was `cat`. It invoked
 * `oh-my-evor:evor` nine times, got the stub every time, could not execute it,
 * and ran the tick without ever seeing the 9-step loop. Nothing failed loudly —
 * the skill "loaded", it just carried a pointer instead of the procedure.
 *
 * evor-mcp is the control: it has no command of that name, and its body arrived
 * intact in the same context.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, existsSync } from "fs";
import { join, dirname, resolve } from "path";
import { fileURLToPath } from "url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const COMMANDS = join(ROOT, "commands");
const AGENTS = join(ROOT, "agents");

const commandNames = readdirSync(COMMANDS)
  .filter((f) => f.endsWith(".md"))
  .map((f) => f.replace(/\.md$/, ""));

describe("no command shadows a skill", () => {
  // Which of a same-name command and skill wins is not stable: /oh-my-evor:evor-run
  // loaded the SKILL in one binarization session and the command stub in another
  // (2026-10-30), and the stub's `Read("${EVOR_PLUGIN_ROOT:-...}")` cannot be
  // expanded by the Read tool, so that session opened with a denied Bash call.
  // The stubs carried nothing the skill does not, so they are gone.
  for (const name of commandNames) {
    it(`/${name} has no skills/${name}/SKILL.md behind it`, () => {
      expect(existsSync(join(ROOT, "skills", name, "SKILL.md"))).toBe(false);
    });
  }
});

describe("evor-tick knows its procedure does not arrive via frontmatter", () => {
  const src = readFileSync(join(AGENTS, "evor-tick.md"), "utf8");

  it("declares the evor skill and forbids Bash — the combination that broke", () => {
    expect(src).toMatch(/skills:.*oh-my-evor:evor\b/);
    expect(src).toMatch(/disallowedTools:.*Bash/);
  });

  it("tells the tick to Read SKILL.md explicitly", () => {
    expect(src).toMatch(/Read\("\$\{EVOR_PLUGIN_ROOT:-\$CLAUDE_PLUGIN_ROOT\}\/skills\/evor\/SKILL\.md"\)/);
  });

  it("does not claim the skill is already loaded", () => {
    expect(src).not.toMatch(/skill, loaded above/);
  });

  it("tells the tick to wait by spawning in the FOREGROUND, not by TaskOutput", () => {
    // This case used to require the agent file to prescribe
    // `ToolSearch("select:TaskOutput,Monitor")` and a TaskOutput block. That
    // tool is not available to a sub-agent; the wait primitive is a foreground
    // Agent call, which blocks until the child returns. A tick told otherwise
    // backgrounded its children and was never resumed (2026-10-30, 0 nodes).
    expect(src).toMatch(/FOREGROUND/);
    expect(src).toMatch(/several `Agent` calls in ONE message/);
    expect(src).not.toMatch(/ToolSearch\("select:TaskOutput/);
  });
});
