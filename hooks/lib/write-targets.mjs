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
  while ((m = quoted.exec(text))) out.push(m[2]);
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
  const units = [
    ...segments(command, cwd, vars),
    ...heredocs(command, cwd, vars),
    // The whole command as one unit. Segment splitting is naive about quoting — a
    // `;` inside a `python3 -c "…"` string looks exactly like a statement
    // separator — which scattered the write call into one segment and its target
    // into another. Reading the command whole means "this writes, and it names a
    // protected path" is caught even when the two are not adjacent. It cannot add
    // a false positive on a command that writes nothing, because a unit with no
    // write intent contributes no targets at all.
    { text: command, cwd },
  ];

  let writes = false;
  for (const unit of units) {
    const text = foldConcat(expandVars(unit.text, vars));
    if (!hasWriteIntent(text)) continue;
    writes = true;
    for (const raw of pathTokens(text)) {
      const t = raw.trim();
      if (!t || t === '-' || /^[a-z]+:\/\//i.test(t)) continue;
      targets.add(isAbsolute(t) ? t : resolve(unit.cwd, t));
    }
  }

  return { targets: [...targets], writes };
}
