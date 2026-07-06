#!/usr/bin/env node
/**
 * py-mcp.cjs — launch a Python MCP server from a self-contained, uv-managed venv.
 *
 * WHY: the research MCP servers (semantic-scholar, arxiv) are Python packages, and
 * some need Python >= 3.11 while a machine may only ship 3.10 (our harness minimum).
 * We solve BOTH problems here, depending only on things that are always present:
 *   - Node runs this script (Claude Code + our evor server run on Node).
 *   - `uv` gives us a per-server venv AND downloads the right Python (3.11) into it,
 *     so the machine's system Python version is irrelevant. If `uv` is missing we
 *     bootstrap it (pip, then the official installer). No reliance on the MCP
 *     spawner's PATH (which often lacks ~/.local/bin → the "uvx ENOENT" failure).
 *
 * Usage (.mcp.json):
 *   { "command": "node",
 *     "args": ["${CLAUDE_PLUGIN_ROOT}/mcp/bin/py-mcp.cjs", "<pip-package>"] }
 *   (console-script name is auto-discovered; an optional 3rd arg pins it.)
 *
 * First launch builds the venv (downloads uv + Python 3.11 + deps) — slow, may
 * exceed Claude Code's connect timeout ONCE; it's cached, so the next reload is
 * instant. Pre-warm with `./install.sh` or /oh-my-evor:evor-mcp-setup. Env knobs:
 *   EVOR_MCP_PYTHON (default "3.11"), EVOR_MCP_NO_AUTOBUILD=1, `--prebuild` flag.
 */
"use strict";
const { existsSync, mkdirSync, writeFileSync, readFileSync, rmdirSync } = require("fs");
const { join } = require("path");
const { spawnSync, spawn } = require("child_process");
const os = require("os");

const isWin = process.platform === "win32";
const HOME = os.homedir();
const PY_VER = process.env.EVOR_MCP_PYTHON || "3.11";

const pkg = process.argv[2];
const pinnedScript = process.argv[3] && process.argv[3] !== "--prebuild" ? process.argv[3] : null;
if (!pkg) { process.stderr.write("[oh-my-evor:py-mcp] missing package argument\n"); process.exit(2); }

const log = (m) => process.stderr.write(`[oh-my-evor:py-mcp] ${m}\n`); // stdout is the MCP channel

// Cache venvs in a STABLE, home-based location — NOT under the plugin dir. The plugin's
// install path (CLAUDE_PLUGIN_ROOT) varies with scope (project vs user) and may be
// read-only, so pre-warm and runtime could resolve to different dirs and never share the
// built venv. A home cache is identical no matter how/where the launcher is invoked.
function cacheBase() {
  if (process.env.EVOR_MCP_VENV_DIR) return process.env.EVOR_MCP_VENV_DIR;
  const base = process.env.XDG_CACHE_HOME || (isWin ? join(HOME, "AppData", "Local") : join(HOME, ".cache"));
  return join(base, "oh-my-evor", "mcp-venvs");
}
const venvDir = join(cacheBase(), pkg);
const venvPy = isWin ? join(venvDir, "Scripts", "python.exe") : join(venvDir, "bin", "python");
const marker = join(venvDir, ".script");

function run(cmd, args, opts) {
  return spawnSync(cmd, args, { encoding: "utf8", timeout: 900000, ...opts });
}

/** First existing path among PATH lookup + explicit dirs. */
function findExe(names, dirs) {
  for (const n of names) {
    const w = run(isWin ? "where" : "which", [n], { timeout: 8000 });
    if (w.status === 0) { const p = (w.stdout || "").split(/\r?\n/)[0].trim(); if (p && existsSync(p)) return p; }
  }
  for (const d of dirs) for (const n of names) { const p = join(d, n); if (existsSync(p)) return p; }
  return null;
}

function findUv() {
  const names = isWin ? ["uv.exe"] : ["uv"];
  return findExe(names, [join(HOME, ".local", "bin"), join(HOME, ".cargo", "bin"), "/opt/homebrew/bin", "/usr/local/bin", join(__dirname, "..", ".uv")]);
}

