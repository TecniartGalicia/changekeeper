import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as path from 'path';
import { sha256 } from './paths';

/**
 * On-disk store for one workspace folder. Layout (under the extension's globalStorage):
 *
 *   workspaces/<key>/
 *     index.json                 { version, folder, activeSessionId, sessions: [{id, startedAt, stoppedAt, ...}] }
 *     lock.json                  { pid, since }  — the window that owns the active session
 *     sessions/<id>.json         review state: changes, hunk states, restores
 *     sessions/<id>.baseline.json  baseline manifest (can be large: one entry per tracked file)
 *     sessions/<id>.materialized.json  path → sha256 of the baseline bytes copied into objects/
 *     objects/<sha256>           content-addressed blobs (baseline copies, before-restore copies)
 *
 * All writes are atomic (tmp + rename) with retries for Windows EBUSY/EPERM.
 */

export interface IndexSessionMeta {
  id: string;
  startedAt: string;
  stoppedAt?: string;
  agent?: string;
  label?: string;
}

export interface StoreIndex {
  version: 1;
  folder: string;
  activeSessionId?: string;
  sessions: IndexSessionMeta[];
}

export interface Lock {
  pid: number;
  since: string;
}

const RETRIES = 6;
let tmpCounter = 0;

async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  let last: unknown;
  for (let i = 0; i < RETRIES; i++) {
    try {
      return await fn();
    } catch (e: any) {
      last = e;
      if (e && (e.code === 'EBUSY' || e.code === 'EPERM' || e.code === 'EACCES' || e.code === 'ENOTEMPTY')) {
        await new Promise((r) => setTimeout(r, 40 * (i + 1) * (i + 1)));
        continue;
      }
      throw e;
    }
  }
  throw last;
}

/**
 * Atomic write: temp file in the same directory + rename. Creates the directory. `mode` applies to
 * the new file (POSIX; ignored on Windows) — pass the previous file's mode to keep e.g. 0600.
 */
