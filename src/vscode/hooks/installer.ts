import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { l10n } from 'vscode';
import { addChangeKeeperHooks, ClaudeSettings, hookUrl, installedHooks, removeChangeKeeperHooks, serialiseSettings } from '../../core/hooks/settingsEdit';
import { atomicWrite } from '../../core/store';
import { log } from '../env';
import { HookServer } from './server';

/**
 * Installs / removes ChangeKeeper's HTTP hooks in Claude Code's settings, with an explicit consent
 * dialog, a byte-exact backup and a doctor. Never edits anything else in the file; never installs
 * command hooks (nothing of ours ever runs inside the agent, decides permissions or adds context).
 */
export type HookTarget = 'user' | 'project';

export function claudeUserSettingsPath(): string {
  const dir = process.env.CLAUDE_CONFIG_DIR && process.env.CLAUDE_CONFIG_DIR.trim() ? process.env.CLAUDE_CONFIG_DIR.trim() : path.join(os.homedir(), '.claude');
  return path.join(dir, 'settings.json');
}

export function claudeProjectSettingsPath(folder: string): string {
  return path.join(folder, '.claude', 'settings.local.json');
}

export class HookInstaller {
  constructor(private readonly server: HookServer, private readonly storageRoot: string) {}

  private async readSettings(file: string): Promise<{ settings: ClaudeSettings; raw: string | undefined } | { error: string }> {
    let raw: string | undefined;
    try {
      raw = await fs.readFile(file, 'utf8');
    } catch (e: any) {
      if (e && e.code === 'ENOENT') return { settings: {}, raw: undefined };
      return { error: String(e) };
    }
    try {
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { error: 'not an object' };
      return { settings: parsed, raw };
    } catch (e) {
      return { error: `invalid JSON: ${e instanceof Error ? e.message : String(e)}` };
    }
  }

  private async backup(file: string, raw: string | undefined): Promise<string | undefined> {
    if (raw === undefined) return undefined;
    const dir = path.join(this.storageRoot, 'hooks', 'backups');
    const name = `${new Date().toISOString().replace(/[:.]/g, '-')}-${path.basename(path.dirname(file))}-${path.basename(file)}`;
    const dest = path.join(dir, name);
    await atomicWrite(dest, raw);
    return dest;
  }

  /** Consent → backup → write. Returns the file written, or undefined when cancelled/failed. */
  async install(target: HookTarget, folder?: string): Promise<string | undefined> {
    const file = target === 'user' ? claudeUserSettingsPath() : claudeProjectSettingsPath(folder!);
    const read = await this.readSettings(file);
    if ('error' in read) {
      void vscode.window.showErrorMessage(l10n.t('ChangeKeeper: cannot read {0} ({1}). Fix the file first; nothing was written.', file, read.error));
      return undefined;
    }
    const port = this.server.currentPort;
    const token = await this.server.token();
    const { next, changed } = addChangeKeeperHooks(read.settings, port, token);
    if (!changed) return file;
    const preview = JSON.stringify(next.hooks, null, 2).slice(0, 1500);
    const ok = l10n.t('Write hooks');
    const pick = await vscode.window.showWarningMessage(
      l10n.t('ChangeKeeper will add HTTP hooks to {0} so Claude Code (and agents that read the same file) tell it when a session starts and which files their tools edit. The hooks only POST to 127.0.0.1:{1} on this machine, never decide permissions and never add context to the agent. Everything else in the file is preserved and a byte-exact backup is kept; "Revert hooks" removes them.', file, String(port)),
      { modal: true, detail: l10n.t('Resulting "hooks" section (first lines):') + '\n' + preview },
      ok,
    );
    if (pick !== ok) return undefined;
    try {
      const backup = await this.backup(file, read.raw);
      await atomicWrite(file, serialiseSettings(next));
      log(`hooks installed in ${file}${backup ? ` (backup ${backup})` : ''}`);
      return file;
    } catch (e) {
      void vscode.window.showErrorMessage(l10n.t('ChangeKeeper: could not write {0}: {1}', file, e instanceof Error ? e.message : String(e)));
      return undefined;
    }
  }

  /** Removes our hooks from a file (free, no consent needed beyond the command itself). */
  async revert(target: HookTarget, folder?: string): Promise<boolean> {
    const file = target === 'user' ? claudeUserSettingsPath() : claudeProjectSettingsPath(folder!);
    const read = await this.readSettings(file);
    if ('error' in read) {
      void vscode.window.showErrorMessage(l10n.t('ChangeKeeper: cannot read {0} ({1}). Fix the file first; nothing was written.', file, read.error));
      return false;
    }
    const { next, changed } = removeChangeKeeperHooks(read.settings);
    if (!changed) return true;
    try {
      await this.backup(file, read.raw);
      await atomicWrite(file, serialiseSettings(next));
      log(`hooks removed from ${file}`);
      return true;
    } catch (e) {
      void vscode.window.showErrorMessage(l10n.t('ChangeKeeper: could not write {0}: {1}', file, e instanceof Error ? e.message : String(e)));
      return false;
    }
  }

  /** Human-readable status for the doctor. */
  async report(folders: string[]): Promise<string> {
    const lines: string[] = [];
    const st = this.server.status;
    lines.push(l10n.t('Receiver: {0} on 127.0.0.1:{1} · events received in this window: {2}{3}', st.owner ? l10n.t('this window owns the port') : l10n.t('another window owns the port (events reach us through the inbox)'), String(st.port), String(st.events), st.lastEventAt ? ` · ${l10n.t('last')} ${new Date(st.lastEventAt).toLocaleTimeString()}` : ''));
    const files = [claudeUserSettingsPath(), ...folders.map((f) => claudeProjectSettingsPath(f))];
    for (const f of files) {
      const read = await this.readSettings(f);
      if ('error' in read) {
        lines.push(`${f}: ${l10n.t('unreadable')} (${read.error})`);
        continue;
      }
      const inst = installedHooks(read.settings);
      if (!inst.length) {
        lines.push(`${f}: ${l10n.t('no ChangeKeeper hooks')}`);
        continue;
      }
      const ports = [...new Set(inst.map((i) => i.port))];
      const wrongPort = ports.some((p) => p !== st.port);
      lines.push(`${f}: ${inst.map((i) => i.event).join(', ')} → ${ports.map((p) => hookUrl(p)).join(', ')}${wrongPort ? ' ⚠ ' + l10n.t('port differs from the current setting — reinstall') : ''}`);
      const allow = read.settings.allowedHttpHookUrls;
      if (Array.isArray(allow) && !allow.includes(hookUrl(st.port))) lines.push(`  ⚠ ${l10n.t('allowedHttpHookUrls exists but does not include our URL — reinstall')}`);
    }
    return lines.join('\n');
  }
}
