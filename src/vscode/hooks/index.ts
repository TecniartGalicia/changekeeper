import * as vscode from 'vscode';
import { l10n } from 'vscode';
import { HookEvent } from '../../core/hooks/events';
import { log } from '../env';
import { FolderGuard } from '../folderGuard';
import { GuardManager } from '../guardManager';
import { HookInstaller, HookTarget } from './installer';
import { DEFAULT_HOOK_PORT, HookServer } from './server';

const EVER_INSTALLED_KEY = 'changekeeper.hooksEverInstalled';

/**
 * Agent attribution through hooks (Pro to install; free to revert/inspect). Events tag which agent
 * touched which file and can start a session when an agent starts (`autoStart: whenAgentDetected`).
 * The local receiver runs only when it can be useful: hooks installed (user file, or a project file
 * of an open folder, or installed from this machine before) or `autoStart: whenAgentDetected`.
 */
export class HooksFeature implements vscode.Disposable {
  readonly server: HookServer;
  readonly installer: HookInstaller;
  private readonly disposables: vscode.Disposable[] = [];
  private starting: Promise<void> | undefined;

  constructor(private readonly context: vscode.ExtensionContext, private readonly manager: GuardManager, private readonly ensurePro: (feature: string) => Promise<boolean>) {
    this.server = new HookServer(context.globalStorageUri.fsPath, this.configuredPort());
    this.installer = new HookInstaller(this.server, context.globalStorageUri.fsPath);
    this.disposables.push(
      this.server.onEvent((e) => void this.handle(e.folder, e.event)),
      manager.onDidAddGuard(() => void this.onFoldersChanged()),
      vscode.workspace.onDidChangeWorkspaceFolders(() => void this.onFoldersChanged()),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('changekeeper.hooks.port')) void this.server.setPort(this.configuredPort());
        if (e.affectsConfiguration('changekeeper.autoStart')) void this.startIfUseful();
      }),
      vscode.commands.registerCommand('changekeeper.hooks.install', () => this.installCommand()),
      vscode.commands.registerCommand('changekeeper.hooks.revert', () => this.revertCommand()),
      vscode.commands.registerCommand('changekeeper.hooks.doctor', () => this.doctorCommand()),
    );
    void this.startIfUseful();
  }

  private configuredPort(): number {
    const raw = vscode.workspace.getConfiguration('changekeeper').get<unknown>('hooks.port', DEFAULT_HOOK_PORT);
    const p = HookServer.validPort(raw);
    if (p !== raw) log(`changekeeper.hooks.port = ${JSON.stringify(raw)} is not a usable port (integer 1024–65535); using ${p}`);
    return p;
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

  private async onFoldersChanged(): Promise<void> {
    if (this.server.isStarted) await this.server.setFolders(this.folders());
    else await this.startIfUseful();
  }

  /** Receiver on only when it can be useful (see class doc); idempotent. */
  async startIfUseful(): Promise<void> {
    if (this.server.isStarted) return;
    if (this.starting) return this.starting;
    this.starting = (async () => {
      try {
        const wanted = this.manager.all().some((g) => g.config.autoStart === 'whenAgentDetected') || this.context.globalState.get<boolean>(EVER_INSTALLED_KEY, false) || (await this.installer.anyInstalled(this.folders()));
        if (wanted) await this.ensureStarted();
      } catch (e) {
        log(`hook receiver start check failed: ${String(e)}`);
      } finally {
        this.starting = undefined;
      }
    })();
    return this.starting;
  }

  async ensureStarted(): Promise<void> {
    if (this.server.isStarted) return;
    await this.server.start(this.folders()).catch((e) => log(`hook server start failed: ${String(e)}`));
  }

  /** @internal Handles one routed event for one folder (public for the unit tests). */
  async handle(folder: string, evt: HookEvent): Promise<void> {
    const guard = this.guardFor(folder);
    if (!guard) return;
    try {
      const auto = guard.config.autoStart;
      const mayStart = auto === 'whenAgentDetected' || (!guard.stoppedByUser && (auto === 'always' || (auto === 'git' && guard.isGit)));
      if (evt.kind === 'session-start' || evt.kind === 'prompt') {
        if (!guard.hasSession) {
          if (mayStart) {
            log(`[${guard.folder.name}] agent ${evt.agent} started a session → starting a guarded session`);
            await guard.start({ silent: true, agent: evt.agent });
          }
        } else if (guard.engine.session && (!guard.engine.session.agent || (guard.engine.session.agent === 'agent' && evt.agent !== 'agent'))) {
          guard.engine.session.agent = evt.agent;
          guard.engine.touch();
        }
        return;
      }
      if (evt.kind === 'tool-done' && evt.filePath) {
        const rel = guard.engine.relOf(evt.filePath);
        if (!rel) return;
        // an agent is editing and nobody guards yet: with whenAgentDetected that is the signal (git baseline = index, nothing is lost)
        if (!guard.hasSession && auto === 'whenAgentDetected') {
          log(`[${guard.folder.name}] agent ${evt.agent} edited ${rel} → starting a guarded session`);
          await guard.start({ silent: true, agent: evt.agent });
        }
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
    const project = { label: l10n.t('This project only (.claude/settings.local.json)'), description: guard?.folder.name ?? '', detail: l10n.t('Recommended: fires only for Claude Code sessions in this folder.'), target: 'project' as const };
    const user = { label: l10n.t('User settings (~/.claude/settings.json) — every project'), detail: l10n.t('Fires in every Claude Code session on this machine (a non-blocking "hook error" shows in Claude when VS Code is closed).'), target: 'user' as const };
    const pick = await vscode.window.showQuickPick(guard ? [project, user] : [user], { placeHolder: l10n.t('Where should the Claude Code hooks live?') });
    if (!pick) return;
    await this.ensureStarted();
    const file = await this.installer.install(pick.target, guard?.folder.uri.fsPath);
    if (!file) return;
    await this.context.globalState.update(EVER_INSTALLED_KEY, true);
    if (pick.target === 'project' && guard) await this.markOwnWrite(guard, file);
    const doctor = l10n.t('Check');
    void vscode.window.showInformationMessage(l10n.t('ChangeKeeper: hooks written to {0}. Claude Code picks them up live; the next tool call will show up with its agent tag.', file), doctor).then((p) => (p === doctor ? this.doctorCommand() : undefined));
  }

  /** The project settings file we just wrote is a critical path of the guarded folder: inspect it now and mark it reviewed (it is our own change). */
  async markOwnWrite(guard: FolderGuard, file: string): Promise<void> {
    if (!guard.hasSession) return;
    const rel = guard.engine.relOf(file);
    if (!rel) return;
    try {
      const ch = await guard.engine.handlePath(rel);
      if (ch) guard.engine.acceptFile(rel);
    } catch (e) {
      log(`could not mark ${rel} as reviewed: ${String(e)}`);
    }
  }

  private async revertCommand(): Promise<void> {
    const guard = await this.manager.pickGuard();
    const items: { label: string; target: HookTarget }[] = [{ label: l10n.t('User settings (~/.claude/settings.json)'), target: 'user' }];
    if (guard) items.push({ label: l10n.t('This project (.claude/settings.local.json)'), target: 'project' });
    const pick = await vscode.window.showQuickPick(items, { placeHolder: l10n.t('Remove ChangeKeeper hooks from…') });
    if (!pick) return;
    if (!(await this.installer.revert(pick.target, guard?.folder.uri.fsPath))) return;
    void vscode.window.showInformationMessage(l10n.t('ChangeKeeper: hooks removed.'));
    // nothing installed anywhere we can see and no folder wants agent detection: the receiver has no job left
    const stillWanted = this.manager.all().some((g) => g.config.autoStart === 'whenAgentDetected') || (await this.installer.anyInstalled(this.folders()));
    if (!stillWanted) {
      await this.context.globalState.update(EVER_INSTALLED_KEY, false);
      await this.server.stop();
    }
  }

  private async doctorCommand(): Promise<void> {
    const text = await this.installer.report(this.folders(), this.server.isStarted && !this.server.isOwner ? await this.server.liveOwnerElsewhere() : false);
    const doc = await vscode.workspace.openTextDocument({ content: `ChangeKeeper — hooks doctor\n\n${text}\n`, language: 'plaintext' });
    await vscode.window.showTextDocument(doc, { preview: true });
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
    void this.server.dispose();
  }
}