export async function atomicWrite(file: string, data: Buffer | string, opts: { mode?: number } = {}): Promise<void> {
  const dir = path.dirname(file);
  await fs.mkdir(dir, { recursive: true });
  // own suffix so watchers/rules can ignore it (HARD_EXCLUDES); counter avoids same-ms collisions
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${Date.now()}.${++tmpCounter}.ck-tmp`);
  try {
    await fs.writeFile(tmp, data, opts.mode !== undefined ? { mode: opts.mode } : undefined);
    await withRetry(() => fs.rename(tmp, file));
  } finally {
    await fs.rm(tmp, { force: true }).catch(() => undefined);
  }
}

/** Reads a JSON file; a corrupt file is set aside as `<name>.corrupt` and treated as absent (never blocks activation). */
export async function readJson<T>(file: string): Promise<T | undefined> {
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch (e: any) {
    if (e && e.code === 'ENOENT') return undefined;
    throw e;
  }
  try {
    return JSON.parse(raw) as T;
  } catch {
    await fs.rename(file, `${file}.${Date.now()}.corrupt`).catch(() => undefined);
    return undefined;
  }
}

export class WorkspaceStore {
  readonly root: string;
  constructor(root: string, readonly folder: string) {
    this.root = root;
  }

  get objectsDir(): string {
    return path.join(this.root, 'objects');
  }
  get sessionsDir(): string {
    return path.join(this.root, 'sessions');
  }
  private get indexFile(): string {
    return path.join(this.root, 'index.json');
  }
  private get lockFile(): string {
    return path.join(this.root, 'lock.json');
  }
  sessionFile(id: string): string {
    return path.join(this.sessionsDir, `${id}.json`);
  }
  baselineFile(id: string): string {
    return path.join(this.sessionsDir, `${id}.baseline.json`);
  }
  materializedFile(id: string): string {
    return path.join(this.sessionsDir, `${id}.materialized.json`);
  }

  async ensure(): Promise<void> {
    await fs.mkdir(this.objectsDir, { recursive: true });
    await fs.mkdir(this.sessionsDir, { recursive: true });
  }

  // ---- objects -------------------------------------------------------------------------------

  async putBlob(data: Buffer): Promise<string> {
    const sha = sha256(data);
    const file = path.join(this.objectsDir, sha);
    if (!fsSync.existsSync(file)) await atomicWrite(file, data);
    return sha;
  }

  async getBlob(sha: string): Promise<Buffer | undefined> {
    try {
      return await fs.readFile(path.join(this.objectsDir, sha));
    } catch (e: any) {
      if (e && e.code === 'ENOENT') return undefined;
      throw e;
    }
  }

  hasBlobSync(sha: string): boolean {
    return fsSync.existsSync(path.join(this.objectsDir, sha));
  }

  async listBlobs(): Promise<{ sha: string; size: number; mtimeMs: number }[]> {
    let names: string[];
    try {
      names = await fs.readdir(this.objectsDir);
    } catch {
      return [];
    }
    const out: { sha: string; size: number; mtimeMs: number }[] = [];
    for (const n of names) {
      if (!/^[0-9a-f]{64}$/.test(n)) continue;
      try {
        const st = await fs.stat(path.join(this.objectsDir, n));
        out.push({ sha: n, size: st.size, mtimeMs: st.mtimeMs });
      } catch {
        /* vanished */
      }
    }
    return out;
  }

  async deleteBlob(sha: string): Promise<void> {
    await fs.rm(path.join(this.objectsDir, sha), { force: true });
  }

  // ---- index / sessions ----------------------------------------------------------------------

  async readIndex(): Promise<StoreIndex> {
    const idx = await readJson<StoreIndex>(this.indexFile);
    if (idx && idx.version === 1) return idx;
    return { version: 1, folder: this.folder, sessions: [] };
  }

  async writeIndex(idx: StoreIndex): Promise<void> {
    await atomicWrite(this.indexFile, JSON.stringify(idx, null, 1));
  }

  async readSessionJson<T>(id: string): Promise<T | undefined> {
    return readJson<T>(this.sessionFile(id));
  }
  async writeSessionJson(id: string, data: unknown): Promise<void> {
    await atomicWrite(this.sessionFile(id), JSON.stringify(data));
  }
  async readBaselineJson<T>(id: string): Promise<T | undefined> {
    return readJson<T>(this.baselineFile(id));
  }
  async writeBaselineJson(id: string, data: unknown): Promise<void> {
    await atomicWrite(this.baselineFile(id), JSON.stringify(data));
  }
  async readMaterialized(id: string): Promise<Record<string, string>> {
    return (await readJson<Record<string, string>>(this.materializedFile(id))) ?? {};
  }
  async writeMaterialized(id: string, data: Record<string, string>): Promise<void> {
    await atomicWrite(this.materializedFile(id), JSON.stringify(data));
  }

  async deleteSessionFiles(id: string): Promise<void> {
    for (const f of [this.sessionFile(id), this.baselineFile(id), this.materializedFile(id)]) {
      await fs.rm(f, { force: true }).catch(() => undefined);
    }
  }

  // ---- lock ----------------------------------------------------------------------------------

  /**
   * Tries to own the folder. Another *live* process holding it → returns its pid; a stale lock
   * (dead pid) is taken over. `isAlive` is injectable for tests.
   */
  async acquireLock(pid: number, isAlive: (pid: number) => boolean = processAlive): Promise<{ ok: true } | { ok: false; ownerPid: number }> {
    const cur = await readJson<Lock>(this.lockFile);
    if (cur && cur.pid !== pid && isAlive(cur.pid)) return { ok: false, ownerPid: cur.pid };
    await atomicWrite(this.lockFile, JSON.stringify({ pid, since: new Date().toISOString() } as Lock));
    return { ok: true };
  }

  /** pid of a *live* process holding the lock, or undefined. */
  async lockOwner(isAlive: (pid: number) => boolean = processAlive): Promise<number | undefined> {
    const cur = await readJson<Lock>(this.lockFile);
    return cur && isAlive(cur.pid) ? cur.pid : undefined;
  }

  async releaseLock(pid: number): Promise<void> {
    const cur = await readJson<Lock>(this.lockFile);
    if (cur && cur.pid === pid) await fs.rm(this.lockFile, { force: true }).catch(() => undefined);
  }

  // ---- purge ---------------------------------------------------------------------------------

  async purge(): Promise<void> {
    await fs.rm(this.root, { recursive: true, force: true });
  }
}

export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    return e && e.code === 'EPERM';
  }
}

/**
 * Garbage collection policy (pure): which closed sessions to drop and which blobs are unreferenced.
 * - The active session is never touched.
 * - Closed sessions older than `retentionDays` are dropped.
 * - If the referenced blobs of the remaining *closed* sessions exceed `maxBytes`, the oldest closed
 *   sessions are dropped until they fit (the active session's blobs never count against the cap).
 */
export function planGc(input: {
  now: number;
  retentionDays: number;
  maxBytes: number;
  activeSessionId?: string;
  sessions: { id: string; stoppedAt?: string; startedAt: string; blobRefs: string[] }[];
  blobSizes: Record<string, number>;
}): { dropSessions: string[]; deleteBlobs: string[] } {
  const cutoff = input.now - input.retentionDays * 86400_000;
  const keep: typeof input.sessions = [];
  const drop: string[] = [];
  for (const s of input.sessions) {
    if (s.id === input.activeSessionId) {
      keep.push(s);
      continue;
    }
    const t = Date.parse(s.stoppedAt ?? s.startedAt);
    if (!Number.isNaN(t) && t < cutoff) drop.push(s.id);
    else keep.push(s);
  }
  // size cap over closed sessions, oldest first
  const closed = keep.filter((s) => s.id !== input.activeSessionId).sort((a, b) => Date.parse(a.stoppedAt ?? a.startedAt) - Date.parse(b.stoppedAt ?? b.startedAt));
  const sizeOf = (s: { blobRefs: string[] }) => s.blobRefs.reduce((n, r) => n + (input.blobSizes[r] ?? 0), 0);
  let total = closed.reduce((n, s) => n + sizeOf(s), 0);
  for (const s of closed) {
    if (total <= input.maxBytes) break;
    drop.push(s.id);
    total -= sizeOf(s);
  }
  const dropSet = new Set(drop);
  const referenced = new Set<string>();
  for (const s of input.sessions) if (!dropSet.has(s.id)) for (const r of s.blobRefs) referenced.add(r);
  const deleteBlobs = Object.keys(input.blobSizes).filter((sha) => !referenced.has(sha));
  return { dropSessions: drop, deleteBlobs };
}
