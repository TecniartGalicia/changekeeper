import { execFile } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs/promises';
import * as fsSync from 'fs';
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
 * dialog, a byte-exact backup (capped, in globalStorage) and a doctor. Never edits anything else in
 * the file; never installs command hooks (nothing of ours ever runs inside the agent, decides
 * permissions or adds context). Symlinked settings files are written through (the link is kept)
 * and the previous file mode is preserved.
 */
export type HookTarget = 'user' | 'project';

const MAX_BACKUPS = 10;

export function claudeUserSettingsPath(): string {
  const dir = process.env.CLAUDE_CONFIG_DIR && process.env.CLAUDE_CONFIG_DIR.trim() ? process.env.CLAUDE_CONFIG_DIR.trim() : path.join(os.homedir(), '.claude');
  return path.join(dir, 'settings.json');
}

export function claudeProjectSettingsPath(folder: string): string {
  return path.join(folder, '.claude', 'settings.local.json');
}

/**
 * Fully resolved path — 8.3 short names on Windows included (`C:\Users\RUNNER~1` → `…\runneradmin`).
 * Works for paths that do not exist yet: it resolves the closest existing ancestor and re-joins the
 * rest, so a file we are about to create can still be compared against its workspace folder.
 */
function resolveDeep(p: string): string {
  const rest: string[] = [];
  let cur = path.resolve(p);
  for (;;) {
    try {
      return rest.length ? path.join(fsSync.realpathSync.native(cur), ...[...rest].reverse()) : fsSync.realpathSync.native(cur);
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return path.resolve(p);
      rest.push(path.basename(cur));
      cur = parent;
    }
  }
}

/** Is `child` inside `root`? Case-insensitive where the filesystem is. */
function isInside(root: string, child: string): boolean {
  const rel = path.relative(root, child);
  if (!rel) return true;
  const norm = process.platform === 'win32' || process.platform === 'darwin' ? path.relative(root.toLowerCase(), child.toLowerCase()) : rel;
  return !norm.startsWith('..') && !path.isAbsolute(norm);
}

function git(args: string[], cwd: string): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, windowsHide: true, timeout: 10_000 }, (err: any, stdout) => {
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : 128) : 0, out: String(stdout ?? '') });
    });
  });
}

export class HookInstaller {
  constructor(private readonly server: HookServer, private readonly storageRoot: string) {}

  get backupsDir(): string {
    return path.join(this.storageRoot, 'hooks', 'backups');
  }

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

  /** Byte-exact copy in globalStorage (name = time + short hash of the path + basename); only the last MAX_BACKUPS are kept. */
  private async backup(file: string, raw: string | undefined): Promise<string | undefined> {
    if (raw === undefined) return undefined;
    const dir = this.backupsDir;
    const hash = crypto.createHash('sha1').update(file.toLowerCase()).digest('hex').slice(0, 8);
    const name = `${new Date().toISOString().replace(/[:.]/g, '-')}-${hash}-${path.basename(file)}`;
    const dest = path.join(dir, name);
    await atomicWrite(dest, raw, { mode: 0o600 });
    try {
      const all = (await fs.readdir(dir)).filter((n) => !n.startsWith('.')).sort();
      for (const old of all.slice(0, Math.max(0, all.length - MAX_BACKUPS))) await fs.rm(path.join(dir, old), { force: true }).catch(() => undefined);
    } catch {
      /* best effort */
    }
    return dest;
  }

  /** How many backups exist (for Purge / docs). */
  async backupCount(): Promise<number> {
    try {
      return (await fs.readdir(this.backupsDir)).filter((n) => !n.startsWith('.')).length;
    } catch {
      return 0;
    }
  }

  async purgeBackups(): Promise<void> {
    await fs.rm(this.backupsDir, { recursive: true, force: true }).catch(() => undefined);
  }

