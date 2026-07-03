#!/usr/bin/env node
/**
 * L1 structural lint for oh-my-evor plugin.
 *
 * Checks:
 *   1. .claude-plugin/plugin.json parses as valid JSON
 *   2. All skill paths in plugin.json have a SKILL.md
 *   3. All agent paths in plugin.json exist on disk
 *   4. commands/ directory exists
 *   5. .mcp.json referenced by mcpServers exists
 *   6. Each SKILL.md has required frontmatter (name, description, level)
 *   7. hooks/hooks.json parses as valid JSON
 *
 * Missing files are REPORTED (not fatal) — M0 scaffold may precede full content.
 * Script exits 0 on success (even with warnings); exits 1 only on parse errors or
 * structural invariant violations (plugin.json not parseable, skills[] missing, etc).
 */

import { readFileSync, existsSync } from 'fs';
import { resolve, dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

let warnings = 0;
let errors = 0;

function ok(msg) {
  console.log(`  [OK]   ${msg}`);
}

function warn(msg) {
  console.warn(`  [WARN] ${msg}`);
  warnings++;
}

function fail(msg) {
  console.error(`  [FAIL] ${msg}`);
  errors++;
}

function parseJson(filePath, label) {
  const abs = join(REPO_ROOT, filePath);
  if (!existsSync(abs)) {
    fail(`${label} not found: ${filePath}`);
    return null;
  }
  try {
    const content = readFileSync(abs, 'utf8');
    const parsed = JSON.parse(content);
    ok(`${label} parses as valid JSON`);
    return parsed;
  } catch (e) {
    fail(`${label} is not valid JSON: ${e.message}`);
    return null;
  }
}

function parseFrontmatter(content) {
  // YAML frontmatter between --- delimiters
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return null;
  const fm = {};
  for (const line of match[1].split(/\r?\n/)) {
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim().replace(/^["']|["']$/g, '');
    fm[key] = value;
  }
  return fm;
}

console.log('\noh-my-evor L1 structural lint\n');

// ── 1. Parse plugin.json ──────────────────────────────────────────────────────
console.log('1. plugin.json');
const plugin = parseJson('.claude-plugin/plugin.json', 'plugin.json');
if (!plugin) {
  console.error('\nFATAL: plugin.json unparseable — aborting L1 check');
  process.exit(1);
}

// ── 2. Check skill paths ──────────────────────────────────────────────────────
console.log('\n2. Skill paths');
const skills = plugin.skills ?? [];
if (!Array.isArray(skills) || skills.length === 0) {
  fail('plugin.json skills[] is empty or missing');
} else {
  for (const skillPath of skills) {
    const skillMd = join(REPO_ROOT, skillPath, 'SKILL.md');
    if (!existsSync(skillMd)) {
      warn(`SKILL.md missing for skill ${skillPath}`);
    } else {
      const content = readFileSync(skillMd, 'utf8');
      const fm = parseFrontmatter(content);
      if (!fm) {
        warn(`${skillPath}/SKILL.md has no frontmatter`);
      } else {
        const missing = ['name', 'description', 'level'].filter(k => !fm[k]);
        if (missing.length > 0) {
          warn(`${skillPath}/SKILL.md frontmatter missing: ${missing.join(', ')}`);
        } else {
          ok(`${skillPath}/SKILL.md frontmatter OK (name=${fm.name})`);
        }
      }
    }
  }
}

// ── 3. Check agent paths ──────────────────────────────────────────────────────
console.log('\n3. Agent paths');
const agents = plugin.agents ?? [];
if (!Array.isArray(agents) || agents.length === 0) {
  warn('plugin.json agents[] is empty or missing');
} else {
  for (const agentPath of agents) {
    const abs = join(REPO_ROOT, agentPath);
    if (!existsSync(abs)) {
      warn(`Agent file missing: ${agentPath}`);
    } else {
      ok(`Agent exists: ${agentPath}`);
    }
  }
}

// ── 4. Check commands/ directory ─────────────────────────────────────────────
console.log('\n4. Commands directory');
const commandsPath = plugin.commands ? join(REPO_ROOT, plugin.commands) : null;
if (!commandsPath) {
  warn('plugin.json commands field missing');
} else if (!existsSync(commandsPath)) {
  warn(`commands directory missing: ${plugin.commands}`);
} else {
  ok(`commands directory exists: ${plugin.commands}`);
}

// ── 5. Check .mcp.json ───────────────────────────────────────────────────────
console.log('\n5. mcpServers file');
const mcpRef = plugin.mcpServers;
if (!mcpRef) {
  warn('plugin.json mcpServers field missing');
} else {
  const mcpAbs = join(REPO_ROOT, mcpRef);
  if (!existsSync(mcpAbs)) {
    warn(`mcpServers file missing: ${mcpRef}`);
  } else {
    parseJson(mcpRef, '.mcp.json');
  }
}

// ── 6. hooks/hooks.json ───────────────────────────────────────────────────────
console.log('\n6. hooks/hooks.json');
parseJson('hooks/hooks.json', 'hooks/hooks.json');

// ── 7. mcp/src/index.ts ──────────────────────────────────────────────────────
console.log('\n7. MCP entry');
const mcpEntry = join(REPO_ROOT, 'mcp/src/index.ts');
if (!existsSync(mcpEntry)) {
  warn('mcp/src/index.ts missing');
} else {
  ok('mcp/src/index.ts exists');
}

// ── 8. harness/evor/__init__.py ───────────────────────────────────────────────
console.log('\n8. Harness package');
const harnessInit = join(REPO_ROOT, 'harness/evor/__init__.py');
if (!existsSync(harnessInit)) {
  warn('harness/evor/__init__.py missing');
} else {
  ok('harness/evor/__init__.py exists');
}

// ── Summary ───────────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(50)}`);
console.log(`L1 result: ${errors} error(s), ${warnings} warning(s)`);
if (errors > 0) {
  console.error('L1 FAILED\n');
  process.exit(1);
} else {
  console.log('L1 PASSED\n');
  process.exit(0);
}
