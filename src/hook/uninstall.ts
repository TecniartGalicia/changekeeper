/**
 * `vscode:uninstall` script (run by VS Code's own Node when the extension is uninstalled): removes
 * ChangeKeeper's HTTP hooks from the user's Claude Code settings so nothing keeps posting to a port
 * nobody listens on. Best effort, silent, never touches anything but our own entries; project-level
 * files (.claude/settings.local.json) are not known here — "ChangeKeeper: Revert Hooks" handles them.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { removeChangeKeeperHooks, serialiseSettings } from '../core/hooks/settingsEdit';

function main(): void {
  const dir = process.env.CLAUDE_CONFIG_DIR && process.env.CLAUDE_CONFIG_DIR.trim() ? process.env.CLAUDE_CONFIG_DIR.trim() : path.join(os.homedir(), '.claude');
  const file = path.join(dir, 'settings.json');
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return;
  }
  let settings: any;
  try {
    settings = JSON.parse(raw);
  } catch {
    return; // never rewrite a file we cannot parse
  }
  if (!settings || typeof settings !== 'object') return;
  const { next, changed } = removeChangeKeeperHooks(settings);
  if (!changed) return;
  try {
    // keep the mode of the settings file: the backup holds the same secrets (and PRIVACY says 0600)
    let mode = 0o600;
    try {
      mode = fs.statSync(file).mode & 0o777;
    } catch {
      /* keep the default */
    }
    fs.writeFileSync(file + '.changekeeper-uninstall.bak', raw, { mode });
    fs.writeFileSync(file, serialiseSettings(next), { mode });
  } catch {
    /* ignore */
  }
}

main();
