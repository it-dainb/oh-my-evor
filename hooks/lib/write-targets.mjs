/**
 * hooks/lib/write-targets.mjs — resolve the EFFECTIVE write targets of a tool call.
 *
 * Plan item 0.2. Every realized harm in the measured run came through a path the
 * guards never looked at: they matched on role and on command TEXT, so a decision
 * depended on how a command was spelled. Lane K measured both halves of that
 * defect — agents that wanted through got through (`E=py`, string concatenation,
 * a bare `cd`), and 54 of 82 training denials, 66%, were false positives on
 * commands that wrote nothing at all. An agent denied on `Edit` spent two minutes
 * probing the matcher, wrote *"the governor blocks any bash containing `.py`.
 * Splitting the path literal."*, and landed three patches on the sealed evaluator.
 * The guard did not prevent the change; it removed the trail.
 *
 * So this module answers one question — *what does this command actually write?*
 * — and the caller decides on the resolved absolute path. That makes the fix
 * structural rather than lexical, and it REDUCES false positives: a command with
 * no write indicator resolves to no targets and is never a candidate for denial,
 * however many trigger tokens it happens to mention.
 *
 * Deliberate limits. This is a heuristic over shell text, not a shell. It aims to
 * be sound about the shapes actually observed (redirects, `tee`, `cp`/`mv`/`ln`,
 * `sed -i`, heredoc bodies, python write-mode opens) and to resolve them through
 * `cd` and simple variable assignment. It does not evaluate arbitrary code, and a
 * determined author can still construct a target it cannot see. That is accepted:
 * the goal is to stop deciding on spelling, not to claim completeness. Where it
 * cannot resolve, it reports nothing and the caller falls back to its other rules.
 */

import { isAbsolute, resolve } from 'path';

/** Commands whose presence means the line intends to modify something. */
const WRITE_VERBS = /\b(cp|mv|ln|install|dd|truncate|shred|rsync|touch|mkdir|rm|chmod|chown)\b/;

/** Python-level write shapes, including the ones used to evade a text matcher. */
const PY_WRITE_CALL =
  /\b(?:open|io\.FileIO|io\.open|codecs\.open)\s*\(([^)]*)\)|\.write_text\s*\(|\.write_bytes\s*\(|\bshutil\.(?:copy|copy2|copyfile|copytree|move)\s*\(([^)]*)\)|\bjson\.dump\s*\(/;

/**
 * Fold shell variable assignments so `$D/freeze.$E` resolves.
 * Only literal assignments are tracked — anything computed is left alone, which
 * means the token stays unresolved and contributes no target rather than a wrong one.
 */
function shellVars(command) {
  const vars = new Map();
  const re = /(?:^|[;&|\n]|\bthen\b|\bdo\b)\s*([A-Za-z_][A-Za-z0-9_]*)=("([^"]*)"|'([^']*)'|([^\s;&|]*))/g;
  let m;
  while ((m = re.exec(command))) {
    const raw = m[3] ?? m[4] ?? m[5] ?? '';
    // Guard against reading python out of a `-c` string as shell assignments:
    // `f=io.FileIO(...)` has the shape but none of the meaning.
    if (raw.includes('(')) continue;
    vars.set(m[1], raw);
  }
  return vars;
}

function expandVars(token, vars) {
  let out = token;
  for (let i = 0; i < 3; i++) {
    const next = out.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (whole, a, b) => {
      const name = a ?? b;
      return vars.has(name) ? vars.get(name) : whole;
    });
    if (next === out) break;
    out = next;
  }
  return out;
}

/**
 * Fold adjacent string literals joined by `+`, so a path split to defeat a
 * substring matcher reassembles before the decision is made. This is the exact
 * evasion the field run used: `"freeze" + "." + "p" + "y"`.
 */
