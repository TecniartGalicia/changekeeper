import * as crypto from 'crypto';
import * as fs from 'fs/promises';
import * as http from 'http';
import * as path from 'path';
import * as vscode from 'vscode';
import { HookEvent, parseHookPayload, pickFolder } from '../../core/hooks/events';
import { atomicWrite, processAlive, readJson } from '../../core/store';
import { log } from '../env';

/**
 * Local receiver for agent hooks (Claude Code `type: "http"` hooks; other agents reusing the same file).
 *
 *  - ONE window per machine owns the fixed port (`changekeeper.hooks.port`); the others watch an inbox.
 *  - Every window registers its folders in `<globalStorage>/hooks/windows/<pid>.json`.
 *  - The owner routes each event to the window whose folder contains the file/cwd: itself directly,
 *    others through `<globalStorage>/hooks/inbox/<pid>/<id>.json` (polled every 1.5 s).
 *  - Requests must carry the per-user token (`X-CK-Token`, created once in `<globalStorage>/hooks/token`);
 *    the custom header also forces a CORS preflight, so a web page cannot post to us. Bind is 127.0.0.1 only.
 *  - Nothing is ever answered with content: 204, so a hook can never inject context into the agent.
 */
export interface WindowRegistration {
  pid: number;
  folders: string[];
  since: string;
}

export class HookServer implements vscode.Disposable {
  private server: http.Server | undefined;
  private owner = false;
  private retry: ReturnType<typeof setTimeout> | undefined;
  private inboxTimer: ReturnType<typeof setInterval> | undefined;
  private tokenValue: string | undefined;
  private folders: string[] = [];
  private lastEventAt: string | undefined;
  private eventsSeen = 0;
  private readonly _onEvent = new vscode.EventEmitter<{ folder: string; event: HookEvent }>();
  readonly onEvent = this._onEvent.event;
  private disposed = false;

  constructor(private readonly storageRoot: string, private port: number) {}

  get root(): string {
    return path.join(this.storageRoot, 'hooks');
  }
  get isOwner(): boolean {
    return this.owner;
  }
  get currentPort(): number {
    return this.port;
  }
  get status(): { owner: boolean; port: number; lastEventAt?: string; events: number } {
    return { owner: this.owner, port: this.port, lastEventAt: this.lastEventAt, events: this.eventsSeen };
  }

  /** The per-user token (created on first use). */
  async token(): Promise<string> {
    if (this.tokenValue) return this.tokenValue;
    const file = path.join(this.root, 'token');
    let t = (await fs.readFile(file, 'utf8').catch(() => '')).trim();
    if (!/^[a-f0-9]{48}$/.test(t)) {
      t = crypto.randomBytes(24).toString('hex');
      await atomicWrite(file, t);
    }
    this.tokenValue = t;
    return t;
  }

  async start(folders: string[]): Promise<void> {
    this.folders = folders;
    await fs.mkdir(path.join(this.root, 'windows'), { recursive: true });
    await fs.mkdir(path.join(this.root, 'inbox', String(process.pid)), { recursive: true });
    await this.token();
    await this.register();
    await this.tryBind();
    if (!this.inboxTimer) this.inboxTimer = setInterval(() => void this.drainInbox(), 1500);
  }

  async setFolders(folders: string[]): Promise<void> {
    this.folders = folders;
    await this.register();
  }

  async setPort(port: number): Promise<void> {
    if (port === this.port) return;
    this.port = port;
    await this.closeServer();
    await this.tryBind();
  }

  private async register(): Promise<void> {
    const reg: WindowRegistration = { pid: process.pid, folders: this.folders, since: new Date().toISOString() };
    await atomicWrite(path.join(this.root, 'windows', `${process.pid}.json`), JSON.stringify(reg));
  }

  private async tryBind(): Promise<void> {
    if (this.disposed) return;
    const server = http.createServer((req, res) => void this.handle(req, res));
    server.on('error', (e: any) => {
      if (e && e.code === 'EADDRINUSE') {
        this.owner = false;
        this.server = undefined;
        this.scheduleRetry();
      } else {
        log(`hook server error: ${String(e)}`);
        this.owner = false;
      }
    });
    await new Promise<void>((resolve) => {
      server.listen(this.port, '127.0.0.1', () => {
        this.owner = true;
        this.server = server;
        log(`hook server listening on 127.0.0.1:${this.port} (this window owns the port)`);
        resolve();
      });
      server.once('error', () => resolve());
    });
  }

