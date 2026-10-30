/**
 * Reading the session transcript from a hook: who started the current turn, and
 * which slash command ran last. Both fail closed (false / ''), so an unreadable
 * transcript leaves the governor's stricter default in force.
 */
import { existsSync as _exists, readFileSync } from 'fs';

/**
 * Was the CURRENT turn started by something a person typed? The latest user record
 * that is not a tool result decides: a plain prompt counts; a task notification, a
 * system reminder or a hook-injected message does not.
 */
export function turnStartedByHuman(transcriptPath) {
  try {
    if (!transcriptPath.endsWith('.jsonl') || !_exists(transcriptPath)) return false;
    const lines = readFileSync(transcriptPath, 'utf8').slice(-400_000).split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      let rec;
      try { rec = JSON.parse(lines[i]); } catch { continue; }
      if (rec?.type !== 'user' || rec?.isMeta) continue;
      const c = rec?.message?.content;
      const text = typeof c === 'string' ? c
        : Array.isArray(c) ? c.filter((x) => x?.type === 'text').map((x) => x.text).join('') : '';
      if (Array.isArray(c) && c.some((x) => x?.type === 'tool_result') && !text) continue;
      const t = text.trim();
      if (!t) continue;
      return !/^<(task-notification|system-reminder|local-command|command-)/.test(t) && !/^\[SYSTEM NOTIFICATION/.test(t);
    }
    return false;
  } catch (err) {
    
    return false;
  }
}

/** The latest `/plugin:command` the user ran in this session, without the plugin prefix, or ''. */
export function lastSlashCommand(transcriptPath) {
  try {
    if (!transcriptPath.endsWith('.jsonl') || !_exists(transcriptPath)) return '';
    const text = readFileSync(transcriptPath, 'utf8');
    const tail = text.slice(-400_000);
    const all = [...tail.matchAll(/<command-name>\/?(?:[\w-]+:)?([\w-]+)<\/command-name>/g)];
    return all.length ? all[all.length - 1][1] : '';
  } catch (err) {
    
    return '';
  }
}