  /**
   * Writes through symlinks (the user's `~/.claude` is often a symlinked dotfile) and keeps the
   * previous mode. For a PROJECT file the path is controlled by the repository, so a symlink there
   * would let a cloned repo redirect our write — and put the token inside a tracked file. In that
   * case the write is refused (audit P2).
   */
  private async writeSettings(file: string, data: string, insideFolder?: string): Promise<void> {
    let target = file;
    let mode: number | undefined;
    target = resolveDeep(file);
    mode = await fs
      .stat(target)
      .then((st) => st.mode & 0o777)
      .catch(() => undefined);
    if (insideFolder) {
      const root = resolveDeep(insideFolder);
      if (!isInside(root, target)) throw new Error(`refusing to write ${target}: it resolves outside ${root} (symlinked .claude?)`);
    }
    await atomicWrite(target, data, mode !== undefined ? { mode } : { mode: 0o600 });
  }

  /** The real path our project-level write would land on (used for the consent dialog and for git-exclude). */
  private async realProjectPath(folder: string): Promise<string> {
    const file = claudeProjectSettingsPath(folder);
    return resolveDeep(file);
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
    const preview = JSON.stringify(next.hooks, null, 2).replace(token, '<token>').slice(0, 1200);
    const ok = l10n.t('Write hooks');
    const scope = target === 'user' ? l10n.t('These hooks fire in EVERY Claude Code session on this machine; when no VS Code window with ChangeKeeper is open, Claude shows a non-blocking "hook error" line — choose "this project only" if that bothers you.') : l10n.t('These hooks fire only for Claude Code sessions in this project; when no VS Code window with ChangeKeeper is open, Claude shows a non-blocking "hook error" line.');
    const pick = await vscode.window.showWarningMessage(
      l10n.t('ChangeKeeper will add HTTP hooks to {0} so Claude Code tells it when a session starts and which files its tools edit. The hooks only POST to 127.0.0.1:{1} on this machine (with a private token stored in that file), never decide permissions and never add context to the agent. Everything else in the file is preserved and a byte-exact backup is kept; "Revert hooks" removes them.', file, String(port)),
      { modal: true, detail: scope + '\n\n' + l10n.t('Resulting "hooks" section (first lines):') + '\n' + preview },
      ok,
    );
    if (pick !== ok) return undefined;
    return this.apply(target, folder, read, next);
  }

  /** The write itself (no dialog). Public for tests; the command always goes through `install()`. */
  async apply(target: HookTarget, folder: string | undefined, read?: { settings: ClaudeSettings; raw: string | undefined }, next?: ClaudeSettings): Promise<string | undefined> {
    const file = target === 'user' ? claudeUserSettingsPath() : claudeProjectSettingsPath(folder!);
    if (!read) {
      const r = await this.readSettings(file);
      if ('error' in r) return undefined;
      read = r;
    }
    if (!next) next = addChangeKeeperHooks(read.settings, this.server.currentPort, await this.server.token()).next;
    try {
      const backup = await this.backup(file, read.raw);
      await this.writeSettings(file, serialiseSettings(next), target === 'project' ? folder : undefined);
      log(`hooks installed in ${file}${backup ? ` (backup ${backup})` : ''}`);
      if (target === 'project' && folder) await this.ensureGitExcluded(folder, file);
      return file;
    } catch (e) {
      void vscode.window.showErrorMessage(l10n.t('ChangeKeeper: could not write {0}: {1}', file, e instanceof Error ? e.message : String(e)));
      return undefined;
    }
  }

