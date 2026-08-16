import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import { l10n } from 'vscode';
import { workspaceKey } from '../core/paths';
import { approvalFingerprint, detectPresets, normaliseRules, NormalisedRule, packageScriptOf } from '../core/rules/validations';
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

  private async resolvedScript(guard: FolderGuard, rule: NormalisedRule): Promise<string | undefined> {
    const script = packageScriptOf(rule.command);
    if (!script) return undefined;
    try {
      const pkg = JSON.parse(await fs.readFile(path.join(guard.folder.uri.fsPath, ...(rule.cwd ? rule.cwd.split('/') : []), 'package.json'), 'utf8'));
      const body = pkg?.scripts?.[script];
      return typeof body === 'string' ? body : `<missing script ${script}>`;
    } catch {
      return `<no package.json>`;
    }
  }

  private approvedList(): string[] {
    return this.context.workspaceState.get<string[]>(APPROVED_KEY) ?? [];
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
    const detail = script !== undefined ? l10n.t('Resolved script: {0}', script) : '';
    const pick = await vscode.window.showWarningMessage(
      l10n.t('ChangeKeeper will run "{0}" in {1}. A validation executes code from this repository — code an agent may have edited. Review critical files first.', rule.command, guard.folder.name) + (detail ? '\n' + detail : ''),
      { modal: true, detail },
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

  private async runRule(guard: FolderGuard, rule: NormalisedRule, trigger: ValidationRun['trigger'], silent: boolean): Promise<void> {
    if (!(await this.confirm(guard, rule, silent))) return;
    const session = guard.engine.session;
    if (!session) return;
    const run: ValidationRun = { name: rule.name, command: rule.command, startedAt: new Date().toISOString(), status: 'running', trigger };
    session.validations = [...(session.validations ?? []), run].slice(-50);
    guard.engine.touch();
    const id = `ck-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const cwd = rule.cwd ? path.join(guard.folder.uri.fsPath, ...rule.cwd.split('/')) : guard.folder.uri.fsPath;
    const task = new vscode.Task({ type: 'changekeeper', id, command: rule.command }, guard.folder, `${rule.name}`, 'ChangeKeeper', new vscode.ShellExecution(rule.command, { cwd }));
    task.presentationOptions = { reveal: vscode.TaskRevealKind.Silent, panel: vscode.TaskPanelKind.Dedicated, clear: true, showReuseMessage: false };
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
    let execution: vscode.TaskExecution | undefined;
    const timer = setTimeout(() => {
      execution?.terminate();
      done({ status: 'timeout' });
    }, rule.timeoutSec * 1000);
    try {
      execution = await vscode.tasks.executeTask(task);
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
    const p = await (r.status === 'passed' ? vscode.window.showInformationMessage : vscode.window.showWarningMessage)(l10n.t('ChangeKeeper: validation "{0}" {1} in {2} s', rule.name, label, Math.round(run.durationMs / 1000)), show);
    if (p === show) await vscode.commands.executeCommand('workbench.action.tasks.showTasks');
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
      this.lastAutoRunKey.set(guard.folder.uri.toString(), sig);
      if (guard.engine.changes().some((ch) => ch.critical && !ch.fileAccepted && Object.values(ch.hunks).some((s) => s === 'pending'))) continue;
      if (!vscode.workspace.isTrusted) continue;
      const pro = await ensureProSilent(this.context);
      if (!pro) continue;
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
    const cfg = vscode.workspace.getConfiguration('changekeeper', guard.folder.uri);
    const current = cfg.get<any[]>('validations', []);
    await cfg.update('validations', [...current, { name, command, runOn: 'manual', timeoutSec: 600 }], vscode.ConfigurationTarget.WorkspaceFolder);
    void vscode.window.showInformationMessage(l10n.t('ChangeKeeper: validation "{0}" added. Run it from the ChangeKeeper view; set runOn to "afterReview" in settings to run it automatically once every hunk is reviewed.', name ?? command ?? ''));
  }

  /** Report section (Pro). */
  section(guard: FolderGuard): string[] {
    const runs = guard.engine.session?.validations ?? [];
    if (!runs.length) return [];
    const lines = ['## Validations', ''];
    for (const r of runs) lines.push(`- ${r.status === 'passed' ? '[x]' : '[ ]'} **${r.name}** \`${r.command}\` — ${r.status}${r.exitCode !== undefined ? ` (exit ${r.exitCode})` : ''}${r.durationMs ? ` · ${Math.round(r.durationMs / 1000)} s` : ''} · ${r.trigger} · ${r.startedAt}`);
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
