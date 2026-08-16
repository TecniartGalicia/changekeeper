import * as vscode from 'vscode';
import { l10n } from 'vscode';
import { HookEvent } from '../../core/hooks/events';
import { log } from '../env';
import { FolderGuard } from '../folderGuard';
import { GuardManager } from '../guardManager';
import { HookInstaller, HookTarget } from './installer';
import { HookServer } from './server';

/**
 * Agent attribution through hooks (Pro to install; free to revert/inspect). Events tag which agent
 * touched which file and can start a session when an agent starts (`autoStart: whenAgentDetected`).
 */
export class HooksFeature implements vscode.Disposable {
  readonly server: HookServer;
  readonly installer: HookInstaller;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(context: vscode.ExtensionContext, private readonly manager: GuardManager, private readonly ensurePro: (feature: string) => Promise<boolean>) {
    const port = vscode.workspace.getConfiguration('changekeeper').get<number>('hooks.port', 47391);
    this.server = new HookServer(context.globalStorageUri.fsPath, port);
    this.installer = new HookInstaller(this.server, context.globalStorageUri.fsPath);
    this.disposables.push(
      this.server.onEvent((e) => void this.handle(e.folder, e.event)),
      manager.onDidAddGuard(() => void this.server.setFolders(this.folders())),
      vscode.workspace.onDidChangeWorkspaceFolders(() => void this.server.setFolders(this.folders())),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('changekeeper.hooks.port')) void this.server.setPort(vscode.workspace.getConfiguration('changekeeper').get<number>('hooks.port', 47391));
      }),
      vscode.commands.registerCommand('changekeeper.hooks.install', () => this.installCommand()),
      vscode.commands.registerCommand('changekeeper.hooks.revert', () => this.revertCommand()),
      vscode.commands.registerCommand('changekeeper.hooks.doctor', () => this.doctorCommand()),
    );
    void this.server.start(this.folders()).catch((e) => log(`hook server start failed: ${String(e)}`));
  }

  private folders(): string[] {
    return this.manager
      .all()
      .filter((g) => g.folder.uri.scheme === 'file')
      .map((g) => g.folder.uri.fsPath);
  }

  private guardFor(folder: string): FolderGuard | undefined {
    return this.manager.all().find((g) => g.folder.uri.fsPath === folder);
  }

  private async handle(folder: string, evt: HookEvent): Promise<void> {
    const guard = this.guardFor(folder);
    if (!guard) return;
    try {
      if (evt.kind === 'session-start') {
        if (!guard.hasSession) {
          const auto = guard.config.autoStart;
          if (auto === 'whenAgentDetected' || auto === 'always' || (auto === 'git' && guard.isGit)) {
            log(`[${guard.folder.name}] agent ${evt.agent} started a session → starting a guarded session`);
            await guard.start({ silent: true, agent: evt.agent });
          }
        } else if (guard.engine.session && !guard.engine.session.agent) {
          guard.engine.session.agent = evt.agent;
          guard.engine.touch();
        }
        return;
      }
      if (evt.kind === 'tool-done' && evt.filePath) {
        const rel = guard.engine.relOf(evt.filePath);
        if (!rel) return;
        guard.engine.noteAgentTouch(rel, evt.agent);
        if (guard.hasSession) guard.enqueueRel(rel, 0, 'change');
        return;
      }
      if (evt.kind === 'stop' || evt.kind === 'session-end') {
        log(`[${guard.folder.name}] agent ${evt.agent}: ${evt.kind}`);
      }
    } catch (e) {
      log(`hook handling failed: ${String(e)}`);
    }
  }

  private async installCommand(): Promise<void> {
    if (!(await this.ensurePro(l10n.t('Agent hooks')))) return;
    const guard = await this.manager.pickGuard();
    const user = { label: l10n.t('User settings (~/.claude/settings.json) — every project'), target: 'user' as const };
    const project = { label: l10n.t('This project only (.claude/settings.local.json)'), description: guard?.folder.name ?? '', target: 'project' as const };
    const pick = await vscode.window.showQuickPick(guard ? [user, project] : [user], { placeHolder: l10n.t('Where should the Claude Code hooks live?') });
    if (!pick) return;
    const file = await this.installer.install(pick.target, guard?.folder.uri.fsPath);
    if (file) {
      const doctor = l10n.t('Check');
      void vscode.window.showInformationMessage(l10n.t('ChangeKeeper: hooks written to {0}. Claude Code picks them up live; the next tool call will show up with its agent tag.', file), doctor).then((p) => (p === doctor ? this.doctorCommand() : undefined));
    }
  }

  private async revertCommand(): Promise<void> {
    const guard = await this.manager.pickGuard();
    const items: { label: string; target: HookTarget }[] = [{ label: l10n.t('User settings (~/.claude/settings.json)'), target: 'user' }];
    if (guard) items.push({ label: l10n.t('This project (.claude/settings.local.json)'), target: 'project' });
    const pick = await vscode.window.showQuickPick(items, { placeHolder: l10n.t('Remove ChangeKeeper hooks from…') });
    if (!pick) return;
    if (await this.installer.revert(pick.target, guard?.folder.uri.fsPath)) void vscode.window.showInformationMessage(l10n.t('ChangeKeeper: hooks removed.'));
  }

  private async doctorCommand(): Promise<void> {
    const text = await this.installer.report(this.folders());
    const doc = await vscode.workspace.openTextDocument({ content: `ChangeKeeper — hooks doctor\n\n${text}\n`, language: 'plaintext' });
    await vscode.window.showTextDocument(doc, { preview: true });
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
    void this.server.dispose();
  }
}
