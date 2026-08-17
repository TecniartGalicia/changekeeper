/**
 * Launches a VS Code window with the extension loaded on a throwaway workspace and plays
 * `demo.ts` while a screen recorder captures the window. Only used to produce the store media.
 */
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runTests } from '@vscode/test-electron';

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', HOME: cwd, USERPROFILE: cwd } });
}

async function main(): Promise<void> {
  delete process.env.ELECTRON_RUN_AS_NODE;
  const root = path.resolve(__dirname, '../../../');
  const out = process.env.CK_DEMO_OUT || path.join(os.tmpdir(), 'ck-demo-out');
  fs.mkdirSync(out, { recursive: true });
  for (const f of ['stop.flag', 'marks.txt']) fs.rmSync(path.join(out, f), { force: true });

  // a fresh copy of the demo workspace every run, so the recording is reproducible
  const src = process.env.CK_DEMO_SRC!;
  if (!src || !fs.existsSync(src) || !fs.statSync(src).isDirectory()) throw new Error(`CK_DEMO_SRC must point at the demo workspace (got ${JSON.stringify(src)})`);
  const ws = path.join(out, 'shop-api'); // the folder name shows in the title bar and the explorer
  // the destination is wiped on every run, so make very sure it is not (or does not contain) the source
  const inside = (a: string, b: string) => {
    const rel = path.relative(a, b);
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  };
  if (inside(ws, path.resolve(src)) || inside(path.resolve(src), ws)) throw new Error(`refusing to wipe ${ws}: it overlaps CK_DEMO_SRC (${src})`);
  fs.rmSync(ws, { recursive: true, force: true });
  fs.cpSync(src, ws, { recursive: true });
  fs.rmSync(path.join(ws, '.git'), { recursive: true, force: true });
  git(ws, 'init', '-q', '-b', 'main');
  git(ws, 'config', 'user.email', 'demo@example.com');
  git(ws, 'config', 'user.name', 'Demo');
  git(ws, 'config', 'commit.gpgsign', 'false');
  git(ws, 'config', 'core.autocrlf', 'false');
  git(ws, 'add', '-A');
  git(ws, 'commit', '-q', '-m', 'orders: create and cancel');

  const userDataDir = path.join(out, 'user-data');
  fs.rmSync(path.join(userDataDir, 'User', 'globalStorage', 'argalla.changekeeper'), { recursive: true, force: true });
  fs.mkdirSync(path.join(userDataDir, 'User'), { recursive: true });
  fs.copyFileSync(process.env.CK_DEMO_SETTINGS!, path.join(userDataDir, 'User', 'settings.json'));

  await runTests({
    extensionDevelopmentPath: root,
    extensionTestsPath: path.resolve(__dirname, './index'),
    launchArgs: [ws, `--user-data-dir=${userDataDir}`, '--disable-extensions', '--disable-workspace-trust', '--new-window'],
    extensionTestsEnv: { CK_DEMO_WS: ws, CK_DEMO_OUT: out, CK_PRO_DEV: '1' },
  });
}

main().catch((e) => {
  console.error('demo failed', e);
  process.exit(1);
});