  private scheduleRetry(): void {
    if (this.retry || this.disposed) return;
    this.retry = setTimeout(() => {
      this.retry = undefined;
      void this.tryBind();
    }, 30_000);
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    try {
      if (req.method === 'OPTIONS') {
        // no CORS headers on purpose: browsers cannot use us
        res.writeHead(403).end();
        return;
      }
      if (req.method !== 'POST' || !(req.url ?? '').startsWith('/hook')) {
        res.writeHead(404).end();
        return;
      }
      const token = req.headers['x-ck-token'];
      if (typeof token !== 'string' || token !== (await this.token())) {
        res.writeHead(401).end();
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const c of req) {
        size += (c as Buffer).length;
        if (size > 512 * 1024) {
          res.writeHead(413).end();
          return;
        }
        chunks.push(c as Buffer);
      }
      let body: unknown;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      } catch {
        res.writeHead(400).end();
        return;
      }
      res.writeHead(204).end();
      const evt = parseHookPayload(body);
      if (evt) await this.route(evt);
    } catch (e) {
      log(`hook request failed: ${String(e)}`);
      try {
        res.writeHead(500).end();
      } catch {
        /* closed */
      }
    }
  }

  /** Owner-side routing: to ourselves, or to the window that has the folder (through its inbox). */
  private async route(evt: HookEvent): Promise<void> {
    this.eventsSeen++;
    this.lastEventAt = new Date().toISOString();
    const probe = evt.filePath ?? evt.cwd;
    if (!probe) return;
    const windows = await this.liveWindows();
    let target: WindowRegistration | undefined;
    let targetFolder: string | undefined;
    for (const w of windows) {
      const f = pickFolder(probe, w.folders);
      if (f && (!targetFolder || f.length > targetFolder.length)) {
        target = w;
        targetFolder = f;
      }
    }
    if (!target || !targetFolder) return;
    if (target.pid === process.pid) {
      this._onEvent.fire({ folder: targetFolder, event: evt });
      return;
    }
    const file = path.join(this.root, 'inbox', String(target.pid), `${Date.now()}-${crypto.randomBytes(3).toString('hex')}.json`);
    await atomicWrite(file, JSON.stringify({ folder: targetFolder, event: evt }));
  }

  private async liveWindows(): Promise<WindowRegistration[]> {
    const dir = path.join(this.root, 'windows');
    let names: string[] = [];
    try {
      names = await fs.readdir(dir);
    } catch {
      return [];
    }
    const out: WindowRegistration[] = [];
    for (const n of names) {
      if (!n.endsWith('.json')) continue;
      const reg = await readJson<WindowRegistration>(path.join(dir, n));
      if (!reg || typeof reg.pid !== 'number') continue;
      if (reg.pid !== process.pid && !processAlive(reg.pid)) {
        // stale registration of a dead window: clean it (and its inbox)
        await fs.rm(path.join(dir, n), { force: true }).catch(() => undefined);
        await fs.rm(path.join(this.root, 'inbox', String(reg.pid)), { recursive: true, force: true }).catch(() => undefined);
        continue;
      }
      out.push(reg);
    }
    return out;
  }

  private async drainInbox(): Promise<void> {
    const dir = path.join(this.root, 'inbox', String(process.pid));
    let names: string[] = [];
    try {
      names = (await fs.readdir(dir)).filter((n) => n.endsWith('.json')).sort();
    } catch {
      return;
    }
    for (const n of names) {
      const file = path.join(dir, n);
      const item = await readJson<{ folder: string; event: HookEvent }>(file);
      await fs.rm(file, { force: true }).catch(() => undefined);
      if (item && item.event) {
        this.eventsSeen++;
        this.lastEventAt = new Date().toISOString();
        this._onEvent.fire(item);
      }
    }
  }

  private async closeServer(): Promise<void> {
    const s = this.server;
    this.server = undefined;
    this.owner = false;
    if (s) await new Promise<void>((r) => s.close(() => r()));
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    if (this.retry) clearTimeout(this.retry);
    if (this.inboxTimer) clearInterval(this.inboxTimer);
    await this.closeServer();
    await fs.rm(path.join(this.root, 'windows', `${process.pid}.json`), { force: true }).catch(() => undefined);
    await fs.rm(path.join(this.root, 'inbox', String(process.pid)), { recursive: true, force: true }).catch(() => undefined);
    this._onEvent.dispose();
  }
}
