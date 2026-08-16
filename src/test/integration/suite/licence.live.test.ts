import * as assert from 'assert';
import * as vscode from 'vscode';

/**
 * Live licence test against the real Polar organisation. Skipped unless CK_LIVE_KEY holds a licence
 * key (see docs/TUS-TAREAS.md, task P2) — CI and everyday runs never touch the network for this.
 * It drives the real commands (input box stubbed) so the whole path is covered: activate → stored in
 * SecretStorage → context key → a Pro feature really unlocks → deactivate leaves no activation behind.
 */
const KEY = process.env.CK_LIVE_KEY;

(KEY ? describe : describe.skip)('live licence (real Polar key)', function () {
  this.timeout(120000);
  let restore: (() => void)[] = [];
  afterEach(() => {
    for (const r of restore.splice(0)) r();
  });

  function stubInput(value: string | undefined): void {
    const original = vscode.window.showInputBox;
    (vscode.window as any).showInputBox = async () => value;
    restore.push(() => ((vscode.window as any).showInputBox = original));
  }
  /** Records every notification; `answer: true` presses the first offered button (modals default to cancel). */
  function captureMessages(answer = false): string[] {
    const seen: string[] = [];
    for (const k of ['showInformationMessage', 'showWarningMessage', 'showErrorMessage'] as const) {
      const original = (vscode.window as any)[k];
      (vscode.window as any)[k] = async (msg: string, ...rest: any[]) => {
        seen.push(msg);
        const items = rest.filter((r) => typeof r === 'string');
        return answer ? items[0] : undefined;
      };
      restore.push(() => ((vscode.window as any)[k] = original));
    }
    return seen;
  }
  it('activates, unlocks Pro, reports its status and deactivates cleanly', async () => {
    assert.strictEqual(process.env.CK_PRO_DEV, undefined, 'the dev unlock must be off for this test');
    const pro = await vscode.commands.executeCommand<any>('changekeeper._pro');
    assert.ok(pro, 'Pro feature object');

    // 1. Enter licence key (the command asks for it; we answer with the real one)
    let msgs = captureMessages();
    stubInput(KEY);
    await vscode.commands.executeCommand('changekeeper.pro.activate');
    assert.ok(
      msgs.some((m) => /Pro/i.test(m) && !/could not|error|inválida|invalid/i.test(m)),
      'activation reported success: ' + JSON.stringify(msgs),
    );

    // 2. A real Pro feature is on: the secret scanner is installed on every guard
    await pro.refreshScanner();
    const guards = (await vscode.commands.executeCommand<any>('changekeeper._manager')).all();
    assert.ok(guards.length > 0);
    assert.ok(
      guards.every((g: any) => typeof g.deps?.secretScanner === 'function' || g.secretScannerOn !== false),
      'the Pro secret scanner is active',
    );

    // 3. Licence status reports an active licence (it revalidates against Polar first)
    const before = msgs.length;
    await vscode.commands.executeCommand('changekeeper.pro.status');
    const status = msgs.slice(before).join(' | ');
    assert.match(status, /ChangeKeeper Pro: active/i, 'status says the licence is active: ' + status);
    assert.match(status, /Activated as|Last validated/i, 'status carries the activation details: ' + status);

    // 4. Deactivate: no activation of this machine is left on the customer's key
    restore.splice(0).forEach((r) => r());
    msgs = captureMessages(true);
    await vscode.commands.executeCommand('changekeeper.pro.deactivate');
    assert.ok(
      msgs.some((m) => /Deactivate ChangeKeeper Pro on this computer/i.test(m)),
      'the deactivation was confirmed: ' + JSON.stringify(msgs),
    );
    await pro.refreshScanner();
    const after2 = (await vscode.commands.executeCommand<any>('changekeeper._manager')).all();
    assert.ok(
      after2.every((g: any) => g.deps?.secretScanner === undefined),
      'the Pro scanner is gone after deactivating',
    );
  });
});
