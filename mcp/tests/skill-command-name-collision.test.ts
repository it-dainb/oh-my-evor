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

describe("a command that shadows a skill must dispatch with a tool every agent has", () => {
  for (const name of commandNames) {
    if (!existsSync(join(ROOT, "skills", name, "SKILL.md"))) continue;
    it(`/${name} does not tell the reader to shell out`, () => {
      const src = readFileSync(join(COMMANDS, `${name}.md`), "utf8");
      // The dispatch step — everything before the fallback discussion.
      const dispatch = src.split(/If `\$CLAUDE_PLUGIN_ROOT` happens to be unset/)[0];
      expect(dispatch, `/${name} dispatch still uses cat`).not.toMatch(
        /```bash\s*\n\s*cat "/,
      );
      expect(dispatch, `/${name} dispatch must name the Read tool`).toMatch(/Read\(/);
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

  it("names the wait tools AND that they must be ToolSearch'd first", () => {
    // The measured tick never loaded either one; the string "TaskOutput" did not
    // appear anywhere in its context, because the wait discipline lives in the
    // SKILL.md that never arrived.
    expect(src).toMatch(/TaskOutput/);
    expect(src).toMatch(/Monitor/);
    expect(src).toMatch(/ToolSearch\("select:TaskOutput/);
  });
});
