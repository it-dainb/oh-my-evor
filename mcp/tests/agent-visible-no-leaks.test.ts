/**
 * mcp/tests/agent-visible-no-leaks.test.ts
 *
 * Everything the plugin's agents read is operating instructions, not a development
 * diary. Agent files, skills, commands and reference docs had accumulated incident
 * dates, mission names, tick anecdotes, plugin and CLI version numbers, finding ids
 * and paths into the plugin's own source. An agent that knows how its governor is
 * built studies it instead of doing its job, and the history only belongs in the
 * changelog and in code comments.
 *
 * A line quoted verbatim by the bench corpus is exempt only if it is itself clean,
 * so this test cannot be satisfied by moving history into a quoted line.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync, existsSync } from "fs";
import { join, resolve, dirname, relative } from "path";
import { fileURLToPath } from "url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const PATTERNS: [string, RegExp][] = [
  ["date", /\b20\d\d-\d\d-\d\d\b/],
  ["mission name", /binarization|worldmodel|recall-2026/i],
  ["plugin version", /\bv?1\.2\.\d+\b/],
  ["CLI version", /\b2\.1\.\d{3}\b/],
  ["field-run story", /\bfield (?:run|log|trace|mission|runs)\b|\bin the field\b/i],
  ["tick anecdote", /\btick \d+ of\b|\bin tick \d+\b/],
  ["finding id", /\b[Ii]tem \d+\.\d+\b|\b(?:AF\d|RC\d+|PM\d|K-\d\d|O-\d\d)\b/],
  ["plugin source path", /\.mjs\b|harness\/evor|mcp\/src|mcp\/bridge|governor.s (?:own )?source/],
  ["bench reference", /evor-eval-bench|\bthe bench\b/i],
  ["section mark", /§\s*\d/],
  ["history narration", /\bused to (?:say|tell|prescribe)\b|\b[Ee]arlier text\b/],
];

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith(".md")) out.push(p);
  }
  return out;
}

const surfaces = [
  ...walk(join(ROOT, "agents")),
  ...walk(join(ROOT, "skills")).filter((p) => p.endsWith("SKILL.md")),
  ...walk(join(ROOT, "commands")),
];

describe("agent-visible text carries no development history", () => {
  it("found the surfaces", () => expect(surfaces.length).toBeGreaterThan(20));

  it.each(surfaces.map((p) => [relative(ROOT, p), p]))("%s", (_rel, path) => {
    const hits: string[] = [];
    readFileSync(path as string, "utf8").split("\n").forEach((line, i) => {
      for (const [name, re] of PATTERNS) if (re.test(line)) hits.push(`${i + 1} [${name}] ${line.trim().slice(0, 120)}`);
    });
    expect(hits, `development history in ${_rel}:\n${hits.join("\n")}`).toEqual([]);
  });
});

// ── Strings the hooks and MCP tools emit ─────────────────────────────────────
// Deny reasons, nudges, stop-hook blocks, session context, tool and parameter
// descriptions and error strings reach a model too. Comments are developer-facing
// and are stripped first; module specifiers (`from "./lib/x.mjs"`) are never emitted.
function codeFiles(dir: string, ext: RegExp, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) { if (e !== "node_modules" && e !== "dist") codeFiles(p, ext, out); }
    else if (ext.test(p)) out.push(p);
  }
  return out;
}
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:'"`\\])\/\/[^\n]*/g, (m, a) => a + " ".repeat(m.length - a.length));
}
const CODE_PATTERNS: [string, RegExp][] = PATTERNS.filter(([n]) => n !== "bench reference" && n !== "history narration");

describe("strings the hooks and MCP tools emit carry no development history", () => {
  const files = [...codeFiles(join(ROOT, "hooks"), /\.mjs$/), ...codeFiles(join(ROOT, "mcp", "src"), /\.ts$/)];
  it("found the code", () => expect(files.length).toBeGreaterThan(20));
  it.each(files.map((p) => [relative(ROOT, p), p]))("%s", (_rel, path) => {
    const src = stripComments(readFileSync(path as string, "utf8"));
    const hits: string[] = [];
    for (const m of src.matchAll(/`(?:\\.|[^`\\])*`|'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"/g)) {
      const before = src.slice(Math.max(0, (m.index ?? 0) - 12), m.index);
      if (/(from\s*|import\s*\(\s*|require\s*\(\s*)$/.test(before)) continue;
      for (const [name, re] of CODE_PATTERNS) {
        if (re.test(m[0])) { hits.push(`${src.slice(0, m.index).split("\n").length} [${name}] ${m[0].slice(0, 110)}`); break; }
      }
    }
    expect(hits, `emitted strings with development history in ${_rel}:\n${hits.join("\n")}`).toEqual([]);
  });
});
