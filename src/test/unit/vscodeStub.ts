/**
 * Minimal `vscode` module stub so the unit suite (plain mocha, no Electron) can load the few
 * `src/vscode/*` modules that only need EventEmitter/log/l10n (hooks server + feature).
 * Import this file BEFORE anything that imports 'vscode'.
 */
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Module: any = require('module');

class Emitter<T> {
  private listeners: ((e: T) => void)[] = [];
  readonly event = (listener: (e: T) => void) => {
    this.listeners.push(listener);
    return { dispose: () => (this.listeners = this.listeners.filter((l) => l !== listener)) };
  };
  fire(e: T): void {
    for (const l of [...this.listeners]) l(e);
  }
  dispose(): void {
    this.listeners = [];
  }
}

const noopDisposable = { dispose() {} };
export const stubLog: string[] = [];

const stub = {
  EventEmitter: Emitter,
  Disposable: class {
    constructor(private readonly fn?: () => void) {}
    dispose() {
      this.fn?.();
    }
    static from(...ds: { dispose(): void }[]) {
      return { dispose: () => ds.forEach((d) => d.dispose()) };
    }
  },
  window: {
    createOutputChannel: () => ({ appendLine: (l: string) => stubLog.push(l), show() {}, dispose() {} }),
    showInformationMessage: async () => undefined,
    showWarningMessage: async () => undefined,
    showErrorMessage: async () => undefined,
    showQuickPick: async () => undefined,
    showTextDocument: async () => undefined,
  },
  workspace: {
    getConfiguration: () => ({ get: (_k: string, d: unknown) => d, inspect: () => undefined, update: async () => undefined }),
    onDidChangeWorkspaceFolders: () => noopDisposable,
    onDidChangeConfiguration: () => noopDisposable,
    openTextDocument: async () => ({}),
    workspaceFolders: [],
  },
  commands: { registerCommand: () => noopDisposable, executeCommand: async () => undefined },
  l10n: { t: (s: string, ...args: unknown[]) => s.replace(/\{(\d+)\}/g, (_m, i) => String(args[Number(i)])) },
  Uri: {
    file: (p: string) => ({ fsPath: p, scheme: 'file', path: p.replace(/\\/g, '/'), toString: () => 'file://' + p }),
    from: (x: unknown) => x,
    parse: (x: string) => ({ fsPath: x, scheme: 'file', toString: () => x }),
  },
  ProgressLocation: { Notification: 15, Window: 10 },
};

const M = Module;
if (!M.__ckVscodeStub) {
  M.__ckVscodeStub = true;
  const orig = M._resolveFilename;
  M._resolveFilename = function (request: string, ...rest: unknown[]) {
    if (request === 'vscode') return 'vscode';
    return orig.call(this, request, ...rest);
  };
  require.cache['vscode'] = { id: 'vscode', filename: 'vscode', loaded: true, exports: stub } as any;
}
