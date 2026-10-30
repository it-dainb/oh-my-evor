/**
 * Does a tick have a Forge report? Each candidate's forge family may live under
 * ticks/<t>/forge/<node>/ (a tick forges every selected proposal), or at the
 * legacy single path ticks/<t>/forge/forge-report.json.
 */
import { existsSync, readdirSync } from 'fs';
import { join } from 'path';

export function hasForgeReport(tickDir) {
  const forgeDir = join(tickDir, 'forge');
  if (existsSync(join(forgeDir, 'forge-report.json'))) return true;
  try {
    return readdirSync(forgeDir, { withFileTypes: true })
      .some((e) => e.isDirectory() && existsSync(join(forgeDir, e.name, 'forge-report.json')));
  } catch {
    return false;
  }
}
