import { spawn } from 'child_process';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import { l10n } from 'vscode';
import { workspaceKey } from '../core/paths';
import { approvalFingerprint, detectPresets, normaliseRules, NormalisedRule, packageScriptOf, resolvedScripts, safeCwd } from '../core/rules/validations';
import { redact, scanSecrets } from '../core/rules/secrets';
import { ValidationRun } from '../core/session';
import { log } from './env';
import { FolderGuard } from './folderGuard';
import { GuardManager } from './guardManager';
import { ensurePro, proStatus } from '../pro/licenseService';

/**
 * Pro: run configured validations (lint, tests, build…) through the Task API and record the outcome
 * in the session. Security model (PLAN §4.5): trusted workspace only; every distinct command (plus the
 * package.json script it resolves to) is confirmed once per workspace; nothing auto-runs while
 * critical files have unreviewed changes.
 */
const APPROVED_KEY = 'changekeeper.approvedValidations';

export class ValidationRunner implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private lastAutoRunKey = new Map<string, string>(); // folder → session id + pending signature already auto-run

  constructor(private readonly context: vscode.ExtensionContext, private readonly manager: GuardManager) {
    this.disposables.push(manager.onDidChange(() => void this.maybeAutoRun()));
  }

  // ---- configuration ------------------------------------------------------------------------

  rulesFor(guard: FolderGuard): NormalisedRule[] {
    const cfg = vscode.workspace.getConfiguration('changekeeper', guard.folder.uri);
    return normaliseRules(cfg.get('validations', []));
  }

  /** The package.json scripts the command will run (script + pre/post hooks), or undefined for plain commands. */
  private async resolvedScript(guard: FolderGuard, rule: NormalisedRule): Promise<string | undefined> {
    const script = packageScriptOf(rule.command);
    if (!script) return undefined;
    const cwd = this.cwdOf(guard, rule);
    if (!cwd) return '<cwd outside the workspace folder>';
    try {
      const pkg = JSON.parse(await fs.readFile(path.join(cwd, 'package.json'), 'utf8'));
      return resolvedScripts(pkg?.scripts, script);
    } catch {
      return `<no package.json>`;
    }
  }

  /** Absolute working directory of a rule, or undefined when `cwd` escapes the folder. */
  private cwdOf(guard: FolderGuard, rule: NormalisedRule): string | undefined {
    const folder = guard.folder.uri.fsPath;
    return safeCwd(folder, rule.cwd, (...p) => path.join(...p), (base, p) => {
      const rel = path.relative(base, p);
      return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
    });
  }

  /** Critical files with unreviewed hunks: automatic triggers must wait for the human. */
  private criticalPending(guard: FolderGuard): boolean {
    return guard.engine.changes().some((ch) => ch.critical && !ch.fileAccepted && (Object.keys(ch.hunks).length === 0 || Object.values(ch.hunks).some((s) => s === 'pending')));
  }

  private approvedList(): string[] {
    return this.context.workspaceState.get<string[]>(APPROVED_KEY) ?? [];
  }

  /** Test hook: pre-approves a rule (what the confirmation dialog would do). */
  async approveRule(guard: FolderGuard, rule: NormalisedRule): Promise<void> {
    await this.approve(approvalFingerprint(rule, await this.resolvedScript(guard, rule), workspaceKey(guard.folder.uri.fsPath)));
  }

  private async approve(fp: string): Promise<void> {
    const cur = this.approvedList();
    if (!cur.includes(fp)) await this.context.workspaceState.update(APPROVED_KEY, [...cur, fp]);
  }

  /** Confirms a rule the first time (or after its command/script changed). Returns false when refused. */
  private async confirm(guard: FolderGuard, rule: NormalisedRule, silent: boolean): Promise<boolean> {
    const script = await this.resolvedScript(guard, rule);
    const fp = approvalFingerprint(rule, script, workspaceKey(guard.folder.uri.fsPath));
    if (this.approvedList().includes(fp)) return true;
    if (silent) return false; // auto-runs never ask; they wait for a manual first run
    const run = l10n.t('Run and remember');
    const once = l10n.t('Run once');
    const details = [l10n.t('Working directory: {0}', this.cwdOf(guard, rule) ?? '?'), l10n.t('Runs: {0}', rule.runOn)];
    if (script !== undefined) details.push(l10n.t('Resolved script: {0}', script));
    const pick = await vscode.window.showWarningMessage(
      l10n.t('ChangeKeeper will run "{0}" in {1}. A validation executes code from this repository — code an agent may have edited (scripts, node_modules, .npmrc…). Review critical files first.', rule.command, guard.folder.name),
      { modal: true, detail: details.join('\n') },
      run,
      once,
    );
    if (pick === run) await this.approve(fp);
    return pick === run || pick === once;
  }

  // ---- execution ----------------------------------------------------------------------------

  async runAll(guardArg?: FolderGuard, trigger: ValidationRun['trigger'] = 'manual'): Promise<void> {
    const guard = guardArg ?? (await this.manager.pickGuard((g) => g.hasSession));
    if (!guard || !guard.hasSession) {
      void vscode.window.showInformationMessage(l10n.t('ChangeKeeper: no running session.'));
      return;
    }
    if (!(await ensurePro(this.context, l10n.t('Validations')))) return;
    if (!vscode.workspace.isTrusted) {
      void vscode.window.showWarningMessage(l10n.t('ChangeKeeper: validations run commands from the repository and are disabled in Restricted Mode. Trust the workspace first.'));
      return;
    }
    const rules = this.rulesFor(guard);
    if (!rules.length) {
      const add = l10n.t('Add a validation…');
      const pick = await vscode.window.showInformationMessage(l10n.t('ChangeKeeper: no validations configured for {0}.', guard.folder.name), add);
      if (pick === add) await this.addPreset(guard);
      return;
    }
    const chosen = trigger === 'manual' ? rules : rules.filter((r) => r.runOn === trigger);
    for (const rule of chosen) await this.runRule(guard, rule, trigger, trigger !== 'manual');
  }

  async runOne(): Promise<void> {
    const guard = await this.manager.pickGuard((g) => g.hasSession);
    if (!guard) return;
    if (!(await ensurePro(this.context, l10n.t('Validations')))) return;
    const rules = this.rulesFor(guard);
    const pick = await vscode.window.showQuickPick(
      rules.map((r) => ({ label: r.name, description: r.command, r })),
      { placeHolder: l10n.t('Which validation?') },
    );
    if (pick) await this.runRule(guard, pick.r, 'manual', false);
  }

  async runRule(guard: FolderGuard, rule: NormalisedRule, trigger: ValidationRun['trigger'], silent: boolean): Promise<void> {
    // single gate for every path (manual, afterReview, onSessionEnd, tests)
    if (!vscode.workspace.isTrusted) {
      if (!silent) void vscode.window.showWarningMessage(l10n.t('ChangeKeeper: validations run commands from the repository and are disabled in Restricted Mode. Trust the workspace first.'));
      return;
    }
    const cwd = this.cwdOf(guard, rule);
    if (!cwd) {
      void vscode.window.showWarningMessage(l10n.t('ChangeKeeper: validation "{0}" ignored — its cwd points outside the workspace folder.', rule.name));
      return;
    }
    if (silent && this.criticalPending(guard)) {
      log(`validation "${rule.name}" (${trigger}) skipped: critical files with unreviewed changes`);
      return;
    }
    if (!(await this.confirm(guard, rule, silent))) {
      if (silent) this.hintFirstManualRun(rule);
      return;
    }
    const session = guard.engine.session;
    if (!session) return;
    const run: ValidationRun = { name: rule.name, command: rule.command, startedAt: new Date().toISOString(), status: 'running', trigger };
    session.validations = [...(session.validations ?? []), run].slice(-50);
    guard.engine.touch();
    const id = `ck-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    // CustomExecution + our own child process: exit codes are exact on every shell (a bare ShellExecution under
    // PowerShell reports 0 for a failing `node -e "process.exit(3)"`), the output shows in the task terminal
    // and its tail is kept for the report.
    const tailLines: string[] = [];
    run.outputTail = tailLines;
    const execution = new vscode.CustomExecution(async () => new CommandPty(rule.command, cwd, tailLines));
    const task = new vscode.Task({ type: 'changekeeper', id, command: rule.command }, guard.folder, `${rule.name}`, 'ChangeKeeper', execution);
    task.presentationOptions = { reveal: vscode.TaskRevealKind.Silent, panel: vscode.TaskPanelKind.Dedicated, clear: true, showReuseMessage: false };
    const terminalName = `${rule.name}`;
    const t0 = Date.now();
    let done: (r: { exitCode?: number; status: ValidationRun['status'] }) => void = () => undefined;
    const finished = new Promise<{ exitCode?: number; status: ValidationRun['status'] }>((resolve) => (done = resolve));
    const sub = vscode.tasks.onDidEndTaskProcess((e) => {
      const def: any = e.execution.task.definition;
      if (def?.type === 'changekeeper' && def.id === id) {
        sub.dispose();
        done({ exitCode: e.exitCode, status: e.exitCode === 0 ? 'passed' : e.exitCode === undefined ? 'error' : 'failed' });
      }
    });
    let taskExecution: vscode.TaskExecution | undefined;
    const timer = setTimeout(() => {
      taskExecution?.terminate();
      done({ status: 'timeout' });
    }, rule.timeoutSec * 1000);
    try {
      taskExecution = await vscode.tasks.executeTask(task);
    } catch (e) {
      clearTimeout(timer);
      sub.dispose();
      run.status = 'error';
      run.durationMs = Date.now() - t0;
      guard.engine.touch();
      log(`validation "${rule.name}" could not start: ${String(e)}`);
      void vscode.window.showErrorMessage(l10n.t('ChangeKeeper: validation "{0}" could not start: {1}', rule.name, e instanceof Error ? e.message : String(e)));
      return;
    }
    const r = await finished;
    clearTimeout(timer);
    run.exitCode = r.exitCode;
    run.status = r.status;
    run.durationMs = Date.now() - t0;
    guard.engine.touch();
    const label = r.status === 'passed' ? l10n.t('passed') : r.status === 'failed' ? l10n.t('failed (exit {0})', String(r.exitCode)) : r.status === 'timeout' ? l10n.t('timed out') : l10n.t('error');
    const show = l10n.t('Show output');
    // never await a notification: the caller (auto-run, tests, session stop) must not hang on the user's click
    const notify = r.status === 'passed' ? vscode.window.showInformationMessage : vscode.window.showWarningMessage;
    void notify(l10n.t('ChangeKeeper: validation "{0}" {1} in {2} s', rule.name, label, Math.round(run.durationMs / 1000)), show).then((p) => {
      if (p !== show) return;
      // the task terminal stays open (Dedicated panel); "showTasks" would only list running tasks
      const term = vscode.window.terminals.find((t) => t.name.includes(terminalName));
      if (term) term.show();
      else void vscode.workspace.openTextDocument({ content: (run.outputTail ?? []).join('\n'), language: 'plaintext' }).then((d) => vscode.window.showTextDocument(d, { preview: true }));
    });
  }

  private hinted = new Set<string>();
  private hintFirstManualRun(rule: NormalisedRule): void {
    if (this.hinted.has(rule.name)) return;
    this.hinted.add(rule.name);
    void vscode.window.showInformationMessage(l10n.t('ChangeKeeper: validation "{0}" is set to run automatically but needs one manual run first (to confirm the command).', rule.name));
  }

  /** afterReview: when every hunk of a session is reviewed and there are changes; once per state. */
  private async maybeAutoRun(): Promise<void> {
    for (const guard of this.manager.all()) {
      if (!guard.hasSession) continue;
      const c = guard.engine.counters!;
      if (!c.files || c.pending > 0) continue;
      const rules = this.rulesFor(guard).filter((r) => r.runOn === 'afterReview');
      if (!rules.length) continue;
      const sig = `${guard.engine.session!.id}:${c.hunks}:${c.accepted}:${c.discarded}:${c.files}`;
      if (this.lastAutoRunKey.get(guard.folder.uri.toString()) === sig) continue;
      if (this.criticalPending(guard) || !vscode.workspace.isTrusted) continue;
      const pro = await ensureProSilent(this.context);
      if (!pro) continue;
      this.lastAutoRunKey.set(guard.folder.uri.toString(), sig);
      for (const rule of rules) await this.runRule(guard, rule, 'afterReview', true);
    }
  }

  async onSessionEnd(guard: FolderGuard): Promise<void> {
    const rules = this.rulesFor(guard).filter((r) => r.runOn === 'onSessionEnd');
    if (!rules.length || !vscode.workspace.isTrusted) return;
    if (!(await ensureProSilent(this.context))) return;
    for (const rule of rules) await this.runRule(guard, rule, 'onSessionEnd', true);
  }

  // ---- presets ------------------------------------------------------------------------------

  async addPreset(guardArg?: FolderGuard): Promise<void> {
    const guard = guardArg ?? (await this.manager.pickGuard());
    if (!guard) return;
    if (!(await ensurePro(this.context, l10n.t('Validations')))) return;
    let pkg: any;
    try {
      pkg = JSON.parse(await fs.readFile(path.join(guard.folder.uri.fsPath, 'package.json'), 'utf8'));
    } catch {
      pkg = undefined;
    }
    const files: string[] = [];
    for (const f of ['tsconfig.json', 'pyproject.toml', 'pytest.ini', 'setup.cfg', 'Cargo.toml', 'go.mod', 'Makefile']) {
      try {
        await fs.access(path.join(guard.folder.uri.fsPath, f));
        files.push(f);
      } catch {
        /* absent */
      }
    }
    const presets = detectPresets({ packageJson: pkg, files });
    const custom = l10n.t('Custom command…');
    const pick = await vscode.window.showQuickPick([...presets.map((p) => ({ label: p.name, description: p.command, detail: p.why, p })), { label: custom, description: '', detail: '', p: undefined as any }], {
      placeHolder: l10n.t('Add a validation to run after review'),
    });
    if (!pick) return;
    let name = pick.p?.name;
    let command = pick.p?.command;
    if (!pick.p) {
      command = await vscode.window.showInputBox({ prompt: l10n.t('Command to run (in the workspace folder)'), placeHolder: 'npm test' });
      if (!command) return;
      name = (await vscode.window.showInputBox({ prompt: l10n.t('Name'), value: command.slice(0, 30) })) ?? command.slice(0, 30);
    }
    // written to USER settings: workspace settings live in .vscode/settings.json (a critical, agent-editable file)
    const cfg = vscode.workspace.getConfiguration('changekeeper', guard.folder.uri);
    const current = cfg.inspect<any[]>('validations')?.globalValue ?? [];
    await cfg.update('validations', [...current, { name, command, runOn: 'manual', timeoutSec: 600 }], vscode.ConfigurationTarget.Global);
    void vscode.window.showInformationMessage(l10n.t('ChangeKeeper: validation "{0}" added. Run it from the ChangeKeeper view; set runOn to "afterReview" in settings to run it automatically once every hunk is reviewed.', name ?? command ?? ''));
  }

  /** Report section (Pro). */
  section(guard: FolderGuard): string[] {
    const runs = guard.engine.session?.validations ?? [];
    if (!runs.length) return [];
    const lines = ['## Validations', ''];
    for (const r of runs) {
      lines.push(`- ${r.status === 'passed' ? '[x]' : '[ ]'} **${r.name}** \`${r.command}\` — ${r.status}${r.exitCode !== undefined ? ` (exit ${r.exitCode})` : ''}${r.durationMs ? ` · ${Math.round(r.durationMs / 1000)} s` : ''} · ${r.trigger} · ${r.startedAt}`);
      if (r.status !== 'passed' && r.outputTail?.length) {
        lines.push('  ```');
        for (const l of r.outputTail.slice(-15)) lines.push('  ' + l);
        lines.push('  ```');
      }
    }
    return [lines.join('\n')];
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
  }
}

