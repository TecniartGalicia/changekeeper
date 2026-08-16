import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runTests } from '@vscode/test-electron';

/**
 * Hermetic integration run:
 *  - a temp workspace folder with a small git repository (committed files) is opened;
 *  - VS Code runs with an isolated user-data-dir and no other extensions (built-ins like git stay);
 *  - the suite simulates a CLI agent (plain fs writes) and an editor agent (WorkspaceEdit).
 * Set CK_VSCODE_EXE to run the same suite in VSCodium/Cursor.
 */
function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', HOME: cwd, USERPROFILE: cwd } });
}

async function main(): Promise<void> {
  // When launched from a terminal inside VS Code, the extension host sets ELECTRON_RUN_AS_NODE=1;
  // the test VS Code would inherit it and start as plain Node ("bad option: --...").
  delete process.env.ELECTRON_RUN_AS_NODE;

  const extensionDevelopmentPath = path.resolve(__dirname, '../../../');
  const extensionTestsPath = path.resolve(__dirname, './suite/index');

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ck-it-'));
  const workspace = path.join(tmp, 'workspace');
  fs.mkdirSync(path.join(workspace, 'src'), { recursive: true });
  fs.writeFileSync(path.join(workspace, 'src', 'app.ts'), 'export function add(a: number, b: number) {\n  return a + b;\n}\n\nexport const VERSION = 1;\n\nexport function sub(a: number, b: number) {\n  return a - b;\n}\n');
  fs.writeFileSync(path.join(workspace, 'README.md'), '# demo\n');
  fs.writeFileSync(path.join(workspace, '.gitignore'), 'node_modules/\n.env\n');
  fs.writeFileSync(path.join(workspace, 'package.json'), '{ "name": "demo", "version": "1.0.0" }\n');
  git(workspace, 'init', '-q', '-b', 'main');
  git(workspace, 'config', 'user.email', 'ck@test');
  git(workspace, 'config', 'user.name', 'CK');
  git(workspace, 'config', 'commit.gpgsign', 'false');
  git(workspace, 'config', 'core.autocrlf', 'false');
  git(workspace, 'add', '-A');
  git(workspace, 'commit', '-q', '-m', 'init');

  const vscodeExecutablePath = process.env.CK_VSCODE_EXE || undefined;
  if (vscodeExecutablePath) console.log(`Running the integration suite in: ${vscodeExecutablePath}`);
  const userDataDir = path.join(extensionDevelopmentPath, '.vscode-test', 'user-data');
  // a previous run's ChangeKeeper storage/state must not leak into this one (first-run flag, old sessions)
  fs.rmSync(path.join(userDataDir, 'User', 'globalStorage', 'argalla.changekeeper'), { recursive: true, force: true });
  fs.rmSync(path.join(userDataDir, 'User', 'globalStorage', 'state.vscdb'), { force: true });
  fs.rmSync(path.join(userDataDir, 'User', 'globalStorage', 'state.vscdb-journal'), { force: true });
  // a port of our own so the suite never fights a real VS Code + ChangeKeeper window on the developer's machine
  const userSettings = path.join(userDataDir, 'User', 'settings.json');
  fs.mkdirSync(path.dirname(userSettings), { recursive: true });
  let settings: Record<string, unknown> = {};
  try {
    settings = JSON.parse(fs.readFileSync(userSettings, 'utf8'));
  } catch {
    /* fresh */
  }
  settings['changekeeper.hooks.port'] = 47399;
  fs.writeFileSync(userSettings, JSON.stringify(settings, null, 2));
  try {
    await runTests({
      ...(vscodeExecutablePath ? { vscodeExecutablePath } : {}),
      extensionDevelopmentPath,
      extensionTestsPath,
      launchArgs: [workspace, `--user-data-dir=${userDataDir}`, '--disable-extensions', '--disable-workspace-trust'],
      // CK_PRO_DEV unlocks the Pro tier without network (never set it in a user's environment).
      // With CK_LIVE_KEY the dev unlock is off on purpose: that run exercises the real Polar flow.
      extensionTestsEnv: process.env.CK_LIVE_KEY
        ? { CK_IT_WORKSPACE: workspace, CK_IT_TMP: tmp, CK_LIVE_KEY: process.env.CK_LIVE_KEY }
        : { CK_IT_WORKSPACE: workspace, CK_IT_TMP: tmp, CK_PRO_DEV: '1' },
    });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error('Integration tests failed', err);
  process.exit(1);
});
