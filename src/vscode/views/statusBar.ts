import * as vscode from 'vscode';
import { l10n } from 'vscode';
import { GuardManager } from '../guardManager';

export class StatusBar implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;
  private readonly sub: vscode.Disposable;

  constructor(private readonly manager: GuardManager) {
    this.item = vscode.window.createStatusBarItem('changekeeper.status', vscode.StatusBarAlignment.Left, 5);
    this.item.name = 'ChangeKeeper';
    this.sub = manager.onDidChange(() => this.update());
    this.update();
    this.item.show();
  }

  update(): void {
    const guards = this.manager.all();
    const active = guards.filter((g) => g.hasSession);
    if (active.length === 0) {
      this.item.text = '$(shield) CK';
      this.item.tooltip = guards.length ? l10n.t('ChangeKeeper: not guarding. Click to start a session.') : l10n.t('ChangeKeeper: open a folder to guard it.');
      this.item.command = 'changekeeper.startSession';
      this.item.backgroundColor = undefined;
      return;
    }
    let files = 0;
    let hunks = 0;
    let pending = 0;
    let critical = 0;
    let paused = false;
    for (const g of active) {
      const c = g.engine.counters!;
      files += c.files;
      hunks += c.hunks;
      pending += c.pending;
      critical += c.critical;
      if (g.engine.burst.paused) paused = true;
    }
    const parts = [`$(shield) CK`];
    if (files) parts.push(l10n.t('{0} files', files));
    if (hunks) parts.push(l10n.t('{0} hunks', hunks));
    if (critical) parts.push(`$(warning) ${critical}`);
    if (paused) parts.push('$(debug-pause)');
    if (!files) parts.push(l10n.t('guarding'));
    this.item.text = parts.join(' · ');
    this.item.tooltip = new vscode.MarkdownString(
      [`**ChangeKeeper** — ${l10n.t('{0} folder(s) guarded', active.length)}`, l10n.t('{0} changed files, {1} hunks ({2} pending), {3} critical', files, hunks, pending, critical), paused ? l10n.t('Burst guard active: new files are paused') : '', l10n.t('Click to open the ChangeKeeper view')].filter(Boolean).join('  \n'),
    );
    this.item.command = 'changekeeper.changes.focus';
    this.item.backgroundColor = critical && pending ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
  }

  dispose(): void {
    this.sub.dispose();
    this.item.dispose();
  }
}
