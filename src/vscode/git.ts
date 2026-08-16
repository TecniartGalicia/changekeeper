import * as vscode from 'vscode';
import { gitToplevel, NodeGit } from '../core/nodeAdapters';
import { log } from './env';

/**
 * Minimal typing of the built-in git extension API (extensions/git/src/api/git.d.ts).
 * We only need the executable path and repository discovery; everything else is plumbing via child_process.
 */
interface GitApi {
  readonly state: 'uninitialized' | 'initialized';
  readonly onDidChangeState: vscode.Event<'uninitialized' | 'initialized'>;
  readonly git: { path: string };
  readonly repositories: { rootUri: vscode.Uri; inputBox: { value: string } }[];
  getRepository(uri: vscode.Uri): { rootUri: vscode.Uri; inputBox: { value: string } } | null;
  onDidOpenRepository: vscode.Event<{ rootUri: vscode.Uri }>;
}
interface GitExtension {
  readonly enabled: boolean;
  getAPI(version: 1): GitApi;
}

let cachedApi: GitApi | undefined | null;

/** The git extension API, waiting (bounded) for it to initialise. `null` when unavailable/disabled. */
export async function gitApi(timeoutMs = 4000): Promise<GitApi | null> {
  if (cachedApi !== undefined) return cachedApi;
  const ext = vscode.extensions.getExtension<GitExtension>('vscode.git');
  if (!ext) return (cachedApi = null);
  try {
    const exports = ext.isActive ? ext.exports : await ext.activate();
    if (!exports || !exports.enabled) return (cachedApi = null);
    const api = exports.getAPI(1);
    if (api.state !== 'initialized') {
      await new Promise<void>((resolve) => {
        const t = setTimeout(() => {
          d.dispose();
          resolve();
        }, timeoutMs);
        const d = api.onDidChangeState((s) => {
          if (s === 'initialized') {
            clearTimeout(t);
            d.dispose();
            resolve();
          }
        });
      });
    }
    return (cachedApi = api);
  } catch (e) {
    log(`git extension unavailable: ${String(e)}`);
    return (cachedApi = null);
  }
}

export interface GitContext {
  runner: NodeGit;
  /** repo-root-relative prefix of the folder with trailing slash ('' when the folder is the root) */
  prefix: string;
  root: string;
  gitPath: string;
  /** absolute git directory (`.git` folder, or the worktree/submodule git dir) — watched for HEAD/index moves */
  gitDir?: string;
}

/**
 * Detects whether `folder` is inside a git work tree. Uses the git extension's executable when it
 * exists (respects `git.path`), otherwise `git` from PATH.
 */
export async function detectGit(folder: vscode.Uri): Promise<GitContext | undefined> {
  const api = await gitApi();
  const gitPath = api?.git.path || 'git';
  const top = await gitToplevel(gitPath, folder.fsPath);
  if (!top) return undefined;
  const runner = new NodeGit(gitPath, folder.fsPath);
  const pre = await runner.run(['rev-parse', '--show-prefix', '--absolute-git-dir']);
  const lines = pre.code === 0 ? pre.stdout.toString('utf8').split(/\r?\n/) : [];
  const prefix = (lines[0] ?? '').trim();
  const gitDir = (lines[1] ?? '').trim() || undefined;
  return { runner, prefix, root: top, gitPath, gitDir };
}

/** The SCM input box of the repository containing `folder`, if the git extension knows it. */
export async function scmInputBox(folder: vscode.Uri): Promise<{ value: string } | undefined> {
  const api = await gitApi();
  return api?.getRepository(folder)?.inputBox ?? undefined;
}