function findSystemPython() {
  const names = isWin ? ["python.exe", "python3.exe"] : ["python3", "python"];
  const dirs = [join(HOME, ".local", "bin"), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"];
  const cands = [];
  if (process.env.EVOR_PYTHON) cands.push(process.env.EVOR_PYTHON);
  cands.push(...names, ...dirs.flatMap((d) => names.map((n) => join(d, n))));
  for (const c of cands) { const r = run(c, ["-c", "import sys;sys.exit(0)"], { timeout: 8000 }); if (r.status === 0) return c; }
  return null;
}

/** Ensure a uv binary exists; bootstrap via pip then the official installer. */
function ensureUv() {
  let uv = findUv();
  if (uv) return uv;
  const sysPy = findSystemPython();
  if (sysPy) {
    log("uv not found — bootstrapping via pip (one time) ...");
    run(sysPy, ["-m", "pip", "install", "--user", "--upgrade", "uv"], { stdio: ["ignore", "ignore", "inherit"] });
    uv = findUv();
    if (uv) return uv;
    // user-base bin may differ from ~/.local/bin
    const ub = run(sysPy, ["-c", "import site,os;print(os.path.join(site.getuserbase(),'Scripts' if os.name=='nt' else 'bin'))"], { timeout: 8000 });
    const dir = (ub.stdout || "").trim();
    if (dir) { const p = join(dir, isWin ? "uv.exe" : "uv"); if (existsSync(p)) return p; }
  }
  // last resort: official installer
  log("bootstrapping uv via official installer ...");
  if (isWin) run("powershell", ["-ExecutionPolicy", "ByPass", "-c", "irm https://astral.sh/uv/install.ps1 | iex"], { stdio: ["ignore", "ignore", "inherit"] });
  else run("sh", ["-c", "curl -LsSf https://astral.sh/uv/install.sh | sh"], { stdio: ["ignore", "ignore", "inherit"] });
  return findUv();
}

/** Best console-script name for the installed package. */
function discoverScript() {
  const r = run(venvPy, ["-c",
    "import importlib.metadata as m\n" +
    `eps=[e for e in m.distribution('${pkg}').entry_points if e.group=='console_scripts']\n` +
    "names=[e.name for e in eps]\n" +
    "pref=[n for n in names if any(k in n.lower() for k in ('mcp','serve','server'))] or names\n" +
    "print(pref[0] if pref else '')"], { timeout: 15000 });
  return (r.stdout || "").trim() || null;
}

function scriptPathFor(name) {
  return isWin ? join(venvDir, "Scripts", `${name}.exe`) : join(venvDir, "bin", name);
}

function build() {
  const uv = ensureUv();
  if (!uv) { log("could not find or bootstrap uv. Install it: https://docs.astral.sh/uv/getting-started/installation/"); return null; }
  log(`building venv for ${pkg} (Python ${PY_VER} + deps — first run downloads; this is slow once, then cached) ...`);
  mkdirSync(join(venvDir, ".."), { recursive: true });
  let r = run(uv, ["venv", "--python", PY_VER, venvDir], { stdio: ["ignore", "ignore", "inherit"] });
  if (r.status !== 0) { log("uv venv failed"); return null; }
  r = run(uv, ["pip", "install", "--python", venvPy, pkg], { stdio: ["ignore", "ignore", "inherit"] });
  if (r.status !== 0) { log(`uv pip install ${pkg} failed`); return null; }
  const name = pinnedScript || discoverScript();
  if (!name) { log(`no console script found for ${pkg}`); return null; }
  try { writeFileSync(marker, name); } catch {}
  return scriptPathFor(name);
}

// ── resolve the server script (build once, under a lock) ─────────────────────
let scriptPath = null;
if (existsSync(venvPy) && (pinnedScript || existsSync(marker))) {
  scriptPath = scriptPathFor(pinnedScript || readFileSync(marker, "utf8").trim());
}
if (!scriptPath || !existsSync(scriptPath)) {
  if (process.env.EVOR_MCP_NO_AUTOBUILD) { log(`venv not built (EVOR_MCP_NO_AUTOBUILD). Run ./install.sh or /oh-my-evor:evor-mcp-setup.`); process.exit(1); }
  mkdirSync(join(venvDir, ".."), { recursive: true });
  const lock = `${venvDir}.building`;
  let haveLock = false;
  try { mkdirSync(lock); haveLock = true; } catch (e) {
    if (e && e.code === "EEXIST") {
      const deadline = Date.now() + 890000;
      while (!existsSync(marker) && existsSync(lock) && Date.now() < deadline) run(process.execPath, ["-e", "setTimeout(()=>{},1500)"], { timeout: 4000 });
      if (existsSync(marker)) scriptPath = scriptPathFor(readFileSync(marker, "utf8").trim());
    } else { throw e; }
  }
  if (!scriptPath || !existsSync(scriptPath)) {
    scriptPath = build();
    if (haveLock) { try { rmdirSync(lock); } catch {} }
    if (!scriptPath || !existsSync(scriptPath)) { log("build did not produce the server script"); process.exit(1); }
  } else if (haveLock) { try { rmdirSync(lock); } catch {} }
}

if (process.env.EVOR_MCP_PREBUILD || process.argv.includes("--prebuild")) { log(`prebuilt ${pkg}`); process.exit(0); }

// Exec the server, wiring stdio straight through (this IS the MCP stdio transport).
const child = spawn(scriptPath, process.argv.slice(4).filter((a) => a !== "--prebuild"), { stdio: "inherit" });
child.on("error", (e) => { log(`failed to launch server: ${e.message}`); process.exit(1); });
child.on("exit", (code, sig) => process.exit(sig ? 1 : code ?? 0));
