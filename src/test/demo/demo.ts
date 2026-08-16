/**
 * Scripted demo used to record the store GIF/screenshots (not part of the test suites).
 * Run with `npm run demo` — it opens a VS Code window on the demo workspace, plays the script with
 * pauses so a screen recorder can follow, and drops a marker file when it finishes.
 * Every step goes through the extension's real commands: nothing is faked for the camera.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

const WS = process.env.CK_DEMO_WS!;
const OUT = process.env.CK_DEMO_OUT!;
const abs = (rel: string) => path.join(WS, rel);
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const mark = (name: string) => fs.appendFileSync(path.join(OUT, 'marks.txt'), `${Date.now()} ${name}\n`);


/** Keeps the frame clean: closes the auxiliary (chat) bar and dismisses notification toasts. */
async function tidy(): Promise<void> {
  for (const c of ['workbench.action.closeAuxiliaryBar', 'notifications.clearAll', 'notifications.hideToasts', 'workbench.action.closePanel']) {
    await vscode.commands.executeCommand(c).then(undefined, () => undefined);
  }
}
/** An agent editing from the shell: plain writes, no editor involved. */
function agentEdit(rel: string, edit: (s: string) => string): void {
  const p = abs(rel);
  fs.writeFileSync(p, edit(fs.readFileSync(p, 'utf8')));
}

export async function run(): Promise<void> {
  fs.mkdirSync(OUT, { recursive: true });
  const ext = vscode.extensions.getExtension('argalla.changekeeper')!;
  await ext.activate();
  await wait(2500);
  await tidy(); // no chat panel, no leftover toasts in the frame

  // 0. Open a source file so the window does not look empty
  const doc = await vscode.workspace.openTextDocument(abs('src/api/orders.ts'));
  await vscode.window.showTextDocument(doc, { preview: false });
  await wait(2500);
  await tidy();
  mark('start');

  // 1. The agent works from the terminal: edits code, touches .env and adds a migration
  agentEdit('src/api/orders.ts', (s) =>
    s
      .replace("  const items = input.items.filter((i) => i.quantity > 0);\n  if (!items.length) throw new Error('An order needs at least one item');\n", '  const items = input.items;\n')
      .replace("await tx.stock.reserve(item.sku, item.quantity);\n      ", ''),
  );
  await wait(1200);
  // built at runtime: written whole, GitHub's push protection would flag this file as a leaked Stripe key
  const fakeLiveKey = ['sk', 'live', '51RealKeyPastedByTheAgent0000'].join('_');
  const seedKey = ['sk', 'test', '51LocalDevelopmentKeyOnly'].join('_');
  agentEdit('.env', (s) => s.replace(`STRIPE_SECRET_KEY=${seedKey}`, `STRIPE_SECRET_KEY=${fakeLiveKey}`));
  await wait(900);
  fs.writeFileSync(abs('migrations/004_drop_stock_holds.sql'), 'DROP TABLE stock_holds;\n');
  await wait(2600);
  await tidy();
  mark('agent-edits-done');

  // 2. The ChangeKeeper view fills up: critical files first
  await vscode.commands.executeCommand('workbench.view.extension.changekeeper');
  await wait(3200);
  await tidy();
  mark('tree');

  // 3. Open the diff of the code file (baseline ↔ now) and let the CodeLens show up
  await vscode.commands.executeCommand('vscode.diff', vscode.Uri.from({ scheme: 'ck-baseline', path: '/src/api/orders.ts', query: new URLSearchParams({ folder: vscode.workspace.workspaceFolders![0].uri.toString(), session: (await currentSessionId()) ?? '' }).toString() }), vscode.Uri.file(abs('src/api/orders.ts')), 'orders.ts (baseline ↔ now)');
  await wait(4200);
  await tidy();
  mark('diff');

  // 4. Discard the hunk that removed the stock reservation, with the real command
  const editor = vscode.window.activeTextEditor;
  if (editor) {
    editor.selection = new vscode.Selection(new vscode.Position(9, 0), new vscode.Position(9, 0));
    editor.revealRange(new vscode.Range(4, 0, 16, 0));
  }
  await wait(1500);
  await vscode.commands.executeCommand('changekeeper.discardHunkAtCursor');
  await wait(3500);
  await tidy();
  mark('discard');

  // 5. The .env the agent rewrote: restore it and show that undo is there
  await vscode.commands.executeCommand('workbench.view.extension.changekeeper');
  await wait(1500);
  const envDoc = await vscode.workspace.openTextDocument(abs('.env'));
  await vscode.window.showTextDocument(envDoc, { preview: false });
  await wait(2600);
  await tidy();
  mark('env');

  // 6. Session report with the suggested commit message
  await vscode.commands.executeCommand('changekeeper.showReport');
  await wait(4500);
  await tidy();
  mark('report');

  fs.writeFileSync(path.join(OUT, 'stop.flag'), 'done');
  await wait(1200);
}

async function currentSessionId(): Promise<string | undefined> {
  const manager = await vscode.commands.executeCommand<any>('changekeeper._manager');
  const g = manager?.all?.()[0];
  return g?.engine?.session?.id;
}