/** Pro check without any UI (for automatic triggers). */
async function ensureProSilent(context: vscode.ExtensionContext): Promise<boolean> {
  return (await proStatus(context)).pro;
}

/** Pseudoterminal that runs one shell command, streams its output and ends with the real exit code. */
class CommandPty implements vscode.Pseudoterminal {
  private readonly writeEmitter = new vscode.EventEmitter<string>();
  private readonly closeEmitter = new vscode.EventEmitter<number>();
  readonly onDidWrite = this.writeEmitter.event;
  readonly onDidClose = this.closeEmitter.event;
  private child: ReturnType<typeof spawn> | undefined;

  constructor(private readonly command: string, private readonly cwd: string, private readonly tail: string[]) {}

  open(): void {
    this.writeEmitter.fire(`\x1b[2m$ ${this.command}\x1b[0m\r\n`);
    const env: NodeJS.ProcessEnv = { ...process.env, CK_VALIDATION: '1' };
    delete env.ELECTRON_RUN_AS_NODE; // inherited from the extension host; would turn Electron-based tools into plain Node
    delete env.ELECTRON_NO_ATTACH_CONSOLE;
    try {
      // detached on POSIX so the whole process group can be signalled on timeout; stdin closed so nothing waits on it
      this.child = spawn(this.command, { cwd: this.cwd, shell: true, windowsHide: true, env, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
    } catch (e) {
      this.writeEmitter.fire(`\r\n${String(e)}\r\n`);
      this.closeEmitter.fire(127);
      return;
    }
    let pending = '';
    const onData = (d: Buffer) => {
      const text = d.toString('utf8');
      this.writeEmitter.fire(text.replace(/\r?\n/g, '\r\n'));
      // tail for the report: complete lines only, ANSI stripped, secrets redacted, bounded
      pending += text;
      const parts = pending.split(/\r?\n/);
      pending = parts.pop() ?? '';
      for (const raw of parts) {
        const line = raw.replace(ANSI, '');
        if (line) this.tail.push(redactLine(line.length > 400 ? line.slice(0, 400) + '…' : line));
      }
      if (this.tail.length > 60) this.tail.splice(0, this.tail.length - 60);
    };
    this.child.stdout?.on('data', onData);
    this.child.stderr?.on('data', onData);
    this.child.on('error', (e) => {
      this.writeEmitter.fire(`\r\n${String(e)}\r\n`);
      this.closeEmitter.fire(127);
    });
    this.child.on('close', (code) => {
      if (pending.trim()) this.tail.push(redactLine(pending.replace(ANSI, '').slice(0, 400)));
      this.writeEmitter.fire(`\r\n\x1b[2m[exit ${code ?? 'null'}]\x1b[0m\r\n`);
      this.closeEmitter.fire(code ?? 1);
    });
  }

  /** Kills the whole tree: `shell: true` means `child` is cmd.exe/sh and the real work is its grandchild. */
  close(): void {
    const c = this.child;
    if (!c || c.pid === undefined) return;
    if (process.platform === 'win32') {
      try {
        spawn('taskkill', ['/pid', String(c.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on('error', () => c.kill());
      } catch {
        c.kill();
      }
    } else {
      try {
        process.kill(-c.pid, 'SIGTERM');
        setTimeout(() => {
          try {
            process.kill(-c.pid!, 'SIGKILL');
          } catch {
            /* gone */
          }
        }, 5000).unref();
      } catch {
        c.kill();
      }
    }
  }
}

const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;

/** Redacts anything that looks like a secret in a line of validation output before it is stored. */
function redactLine(line: string): string {
  const hits = scanSecrets([{ line: 1, text: line }]);
  if (!hits.length) return line;
  // scanSecrets returns the redacted form; rebuild the line by masking the matched fragment(s)
  let out = line;
  for (const h of hits) {
    const visible = h.redacted.split('…')[0];
    const idx = visible ? out.indexOf(visible) : -1;
    if (idx >= 0) out = out.slice(0, idx) + redact(out.slice(idx)) ;
    else out = '[redacted line]';
  }
  return out;
}
