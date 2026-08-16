import * as vscode from 'vscode';
import { l10n } from 'vscode';
import { scanSecrets } from '../core/rules/secrets';
import { suggestCommitMessage } from '../core/report';
import { scmInputBox } from '../vscode/git';
import { FolderGuard } from '../vscode/folderGuard';
import { GuardManager } from '../vscode/guardManager';
import { ReportCommands } from '../vscode/reportCommands';
import { ValidationRunner } from '../vscode/validate';
import { activateLicenseCommand, deactivateLicenseCommand, ensurePro, licenseStatusCommand, openCheckout, proStatus } from './licenseService';

/**
 * Pro tier wiring. Rule of the house: everything Pro *adds* can be removed without a licence
 * (validations are just settings the user deletes; secret findings vanish when the scanner is off;
 * nothing else is written anywhere). `ensurePro` therefore only guards *adding* behaviour.
 */
export class ProFeatures implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  readonly validations: ValidationRunner;
  private scannerOn = false;

  constructor(private readonly context: vscode.ExtensionContext, private readonly manager: GuardManager, reports: ReportCommands) {
    this.validations = new ValidationRunner(context, manager);
    reports.extraSections.push(async (g) => [...this.validations.section(g), ...this.secretsSection(g)]);
    this.disposables.push(
      this.validations,
      vscode.commands.registerCommand('changekeeper.validate', () => this.validations.runAll()),
      vscode.commands.registerCommand('changekeeper.validateOne', () => this.validations.runOne()),
      vscode.commands.registerCommand('changekeeper.addValidation', () => this.validations.addPreset()),
      vscode.commands.registerCommand('changekeeper.commitMessageToScm', () => this.commitMessageToScm()),
      vscode.commands.registerCommand('changekeeper.pro.activate', () => activateLicenseCommand(context).then(() => this.refreshScanner())),
      vscode.commands.registerCommand('changekeeper.pro.deactivate', () => deactivateLicenseCommand(context).then(() => this.refreshScanner())),
      vscode.commands.registerCommand('changekeeper.pro.status', () => licenseStatusCommand(context)),
      vscode.commands.registerCommand('changekeeper.pro.buy', () => openCheckout()),
      manager.onDidAddGuard((g) => this.applyTo(g)),
    );
    void this.refreshScanner();
  }

  /** The secret scanner is injected into every engine while the licence is valid; removed otherwise. */
  async refreshScanner(): Promise<void> {
    const pro = (await proStatus(this.context)).pro;
    this.scannerOn = pro;
    for (const g of this.manager.all()) g.setSecretScanner(pro ? scanSecrets : undefined);
    void vscode.commands.executeCommand('setContext', 'changekeeper.pro', pro);
  }

  applyTo(guard: FolderGuard): void {
    guard.setSecretScanner(this.scannerOn ? scanSecrets : undefined);
  }

  private secretsSection(guard: FolderGuard): string[] {
    const hits = guard.engine.changes().filter((c) => c.secrets && c.secrets.length);
    if (!hits.length) return [];
    const lines = ['## Possible secrets in added lines (redacted)', ''];
    for (const c of hits) for (const s of c.secrets!) lines.push(`- \`${c.path}:${s.line}\` — ${s.label}: \`${s.redacted}\``);
    lines.push('', '_Heuristic patterns; verify before committing._');
    return [lines.join('\n')];
  }

  async commitMessageToScm(): Promise<void> {
    if (!(await ensurePro(this.context, l10n.t('Commit message into the SCM box')))) return;
    const guard = await this.manager.pickGuard((g) => g.hasSession);
    if (!guard || !guard.engine.session) return;
    const box = await scmInputBox(guard.folder.uri);
    const msg = suggestCommitMessage(guard.engine.session);
    if (!box) {
      await vscode.env.clipboard.writeText(msg);
      void vscode.window.showInformationMessage(l10n.t('ChangeKeeper: no git repository input box found; the message was copied to the clipboard.'));
      return;
    }
    if (box.value.trim()) {
      const replace = l10n.t('Replace');
      const pick = await vscode.window.showWarningMessage(l10n.t('The commit message box already has text. Replace it?'), { modal: true }, replace);
      if (pick !== replace) return;
    }
    box.value = msg;
    await vscode.commands.executeCommand('workbench.view.scm');
    void vscode.window.setStatusBarMessage(l10n.t('ChangeKeeper: commit message placed in the SCM box'), 3000);
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
  }
}