function foldConcat(text) {
  let out = text;
  for (let i = 0; i < 12; i++) {
    const next = out.replace(/(['"])((?:\\.|(?!\1)[^\\])*)\1\s*\+\s*(['"])((?:\\.|(?!\3)[^\\])*)\3/g,
      (_w, q, a, _q2, b) => `${q}${a}${b}${q}`);
    if (next === out) break;
    out = next;
  }
  return out;
}

/** Every quoted or bare token in `text` that looks like a filesystem path. */
function pathTokens(text) {
  const out = [];
  const quoted = /(['"])((?:\\.|(?!\1)[^\\])*)\1/g;
  let m;
  while ((m = quoted.exec(text))) {
    // A quoted heredoc delimiter (`<<'EOF'`) is not a path; reading it as one
    // made a critic's check script "write" <worktree>/EOF.
    if (/<<-?\s*$/.test(text.slice(0, m.index))) continue;
    out.push(m[2]);
  }
  for (const t of text.split(/[\s;|&()<>]+/)) {
    if (/[/]/.test(t) && !/^-/.test(t)) out.push(t.replace(/^['"]|['"]$/g, ''));
  }
  return out;
}

/**
 * Split a command into segments that share a working directory, tracking `cd`.
 *
 * K-04b: `cd .evor/runs && python3 - <<'EOF' … open("mission-state.json","w") …`
 * was allowed because the guard required the literal `.evor` inside the `open()`
 * call and the `cd` had made every path relative. It rewrote two missions'
 * state 14 hours after the fact. The cwd is state; a matcher over text has none.
 */
function segments(command, cwd, vars) {
  const parts = command.split(/\s*(?:&&|\|\||;|\n)\s*/);
  const out = [];
  let dir = cwd;
  for (const part of parts) {
    const cd = part.match(/^\s*cd\s+(?:-[^\s]+\s+)*("([^"]*)"|'([^']*)'|([^\s;&|]+))/);
    if (cd) {
      const target = expandVars(cd[2] ?? cd[3] ?? cd[4] ?? '', vars);
      if (target && target !== '-') dir = isAbsolute(target) ? target : resolve(dir, target);
      continue;
    }
    out.push({ text: part, cwd: dir });
  }
  // A heredoc body is split across segments by the loop above; re-attach it to the
  // directory in force where the heredoc opened, which is what the body executes in.
  return out.length ? out : [{ text: command, cwd: dir }];
}

/** Extract heredoc bodies with the cwd in force where each one opened. */
function heredocs(command, cwd, vars) {
  const out = [];
  const re = /<<-?\s*['"]?([A-Za-z_][A-Za-z0-9_]*)['"]?\n([\s\S]*?)\n\s*\1\b/g;
  let m;
  while ((m = re.exec(command))) {
    const before = command.slice(0, m.index);
    const segs = segments(before, cwd, vars);
    out.push({ text: m[2], cwd: segs.length ? segs[segs.length - 1].cwd : cwd });
  }
  return out;
}

/**
 * Does this text intend to write? Returns false for the whole benign class —
 * env probes, syntax checks, test runs, read-only JSON inspection, `grep` whose
 * PATTERN merely mentions a trigger token, `stat` on a `.py` file.
 */
function hasPythonWriteIntent(text) {
  const py = text.match(PY_WRITE_CALL);
  if (!py) return false;
  const args = py[1] ?? py[2] ?? '';
  if (/\.write_text|\.write_bytes|json\.dump|shutil\./.test(py[0])) return true;
  return /,\s*['"][^'"]*[wax][^'"]*['"]/.test(args);
}

function hasWriteIntent(text) {
  if (/(^|[^0-9<>&])>>?\s*[^\s|&;>]/.test(text.replace(/2>&1|&>|>&\d/g, ''))) return true;
  if (/\btee\b/.test(text)) return true;
  if (/\bsed\b[^|;]*\s-[a-zA-Z]*i\b/.test(text)) return true;
  if (WRITE_VERBS.test(text)) return true;
  const py = text.match(PY_WRITE_CALL);
  if (py) {
    // `open(path)` with no mode, or an explicit read mode, is not a write.
    const args = py[1] ?? py[2] ?? '';
    if (/\.write_text|\.write_bytes|json\.dump|shutil\./.test(py[0])) return true;
    if (/['"][rb]{1,2}['"]/.test(args) && !/['"][^'"]*[wax+][^'"]*['"]\s*\)?\s*$/.test(args)) {
      return /,\s*['"][^'"]*[wax][^'"]*['"]/.test(args);
    }
    return /,\s*['"][^'"]*[wax][^'"]*['"]/.test(args);
  }
  return false;
}

/** Read-only source operands of cp / ln / install / rsync segments, and their destinations. */
function copySources(segs, vars, baseCwd) {
  const sources = new Set();
  const written = new Set();
  for (const { text, cwd } of segs) {
    const t = foldConcat(expandVars(text, vars)).trim();
    const m = t.match(/^(cp|ln|install|rsync)\s+(.*)$/);
    if (!m) continue;
    // Anything shell-ish beyond plain operands (redirects, pipes, substitutions)
    // is left to the general rules.
    if (/[<>|`$(]/.test(m[2])) continue;
    const args = m[2].split(/\s+/).filter(Boolean);
    let dest = null;
    const operands = [];
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === '-t' || a === '--target-directory') { dest = args[++i] ?? null; continue; }
      if (a.startsWith('--target-directory=')) { dest = a.slice('--target-directory='.length); continue; }
      if (a.startsWith('-')) continue;
      operands.push(a.replace(/^['"]|['"]$/g, ''));
    }
    if (dest === null) dest = operands.pop() ?? null;
    if (!dest || !operands.length) continue;
    const abs = (p, dir) => (isAbsolute(p) ? p : resolve(dir, p));
    // The whole-command pass resolves relative paths against the STARTING cwd,
    // not the segment's, so drop the source under both resolutions.
    for (const dir of [cwd, baseCwd]) {
      written.add(abs(dest, dir));
      for (const o of operands) sources.add(abs(o, dir));
    }
  }
  return { sources, written };
}

/**
 * Resolve the effective write targets of a tool call to absolute paths.
 *
 * @param {object} p
 * @param {string} p.tool      tool_name
 * @param {object} p.toolInput tool_input
 * @param {string} p.cwd       directory the call starts in
 * @returns {{ targets: string[], writes: boolean }}
 *   `targets` are absolute; `writes` is whether any write intent was detected.
 */
export function resolveWriteTargets({ tool, toolInput = {}, cwd = process.cwd() }) {
  const targets = new Set();

  if (tool === 'Write' || tool === 'Edit' || tool === 'NotebookEdit') {
    const p = String(toolInput.file_path ?? toolInput.notebook_path ?? '');
    if (p) targets.add(isAbsolute(p) ? p : resolve(cwd, p));
    return { targets: [...targets], writes: targets.size > 0 };
  }

  if (tool !== 'Bash') return { targets: [], writes: false };

  const command = String(toolInput.command ?? '');
  if (!command) return { targets: [], writes: false };

  const vars = shellVars(command);
  // Heredoc BODIES are data for an interpreter, not shell: `len(x)>200` in a
  // python body is a comparison, not a redirect. Reading it as shell made an
  // architect's read-only JSON comparison "write" a node's results.json
  // (binarization mission, tick 4). Bodies are judged by the Python write
  // shapes only, and removed from the text the shell rules read.
  const bodies = heredocs(command, cwd, vars);
  let shellText = command.replace(/(<<-?\s*['"]?([A-Za-z_][A-Za-z0-9_]*)['"]?)\n[\s\S]*?\n\s*\2\b/g, '$1');
  // `python -c "<code>"` is interpreter input too: `'first->last %'` in it read
  // as a `>` redirect, and its string literals as paths (Probe, tick 4). Only
  // python's code argument is lifted out; `bash -c "…"` stays shell.
  shellText = shellText.replace(/(\bpython[0-9.]*(?:\s+-[A-Za-z]+)*\s+-c\s+)(["'])((?:\\.|(?!\2)[^\\])*)\2/g, (_w, pre, _q, code) => {
    bodies.push({ text: code, cwd });
    return `${pre}''`;
  });
  const units = [
    ...segments(shellText, cwd, vars),
    ...bodies.map((b) => ({ ...b, pythonOnly: true })),
    // The whole command as one unit. Segment splitting is naive about quoting — a
    // `;` inside a `python3 -c "…"` string looks exactly like a statement
    // separator — which scattered the write call into one segment and its target
    // into another. Reading the command whole means "this writes, and it names a
    // protected path" is caught even when the two are not adjacent. It cannot add
    // a false positive on a command that writes nothing, because a unit with no
    // write intent contributes no targets at all.
    { text: shellText, cwd },
    // Lifted python code that WRITES may write a path passed outside it
    // (`python3 -c "…FileIO(sys.argv[1],'w')…" "$D/freeze.py"`). Then the
    // original command is judged whole, as it was before the lift. A lift can
    // only remove false positives from code that does not write.
    ...(bodies.some((b) => hasPythonWriteIntent(foldConcat(expandVars(b.text, vars))))
      ? [{ text: command, cwd }]
      : []),
  ];

  let writes = false;
  for (const unit of units) {
    const text = foldConcat(expandVars(unit.text, vars));
    if (!(unit.pythonOnly ? hasPythonWriteIntent(text) : hasWriteIntent(text))) continue;
    writes = true;
    for (const raw of pathTokens(text)) {
      const t = raw.trim();
      if (!t || t === '-' || /^[a-z]+:\/\//i.test(t)) continue;
      targets.add(isAbsolute(t) ? t : resolve(unit.cwd, t));
    }
  }

  // A copy READS its sources. Counting them as targets made Forge's documented
  // worktree setup (`cp -r $P/data $P/model $N/`) "write" the PARENT node's code
  // and the sealed evaluator it copied from (binarization mission, tick 4).
  // Only sources that are not also written elsewhere in the command are dropped;
  // `mv` is excluded because it removes its source.
  const { sources, written } = copySources(segments(shellText, cwd, vars), vars, cwd);
  for (const src of sources) if (!written.has(src)) targets.delete(src);

  return { targets: [...targets], writes };
}