  /**
   * `.claude/settings.local.json` is only gitignored when Claude Code itself creates it; when we
   * create it (it holds the token) make sure git ignores it via `.git/info/exclude` (never touches
   * the project's .gitignore). Returns what was done, for the notification and the tests.
   */
  async ensureGitExcluded(folder: string, file: string): Promise<'ignored' | 'excluded' | 'not-git' | 'failed'> {
    // exclude the path git will actually see (the real one, if `.claude` is a link)
    file = await this.realProjectPath(folder);
    const check = await git(['check-ignore', '-q', '--', file], folder);
    if (check.code === 0) return 'ignored';
    if (check.code !== 1) return 'not-git';
    const p = await git(['rev-parse', '--git-path', 'info/exclude'], folder);
    if (p.code !== 0) return 'not-git';
    const excludeFile = path.resolve(folder, p.out.trim());
    const rel = path.relative(folder, file).replace(/\\/g, '/');
    const line = '/' + rel;
    try {
      const cur = await fs.readFile(excludeFile, 'utf8').catch(() => '');
      if (cur.split(/\r?\n/).some((l) => l.trim() === line || l.trim() === rel)) return 'excluded';
      await fs.mkdir(path.dirname(excludeFile), { recursive: true });
      await fs.appendFile(excludeFile, `${cur.length && !cur.endsWith('\n') ? '\n' : ''}# ChangeKeeper: local Claude Code hooks (holds a private token)\n${line}\n`);
      log(`added ${line} to ${excludeFile}`);
      return 'excluded';
    } catch (e) {
      log(`could not update ${excludeFile}: ${String(e)}`);
      return 'failed';
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
      await this.writeSettings(file, serialiseSettings(next), target === 'project' ? folder : undefined);
      log(`hooks removed from ${file}`);
      return true;
    } catch (e) {
      void vscode.window.showErrorMessage(l10n.t('ChangeKeeper: could not write {0}: {1}', file, e instanceof Error ? e.message : String(e)));
      return false;
    }
  }

  /**
   * Whether any of the given files holds hooks of OURS — decides whether the receiver must run.
   * Project files come from the repository, so a clone could otherwise make a user who never
   * installed anything open a local port: for those, the token must match ours (audit P3).
   */
  async anyInstalled(folders: string[]): Promise<boolean> {
    const user = await this.readSettings(claudeUserSettingsPath());
    if (!('error' in user) && installedHooks(user.settings).length) return true;
    const token = await this.server.peekToken();
    if (!token) return false;
    for (const f of folders.map((x) => claudeProjectSettingsPath(x))) {
      const read = await this.readSettings(f);
      if (!('error' in read) && installedHooks(read.settings).some((h) => h.token === token)) return true;
    }
    return false;
  }

  /** Human-readable status for the doctor. */
  async report(folders: string[], liveOwnerElsewhere?: boolean): Promise<string> {
    const lines: string[] = [];
    const st = this.server.status;
    if (!st.started) lines.push(l10n.t('Receiver: not running (it starts when hooks are installed or autoStart is "whenAgentDetected").'));
    else if (st.owner) lines.push(l10n.t('Receiver: this window owns 127.0.0.1:{0} · events received in this window: {1}{2}', String(st.port), String(st.events), st.lastEventAt ? ` · ${l10n.t('last')} ${new Date(st.lastEventAt).toLocaleTimeString()}` : ''));
    else if (liveOwnerElsewhere) lines.push(l10n.t('Receiver: another VS Code window owns 127.0.0.1:{0} (events reach us through the inbox) · events received in this window: {1}', String(st.port), String(st.events)));
    else lines.push(`⚠ ${l10n.t('Receiver: no ChangeKeeper window owns 127.0.0.1:{0} — another program is using that port. Change "changekeeper.hooks.port" and reinstall the hooks.', String(st.port))}`);
    const token = await this.server.token();
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
      const wrongToken = inst.some((i) => i.token !== token);
      lines.push(`${f}: ${[...new Set(inst.map((i) => i.event))].join(', ')} → ${ports.map((p) => hookUrl(p)).join(', ')}${wrongPort ? ' ⚠ ' + l10n.t('port differs from the current setting — reinstall') : ''}${wrongToken ? ' ⚠ ' + l10n.t('token differs from this machine\'s current token — reinstall') : ''}`);
      const allow = read.settings.allowedHttpHookUrls;
      if (Array.isArray(allow) && !allow.includes(hookUrl(st.port))) lines.push(`  ⚠ ${l10n.t('allowedHttpHookUrls exists but does not include our URL — reinstall')}`);
    }
    lines.push('');
    lines.push(l10n.t('Note: if your organisation manages "allowedHttpHookUrls" (managed settings), our URL must be allowed there or Claude Code drops the hook silently.'));
    const n = await this.backupCount();
    if (n) lines.push(l10n.t('Backups of settings files edited by ChangeKeeper: {0} in {1} (removed by "Purge data").', String(n), this.backupsDir));
    return lines.join('\n');
  }
}
