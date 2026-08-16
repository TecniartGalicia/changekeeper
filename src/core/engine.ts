import { parseCatFileSingle, parseCheckAttr, parseCheckIgnore, parseHead, parseLsFilesStage, parseStatusV2 } from './gitparse';
import { BurstDetector, Limits } from './guardrails';
import { computeHunks, discardHunkOnLines, Hunk } from './hunks';
import { fromRelPosix, gitBlobSha1, newId, pathKey, sha256, toRelPosix } from './paths';
import { PathRules } from './rules/exclude';
import { BaselineManifest, BaselineRow, BaselineSource, counters, FileChange, newSession, reconcileHunks, RestoreRecord, Session, SessionCounters } from './session';
import { planGc, StoreIndex, WorkspaceStore } from './store';
import { decodeText, detectEol, dominantEol, encodeText, fitsLatin1, joinLines, looksBinary, plainLines, splitLines, TextEncoding, TextLine } from './textfile';

/**
 * The engine: everything ChangeKeeper does to a workspace folder, independent of VS Code.
 * I/O goes through injected adapters so unit tests can drive it against a temp folder and a real git.
 */

export interface GitRunner {
  /** Runs git in the folder. Never throws for non-zero exit; throws only if git cannot start. */
  run(args: string[], opts?: { stdin?: Buffer; maxBuffer?: number }): Promise<{ code: number; stdout: Buffer; stderr: string }>;
}

export interface FsStat {
  size: number;
  mtimeMs: number;
  isFile: boolean;
  isDirectory: boolean;
  isSymbolicLink: boolean;
}

export interface FsAdapter {
  readFile(abs: string): Promise<Buffer | undefined>;
  stat(abs: string): Promise<FsStat | undefined>;
  /** atomic write, creating parent directories; `mode` (e.g. 0o755) is applied on POSIX when given */
  writeFile(abs: string, data: Buffer, mode?: number): Promise<void>;
  unlink(abs: string): Promise<void>;
  /** yields regular files under root (relative POSIX paths); `skipDir` is asked for each directory (relative POSIX) */
  walk(root: string, skipDir: (relDir: string) => boolean): AsyncIterable<{ rel: string; size: number; mtimeMs: number }>;
}

export interface OpenDocument {
  text: string;
  dirty: boolean;
}

export interface EngineDeps {
  store: WorkspaceStore;
  /** undefined → the folder is not a git repository (plain mode) */
  git?: GitRunner;
  /**
   * When the folder is a subdirectory of the repository: its path relative to the repo root with a
   * trailing slash (`git rev-parse --show-prefix`). Porcelain status paths are relative to the repo
   * root and must be trimmed; ls-files/check-ignore/check-attr paths are relative to the cwd (folder).
   */
  gitPrefix?: string;
  fs: FsAdapter;
  /** the VS Code layer's view of an open text document, if any */
  openDoc: (rel: string) => OpenDocument | undefined;
  rules: PathRules;
  limits: Limits;
  now?: () => Date;
  log?: (msg: string) => void;
  /** called (synchronously, possibly often) whenever the session state changed; the UI debounces */
  onChanged?: () => void;
  pid?: number;
  /** Pro: scans the added lines of a change; findings are stored (redacted) on the change */
  secretScanner?: (lines: { line: number; text: string }[]) => { label: string; line: number; redacted: string }[];
}

export interface FileView {
  change: FileChange;
  /** undefined when there is no usable text baseline (binary, too large, missing baseline) */
  hunks?: Hunk[];
  baselineText?: string;
  currentText?: string;
  baselineBom?: boolean;
  /** how the current bytes decode (utf8 or latin1 round-trip); discards re-encode the same way */
  encoding?: TextEncoding;
  currentSha: string;
}

interface CurrentRead {
  exists: boolean;
  bytes?: Buffer;
  text?: string;
  sha: string;
  binary?: boolean;
  tooLarge?: boolean;
  open: boolean;
  encoding: TextEncoding;
}

export interface DiscardPlan {
  ok: true;
  rel: string;
  /** 0-based line range [start, end) in the *current* text to replace */
  startLine: number;
  endLine: number;
  /** replacement text (with terminators) for that range */
  replacement: string;
  /** full resulting text (for closed documents / verification) */
  newText: string;
  newBytes: Buffer;
  currentSha: string;
  isOpen: boolean;
}

export type BaselineResolution =
  | { kind: 'bytes'; bytes: Buffer; sha: string }
  | { kind: 'none' } // did not exist at start
  | { kind: 'unavailable'; reason: string };

const CAT_MAX_BUFFER = 512 * 1024 * 1024;
const NUL = String.fromCharCode(0);

export class Engine {
  session: Session | undefined;
  baseline: BaselineManifest | undefined;
  private baselineRows = new Map<string, BaselineRow>(); // pathKey → row
  private materialized: Record<string, string> = {}; // rel → sha256 (store)
  private ignoreCache = new Map<string, boolean>(); // pathKey → ignored (frozen per session)
  private viewCache = new Map<string, FileView>();
  private writingOurselves = new Map<string, string>(); // pathKey → sha we are writing (suppression)
  private agentTouches = new Map<string, string>(); // pathKey → agent tag reported by a hook
  readonly burst: BurstDetector;
  burstQueue: string[] = [];
  private persistTimer: ReturnType<typeof setTimeout> | undefined;
  private materializedDirty = false;
  private readonly now: () => Date;
  private readonly log: (m: string) => void;
  private readonly pid: number;
  private processing = new Map<string, Promise<void>>();

  constructor(readonly folder: string, private readonly deps: EngineDeps) {
    this.now = deps.now ?? (() => new Date());
    this.log = deps.log ?? (() => undefined);
    this.pid = deps.pid ?? process.pid;
    this.burst = new BurstDetector(deps.limits.burstThreshold, deps.limits.burstWindowMs, () => this.now().getTime());
  }

  get isGit(): boolean {
    return !!this.deps.git;
  }

  get counters(): SessionCounters | undefined {
    return this.session ? counters(this.session) : undefined;
  }

  // ------------------------------------------------------------------------------------------
  // lifecycle
  // ------------------------------------------------------------------------------------------

  /** Loads the active session of this folder from disk (after a reload). Returns false if none. */
  async resume(): Promise<boolean> {
    const idx = await this.deps.store.readIndex();
    if (!idx.activeSessionId) return false;
    const s = await this.deps.store.readSessionJson<Session>(idx.activeSessionId);
    const b = await this.deps.store.readBaselineJson<BaselineManifest>(idx.activeSessionId);
    if (!s || !b) return false;
    const lock = await this.deps.store.acquireLock(this.pid);
    if (!lock.ok) throw new EngineError('locked', `Folder is guarded by another window (pid ${lock.ownerPid})`);
    this.session = s;
    this.baseline = b;
    this.indexBaseline();
    this.materialized = await this.deps.store.readMaterialized(s.id);
    this.viewCache.clear();
    return true;
  }

  /**
   * Starts a new session (stopping the current one). The caller must have created its watchers
   * *before* calling this and must feed the queued events afterwards.
   */
  async start(opts: { agent?: string; label?: string; progress?: (msg: string) => void; cancelled?: () => boolean } = {}): Promise<Session> {
    const store = this.deps.store;
    await store.ensure();
    const lock = await store.acquireLock(this.pid);
    if (!lock.ok) throw new EngineError('locked', `Folder is guarded by another window (pid ${lock.ownerPid})`);
    // re-baseline: close the previous session but keep the lock we just (re)acquired
    if (this.session && !this.session.stoppedAt) await this.stop({ keepLock: true });
    const id = newId(this.now());
    const kind: 'git' | 'plain' = this.isGit ? 'git' : 'plain';
    const session = newSession({ id, folder: this.folder, kind, now: this.now(), agent: opts.agent, label: opts.label });
    const manifest: BaselineManifest = { version: 1, sessionId: id, createdAt: session.startedAt, kind, rows: [] };
    this.ignoreCache.clear();
    this.viewCache.clear();
    this.materialized = {};
    this.burst.reset();
    this.burstQueue = [];
    if (kind === 'git') await this.buildGitBaseline(manifest, opts);
    else await this.buildPlainBaseline(manifest, opts);
    this.session = session;
    this.baseline = manifest;
    this.indexBaseline();
    await store.writeBaselineJson(id, manifest);
    await store.writeMaterialized(id, {});
    await store.writeSessionJson(id, session);
    await this.withIndex((idx) => {
      idx.folder = this.folder;
      idx.activeSessionId = id;
      idx.sessions.push({ id, startedAt: session.startedAt, agent: opts.agent, label: opts.label });
    });
    this.deps.onChanged?.();
    return session;
  }

  async stop(opts: { keepLock?: boolean } = {}): Promise<void> {
    if (!this.session) return;
    if (!this.session.stoppedAt) this.session.stoppedAt = this.now().toISOString();
    await this.flush();
    await this.withIndex(async (idx) => {
      const meta = idx.sessions.find((s) => s.id === this.session!.id);
      if (meta) meta.stoppedAt = this.session!.stoppedAt;
      if (idx.activeSessionId === this.session!.id) idx.activeSessionId = undefined;
    });
    if (!opts.keepLock) await this.deps.store.releaseLock(this.pid);
    this.deps.onChanged?.();
  }

  private indexChain: Promise<unknown> = Promise.resolve();
  /** Serialised read-modify-write of index.json (start/stop/gc must not interleave). */
  private withIndex<T>(fn: (idx: StoreIndex) => Promise<T> | T): Promise<T> {
    const run = async () => {
      const idx = await this.deps.store.readIndex();
      const r = await fn(idx);
      await this.deps.store.writeIndex(idx);
      return r;
    };
    const p = this.indexChain.then(run, run);
    this.indexChain = p.catch(() => undefined);
    return p;
  }

  /** Forgets the in-memory session (window closing) without stopping it on disk. */
  async detach(): Promise<void> {
    await this.flush();
    await this.deps.store.releaseLock(this.pid);
  }

  async flush(): Promise<void> {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = undefined;
    }
    if (!this.session) return;
    await this.deps.store.writeSessionJson(this.session.id, this.session);
    if (this.materializedDirty) {
      await this.deps.store.writeMaterialized(this.session.id, this.materialized);
      this.materializedDirty = false;
    }
  }

  /** Persist + notify after an external mutation of the session (validation runs, labels…). */
  touch(): void {
    this.schedulePersist();
  }

  /** A hook told us which agent just edited this path (attribution for the next inspection). */
  noteAgentTouch(rel: string, agent: string): void {
    this.agentTouches.set(pathKey(rel), agent);
    const ch = this.session?.changes[pathKey(rel)];
    if (ch && ch.agent !== agent) {
      ch.agent = agent;
      this.schedulePersist();
    }
  }

  private schedulePersist(): void {
    this.deps.onChanged?.();
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = undefined;
      void this.flush().catch((e) => this.log(`persist failed: ${String(e)}`));
    }, 800);
  }

  /** Maps a repo-root-relative status path to a folder-relative one (undefined when outside the folder). */
  private fromRepoPath(p: string): string | undefined {
    const prefix = this.deps.gitPrefix ?? '';
    if (!prefix) return p;
    if (!p.startsWith(prefix)) return undefined;
    return p.slice(prefix.length);
  }

  private indexBaseline(): void {
    this.baselineRows.clear();
    for (const row of this.baseline?.rows ?? []) this.baselineRows.set(pathKey(row[0]), row);
  }

  // ------------------------------------------------------------------------------------------
  // baseline construction
  // ------------------------------------------------------------------------------------------

  private async buildGitBaseline(manifest: BaselineManifest, opts: { progress?: (msg: string) => void; cancelled?: () => boolean }): Promise<void> {
    const git = this.deps.git!;
    const limits = this.deps.limits;
    opts.progress?.('index');
    const head = await git.run(['rev-parse', 'HEAD']);
    manifest.head = parseHead(head.stdout.toString('utf8'));
    // 1) gitlinks (submodule roots) — their files live in another object database; we cannot materialise them
    const lsTop = await git.run(['ls-files', '-s', '-z'], { maxBuffer: 256 * 1024 * 1024 });
    if (lsTop.code !== 0) throw new EngineError('git', `git ls-files failed: ${lsTop.stderr.trim()}`);
    const submodules: string[] = [];
    for (const e of parseLsFilesStage(lsTop.stdout)) if (e.mode === '160000') submodules.push(e.path + '/');
    const inSubmodule = (p: string) => submodules.some((s) => p.startsWith(s));
    // 2) every tracked file (recursing into submodules so nothing inside them looks "new" later)
    const ls = submodules.length ? await git.run(['ls-files', '-s', '-z', '--recurse-submodules'], { maxBuffer: 256 * 1024 * 1024 }) : lsTop;
    if (ls.code !== 0) throw new EngineError('git', `git ls-files failed: ${ls.stderr.trim()}`);
    const rows = new Map<string, BaselineRow>();
    const unmerged = new Set<string>();
    for (const e of parseLsFilesStage(ls.stdout)) {
      if (e.mode === '160000') continue;
      if (e.stage !== 0) {
        unmerged.add(e.path);
        continue;
      }
      if (inSubmodule(e.path)) {
        rows.set(pathKey(e.path), [e.path, 'unavailable', 'submodule', e.mode]);
        continue;
      }
      if (e.mode === '120000') {
        rows.set(pathKey(e.path), [e.path, 'unavailable', 'symlink', e.mode]);
        continue;
      }
      rows.set(pathKey(e.path), [e.path, 'git-blob', e.oid, e.mode]);
    }
    // 3) working tree status: dirty and untracked files are copied; ignored files only when critical
    opts.progress?.('status');
    const statusArgs = ['status', '--porcelain=v2', '-z', '--untracked-files=all', '--ignored=matching', '--no-renames', '--', '.'];
    const st1 = await git.run(statusArgs, { maxBuffer: 256 * 1024 * 1024 });
    if (st1.code !== 0) throw new EngineError('git', `git status failed: ${st1.stderr.trim()}`);
    const first = this.localStatus(parseStatusV2(st1.stdout));
    let copied = 0;
    let copiedBytes = 0;
    let skipped = 0;
    const toCopy: string[] = [];
    for (const e of first) {
      if (inSubmodule(e.path)) continue;
      if (e.kind === 'ignored') {
        // `--ignored=matching` lists ignored files (and whole ignored dirs with a trailing slash)
        if (e.path.endsWith('/')) continue;
        if (this.deps.rules.isCritical(e.path)) toCopy.push(e.path);
        continue;
      }
      if (e.kind === 'untracked') {
        const d = this.deps.rules.decide(e.path, false);
        if (!d.watch) continue;
        toCopy.push(e.path);
        continue;
      }
      if (e.kind === 'unmerged') {
        toCopy.push(e.path);
        continue;
      }
      // changed (tracked)
      if (e.y === 'D') rows.set(pathKey(e.path), [e.path, 'missing', '', '']);
      else if (e.y !== '.') toCopy.push(e.path);
      // else: only the index differs from HEAD; the working tree equals the index blob already in rows
    }
    for (const p of unmerged) if (!toCopy.includes(p) && !inSubmodule(p)) toCopy.push(p);
    // 4) copy, remembering size/mtime so a write during the copy window can be detected
    const copiedStat = new Map<string, { size: number; mtimeMs: number }>();
    let n = 0;
    for (const rel of toCopy) {
      if (opts.cancelled?.()) throw new EngineError('cancelled', 'cancelled');
      if (++n % 50 === 0) opts.progress?.(`copy ${n}/${toCopy.length}`);
      const abs = fromRelPosix(this.folder, rel);
      const stat = await this.deps.fs.stat(abs);
      if (!stat || !stat.isFile) {
        rows.set(pathKey(rel), [rel, 'missing', '', '']);
        continue;
      }
      if (stat.isSymbolicLink) {
        rows.set(pathKey(rel), [rel, 'unavailable', 'symlink', '']);
        continue;
      }
      if (stat.size > limits.maxFileBytes) {
        rows.set(pathKey(rel), [rel, 'unavailable', 'large', '']);
        skipped++;
        continue;
      }
      if (copied >= limits.baselineMaxFiles || copiedBytes + stat.size > limits.baselineMaxBytes) {
        rows.set(pathKey(rel), [rel, 'unavailable', 'limit', '']);
        skipped++;
        continue;
      }
      const buf = await this.deps.fs.readFile(abs);
      if (!buf) {
        rows.set(pathKey(rel), [rel, 'missing', '', '']);
        continue;
      }
      const sha = await this.deps.store.putBlob(buf);
      rows.set(pathKey(rel), [rel, 'store', sha, '']);
      copiedStat.set(rel, { size: buf.length, mtimeMs: stat.mtimeMs });
      copied++;
      copiedBytes += buf.length;
    }
    // 5) second status + re-stat: anything that moved while we were working is uncertain
    const st2 = await git.run(statusArgs, { maxBuffer: 256 * 1024 * 1024 });
    if (st2.code === 0) {
      const firstSet = new Set(first.map((e) => `${e.kind}:${e.x}${e.y}:${e.path}`));
      for (const e of this.localStatus(parseStatusV2(st2.stdout))) {
        if (e.kind === 'ignored' || inSubmodule(e.path)) continue;
        const key = `${e.kind}:${e.x}${e.y}:${e.path}`;
        if (!firstSet.has(key)) {
          const cur = rows.get(pathKey(e.path));
          // keep the previous reference and remember where it pointed (row[3] = previous source)
          if (!cur || cur[1] !== 'missing') rows.set(pathKey(e.path), [e.path, 'uncertain', cur?.[2] ?? '', cur ? cur[1] : '']);
        }
      }
    }
    for (const [rel, s0] of copiedStat) {
      const s1 = await this.deps.fs.stat(fromRelPosix(this.folder, rel));
      if (!s1 || s1.size !== s0.size || s1.mtimeMs !== s0.mtimeMs) {
        const cur = rows.get(pathKey(rel));
        if (cur && cur[1] === 'store') rows.set(pathKey(rel), [rel, 'uncertain', cur[2], 'store']);
      }
    }
    manifest.rows = [...rows.values()];
    manifest.skipped = skipped;
    this.log(`git baseline: ${manifest.rows.length} rows, ${copied} copied (${copiedBytes} bytes), ${skipped} skipped, ${submodules.length} submodule(s)`);
  }

  /** Status entries trimmed to the folder (drops entries outside it, rewrites paths). */
  private localStatus<T extends { path: string; origPath?: string }>(entries: T[]): T[] {
    const out: T[] = [];
    for (const e of entries) {
      const p = this.fromRepoPath(e.path);
      if (p === undefined) continue;
      out.push({ ...e, path: p, origPath: e.origPath ? this.fromRepoPath(e.origPath) : undefined });
    }
    return out;
  }

  private async buildPlainBaseline(manifest: BaselineManifest, opts: { progress?: (msg: string) => void; cancelled?: () => boolean }): Promise<void> {
    const limits = this.deps.limits;
    let copied = 0;
    let copiedBytes = 0;
    let skipped = 0;
    let n = 0;
    const rows: BaselineRow[] = [];
    // hard/heavy dirs are skipped; other excluded dirs are walked because critical files may live inside
    for await (const f of this.deps.fs.walk(this.folder, (dir) => this.deps.rules.skipDir(dir))) {
      if (opts.cancelled?.()) throw new EngineError('cancelled', 'cancelled');
      if (++n % 200 === 0) opts.progress?.(`copy ${n}`);
      const d = this.deps.rules.decide(f.rel, false);
      if (!d.watch) continue;
      if (f.size > limits.maxFileBytes) {
        rows.push([f.rel, 'unavailable', 'large', '']);
        skipped++;
        continue;
      }
      if (copied >= limits.baselineMaxFiles || copiedBytes + f.size > limits.baselineMaxBytes) {
        rows.push([f.rel, 'unavailable', 'limit', '']);
        skipped++;
        continue;
      }
      const buf = await this.deps.fs.readFile(fromRelPosix(this.folder, f.rel));
      if (!buf) continue;
      const sha = await this.deps.store.putBlob(buf);
      rows.push([f.rel, 'store', sha, '']);
      copied++;
      copiedBytes += buf.length;
    }
    manifest.rows = rows;
    manifest.skipped = skipped;
    this.log(`plain baseline: ${rows.length} rows, ${copied} copied (${copiedBytes} bytes), ${skipped} skipped`);
  }

  // ------------------------------------------------------------------------------------------
  // baseline resolution
  // ------------------------------------------------------------------------------------------

  baselineRow(rel: string): BaselineRow | undefined {
    return this.baselineRows.get(pathKey(rel));
  }

  /** Bytes the file had at session start (materialising the git blob on first use). */
  async resolveBaseline(rel: string): Promise<BaselineResolution> {
    const row = this.baselineRow(rel);
    if (!row) return { kind: 'none' };
    const [, source, ref] = row;
    if (source === 'missing') return { kind: 'none' };
    if (source === 'unavailable') return { kind: 'unavailable', reason: ref || 'unavailable' };
    if (source === 'store' || (source === 'uncertain' && row[3] === 'store')) {
      const bytes = await this.deps.store.getBlob(ref);
      return bytes ? { kind: 'bytes', bytes, sha: ref } : { kind: 'unavailable', reason: 'lost' };
    }
    if (source === 'uncertain' && row[3] !== 'git-blob') return { kind: 'unavailable', reason: 'uncertain' };
    // git-blob (or uncertain over a git-blob): materialise by the OID captured at session start
    const mat = this.materialized[rel];
    if (mat && !mat.startsWith('!')) {
      const bytes = await this.deps.store.getBlob(mat);
      if (bytes) return { kind: 'bytes', bytes, sha: mat };
    }
    if (!ref) return { kind: 'unavailable', reason: 'uncertain' };
    return this.materialize(rel, ref);
  }

  private async materialize(rel: string, oid: string): Promise<BaselineResolution> {
    const git = this.deps.git;
    if (!git) return { kind: 'unavailable', reason: 'no-git' };
    // negative results are cached per session ("!reason") so we do not spawn git again for the same file
    const cached = this.materialized[rel];
    if (cached && cached.startsWith('!')) return { kind: 'unavailable', reason: cached.slice(1) };
    const negative = (reason: string): BaselineResolution => {
      this.materialized[rel] = '!' + reason;
      this.materializedDirty = true;
      this.schedulePersist();
      return { kind: 'unavailable', reason };
    };
    // LFS pointers: never smudge (may hit the network); such files have no text baseline
    const attr = await git.run(['check-attr', 'filter', '-z', '--stdin'], { stdin: Buffer.from(rel + '\0') });
    if (attr.code === 0) {
      const a = parseCheckAttr(attr.stdout).get(rel);
      if (a && a.filter && a.filter !== 'unspecified' && a.filter !== 'unset') return negative(`filter:${a.filter}`);
    }
    // size gate before reading the object (a tracked 300 MB binary must not be pulled into memory)
    const check = await git.run(['cat-file', '--batch-check'], { stdin: Buffer.from(`${oid}\n`) });
    const header = check.stdout.toString('utf8').trim().split(' ');
    if (header[1] === 'missing') return negative('blob-missing');
    const size = Number(header[2]);
    if (Number.isFinite(size) && size > this.deps.limits.maxFileBytes) return negative('large');
    // path for attribute lookup is repo-root-relative (cat-file resolves it against the work tree root)
    const attrPath = (this.deps.gitPrefix ?? '') + rel;
    const out = await git.run(['cat-file', '--batch', '--filters'], { stdin: Buffer.from(`${oid} ${attrPath}\n`), maxBuffer: CAT_MAX_BUFFER });
    let rec = parseCatFileSingle(out.stdout);
    if (!rec || !rec.content) {
      // fall back to the raw blob (e.g. path-dependent filters could not be resolved)
      const raw = await git.run(['cat-file', '--batch'], { stdin: Buffer.from(`${oid}\n`), maxBuffer: CAT_MAX_BUFFER });
      rec = parseCatFileSingle(raw.stdout);
      if (!rec || !rec.content) return negative('blob-missing');
    }
    const sha = await this.deps.store.putBlob(rec.content);
    this.materialized[rel] = sha;
    this.materializedDirty = true;
    this.schedulePersist();
    return { kind: 'bytes', bytes: rec.content, sha };
  }

  /** Baseline sha without reading bytes when it is already known (store rows, materialised blobs). */
  private knownBaselineSha(rel: string): string | undefined {
    const row = this.baselineRow(rel);
    if (!row) return undefined;
    if (row[1] === 'store' || (row[1] === 'uncertain' && row[3] === 'store')) return row[2];
    const mat = this.materialized[rel];
    if (mat && !mat.startsWith('!')) return mat;
    return undefined;
  }

  // ------------------------------------------------------------------------------------------
  // change detection
  // ------------------------------------------------------------------------------------------

  /** Converts an absolute path to the session-relative form, or undefined when outside the folder. */
  relOf(abs: string): string | undefined {
    const rel = toRelPosix(this.folder, abs);
    return rel === undefined || rel === '' ? undefined : rel;
  }

  /** Whether this path is watched at all (rules + frozen ignore decision). Async because of git check-ignore. */
  async shouldWatch(rel: string): Promise<{ watch: boolean; critical: boolean }> {
    const d0 = this.deps.rules.decide(rel, false);
    if (!d0.watch || d0.critical) return { watch: d0.watch, critical: d0.critical };
    if (this.baselineRow(rel)) return { watch: true, critical: false }; // tracked at start → never ignored
    const k = pathKey(rel);
    let ignored = this.ignoreCache.get(k);
    if (ignored === undefined) {
      ignored = await this.isGitIgnored(rel);
      this.ignoreCache.set(k, ignored);
    }
    const d = this.deps.rules.decide(rel, ignored);
    return { watch: d.watch, critical: d.critical };
  }

  private async isGitIgnored(rel: string): Promise<boolean> {
    if (!this.deps.git) return false;
    try {
      const out = await this.deps.git.run(['check-ignore', '--stdin', '-z'], { stdin: Buffer.from(rel + NUL) });
      return parseCheckIgnore(out.stdout).has(rel);
    } catch {
      return false;
    }
  }

  /**
   * Resolves the ignore decision of many paths in ONE git process (a spawn per path costs ~15 ms on
   * Windows). Paths already decided, tracked at baseline, or settled by rules are skipped.
   */
  async prefetchIgnore(rels: readonly string[]): Promise<void> {
    if (!this.deps.git) return;
    const ask: string[] = [];
    for (const rel of rels) {
      const k = pathKey(rel);
      if (this.ignoreCache.has(k) || this.baselineRow(rel)) continue;
      const d0 = this.deps.rules.decide(rel, false);
      if (!d0.watch || d0.critical) continue;
      ask.push(rel);
    }
    if (!ask.length) return;
    try {
      const out = await this.deps.git.run(['check-ignore', '--stdin', '-z'], { stdin: Buffer.from(ask.join(NUL) + NUL), maxBuffer: 64 * 1024 * 1024 });
      const ignored = parseCheckIgnore(out.stdout);
      for (const rel of ask) this.ignoreCache.set(pathKey(rel), ignored.has(rel));
    } catch {
      /* fall back to per-path checks */
    }
  }

  /** Paths (baseline rows and current changes) below a directory — used when a directory is moved or removed. */
  knownPathsUnder(relDir: string): string[] {
    const prefix = relDir.endsWith('/') ? relDir : relDir + '/';
    const pk = pathKey(prefix);
    const out = new Set<string>();
    for (const row of this.baseline?.rows ?? []) if (pathKey(row[0]).startsWith(pk)) out.add(row[0]);
    for (const c of this.changes()) if (pathKey(c.path).startsWith(pk)) out.add(c.path);
    return [...out];
  }

  /**
   * Main entry point for the watcher/document events. Serialised per path. Returns the resulting
   * change (or undefined when the file equals its baseline / is not watched).
   */
  async handlePath(rel: string, opts: { fromBurstQueue?: boolean } = {}): Promise<FileChange | undefined> {
    if (!this.session || this.session.stoppedAt) return undefined;
    const k = pathKey(rel);
    const prev = this.processing.get(k) ?? Promise.resolve();
    let result: FileChange | undefined;
    const p = prev
      .catch(() => undefined)
      .then(async () => {
        result = await this.processPath(rel, opts);
      });
    this.processing.set(k, p);
    try {
      await p;
    } finally {
      if (this.processing.get(k) === p) this.processing.delete(k);
    }
    return result;
  }

  private async processPath(rel: string, opts: { fromBurstQueue?: boolean }): Promise<FileChange | undefined> {
    const session = this.session!;
    const k = pathKey(rel);
    const existing = session.changes[k];
    const w = await this.shouldWatch(rel);
    if (!w.watch) return undefined;
    // burst guard applies to paths we do not know yet
    if (!existing && !opts.fromBurstQueue) {
      if (this.burst.paused) {
        this.burstQueue.push(rel);
        return undefined;
      }
      if (this.burst.register(k)) {
        this.burstQueue.push(rel);
        this.log(`burst guard tripped (${this.burst.windowCount} new paths)`);
        this.deps.onChanged?.();
        return undefined;
      }
    }
    if (!existing && Object.keys(session.changes).length >= this.deps.limits.maxFilesPerSession) {
      session.notes = session.notes ?? [];
      if (!session.notes.includes('max-files')) session.notes.push('max-files');
      return undefined;
    }
    const abs = fromRelPosix(this.folder, rel);
    const current = await this.readCurrent(rel, abs);
    if (this.writingOurselves.get(k) === current.sha) this.writingOurselves.delete(k);
    // nothing moved since the last inspection (typing pauses, CodeLens/decoration refreshes): keep the cached view
    if (existing && existing.currentSha === current.sha && this.viewCache.has(k) && (current.exists ? current.sha !== '' : existing.kind === 'D')) return existing;
    const nowIso = this.now().toISOString();
    const row = this.baselineRow(rel);
    // Fast path: a clean tracked file re-saved with identical bytes matches its index blob without
    // materialising anything (exact only for SHA-1 OIDs; otherwise we fall through to the byte comparison).
    if (current.exists && current.bytes && row && row[1] === 'git-blob' && row[2].length === 40 && !this.materialized[rel] && gitBlobSha1(current.bytes) === row[2]) {
      return this.dropChange(k, existing);
    }
    const base = await this.resolveBaseline(rel);
    const uncertain = row?.[1] === 'uncertain';
    // A file whose content moved on since the user pressed "accept file" is not reviewed any more.
    if (existing && existing.currentSha !== undefined && existing.currentSha !== current.sha) existing.fileAccepted = false;
    // ---- deleted now
    if (!current.exists) {
      if (base.kind === 'none') return this.dropChange(k, existing);
      const ch: FileChange = existing ?? { path: rel, kind: 'D', critical: w.critical, hunks: {}, firstSeenAt: nowIso, lastChangeAt: nowIso };
      ch.kind = 'D';
      ch.currentSha = '';
      ch.lastChangeAt = nowIso;
      ch.baselineUnavailable = base.kind === 'unavailable' ? base.reason : undefined;
      ch.eolOnly = undefined;
      reconcileHunks(ch, []);
      // symmetric rename detection: an added file with these baseline bytes becomes a rename of this one
      if (base.kind === 'bytes') {
        for (const other of Object.values(session.changes)) {
          if (other.kind === 'A' && other.currentSha === base.sha) {
            other.kind = 'R';
            other.renamedFrom = rel;
          }
        }
      }
      session.changes[k] = ch;
      this.viewCache.delete(k);
      this.schedulePersist();
      return ch;
    }
    // ---- exists now
    if (base.kind === 'bytes' && current.sha === base.sha) return this.dropChange(k, existing);
    const ch: FileChange = existing ?? { path: rel, kind: 'A', critical: w.critical, hunks: {}, firstSeenAt: nowIso, lastChangeAt: nowIso };
    ch.path = rel;
    ch.critical = w.critical;
    ch.lastChangeAt = nowIso;
    ch.currentSha = current.sha;
    ch.binary = current.binary;
    ch.tooLarge = current.tooLarge;
    ch.baselineUnavailable = base.kind === 'unavailable' ? base.reason : undefined;
    ch.baselineUncertain = uncertain || undefined;
    ch.eolOnly = undefined;
    const touchedBy = this.agentTouches.get(k);
    if (touchedBy) ch.agent = touchedBy;
    let hunkBase: BaselineResolution = base;
    if (base.kind === 'none') {
      // new file; a rename when a deleted file has exactly these bytes as baseline
      const renamedFrom = await this.findDeletedTwin(current.sha, rel);
      if (renamedFrom) {
        ch.kind = 'R';
        ch.renamedFrom = renamedFrom;
      } else {
        ch.kind = 'A';
        ch.renamedFrom = undefined;
      }
    } else {
      ch.kind = 'M';
      ch.renamedFrom = undefined;
    }
    // a renamed file is compared with the baseline of its source (same content at rename time; later edits show as hunks)
    if (ch.kind === 'R' && ch.renamedFrom) {
      const rb = await this.resolveBaseline(ch.renamedFrom);
      if (rb.kind === 'bytes') hunkBase = rb;
    }
    // hunks
    let hunks: Hunk[] | undefined;
    if (hunkBase.kind === 'bytes' && !current.binary && !current.tooLarge && !looksBinary(hunkBase.bytes) && current.text !== undefined) {
      const bt = decodeText(hunkBase.bytes);
      const baseLines = splitLines(bt.text);
      const curLines = splitLines(current.text);
      hunks = computeHunks(plainLines(baseLines), plainLines(curLines));
      if (hunks.length === 0) ch.eolOnly = true; // bytes differ but no line differs: EOL / BOM / encoding only
      this.viewCache.set(k, { change: ch, hunks, baselineText: bt.text, currentText: current.text, baselineBom: bt.bom, encoding: current.encoding, currentSha: current.sha });
    } else if (hunkBase.kind === 'none' && !current.binary && !current.tooLarge && current.text !== undefined) {
      const curLines = splitLines(current.text);
      hunks = computeHunks([], plainLines(curLines));
      this.viewCache.set(k, { change: ch, hunks, baselineText: '', currentText: current.text, baselineBom: false, encoding: current.encoding, currentSha: current.sha });
    } else {
      this.viewCache.set(k, { change: ch, currentSha: current.sha });
    }
    reconcileHunks(ch, hunks ?? []);
    if (this.deps.secretScanner && hunks && hunks.length) {
      const added: { line: number; text: string }[] = [];
      for (const h of hunks) {
        let line = h.newLines === 0 ? h.newStart : h.newStart - 1;
        for (const l of h.lines) {
          if (l.type === '-') continue;
          if (l.type === '+') added.push({ line: line + 1, text: l.text });
          line++;
        }
      }
      const found = this.deps.secretScanner(added);
      ch.secrets = found.length ? found.slice(0, 20) : undefined;
    } else if (!this.deps.secretScanner) {
      ch.secrets = undefined;
    }
    session.changes[k] = ch;
    this.schedulePersist();
    return ch;
  }

  private dropChange(k: string, existing: FileChange | undefined): undefined {
    if (existing) {
      // a rename whose source reappears is a plain addition again
      if (existing.kind === 'D' && this.session) {
        for (const other of Object.values(this.session.changes)) {
          if (other.kind === 'R' && other.renamedFrom && pathKey(other.renamedFrom) === k) {
            other.kind = 'A';
            other.renamedFrom = undefined;
          }
        }
      }
      delete this.session!.changes[k];
      this.viewCache.delete(k);
      this.schedulePersist();
    }
    return undefined;
  }

  private async findDeletedTwin(sha: string, rel: string): Promise<string | undefined> {
    if (!this.session) return undefined;
    for (const c of Object.values(this.session.changes)) {
      if (c.kind !== 'D' || pathKey(c.path) === pathKey(rel)) continue;
      const known = this.knownBaselineSha(c.path);
      if (known !== undefined) {
        if (known === sha) return c.path;
        continue;
      }
      const b = await this.resolveBaseline(c.path);
      if (b.kind === 'bytes' && b.sha === sha) return c.path;
    }
    return undefined;
  }

  private async readCurrent(rel: string, abs: string): Promise<CurrentRead> {
    const doc = this.deps.openDoc(rel);
    if (doc) {
      // The editor buffer is the truth for open documents. Encode it the way the disk file is encoded
      // (BOM / latin1 round-trip) so hashes line up with disk and baseline bytes.
      const disk = await this.deps.fs.readFile(abs);
      if (!disk && !doc.dirty) return { exists: false, sha: '', open: true, encoding: 'utf8' }; // deleted on disk, clean buffer → deleted
      let bom = false;
      let encoding: TextEncoding = 'utf8';
      if (disk) {
        const d = decodeText(disk);
        bom = d.bom;
        encoding = d.encoding;
        if (encoding === 'latin1' && !fitsLatin1(doc.text)) encoding = 'utf8';
      }
      const bytes = encodeText(doc.text, bom, encoding);
      return { exists: true, bytes, text: doc.text, sha: sha256(bytes), open: true, encoding, tooLarge: bytes.length > this.deps.limits.maxFileBytes };
    }
    const stat = await this.deps.fs.stat(abs);
    if (!stat || !stat.isFile) return { exists: false, sha: '', open: false, encoding: 'utf8' };
    if (stat.size > this.deps.limits.maxFileBytes) {
      // hash it anyway (streaming would be nicer; files this size are rare)
      const big = await this.deps.fs.readFile(abs);
      return { exists: true, sha: big ? sha256(big) : `size:${stat.size}:${stat.mtimeMs}`, tooLarge: true, open: false, encoding: 'utf8' };
    }
    const bytes = await this.deps.fs.readFile(abs);
    if (!bytes) return { exists: false, sha: '', open: false, encoding: 'utf8' };
    if (looksBinary(bytes)) return { exists: true, bytes, sha: sha256(bytes), binary: true, open: false, encoding: 'utf8' };
    const d = decodeText(bytes);
    return { exists: true, bytes, text: d.text, sha: sha256(bytes), open: false, encoding: d.encoding };
  }

  /** Drains the burst queue after the user chose to track the paths. */
  async resumeBurst(mode: 'track' | 'ignore'): Promise<number> {
    const q = this.burstQueue;
    this.burstQueue = [];
    this.burst.reset();
    if (mode === 'ignore') {
      if (this.session) this.session.burstIgnored = (this.session.burstIgnored ?? 0) + q.length;
      this.schedulePersist();
      return 0;
    }
    await this.prefetchIgnore(q);
    let n = 0;
    for (const rel of q) {
      await this.handlePath(rel, { fromBurstQueue: true });
      n++;
    }
    return n;
  }

  // ------------------------------------------------------------------------------------------
  // views
  // ------------------------------------------------------------------------------------------

  /** Change + hunks for a file, recomputed if the file moved on since the last inspection. */
  async view(rel: string): Promise<FileView | undefined> {
    if (!this.session) return undefined;
    const k = pathKey(rel);
    const ch = this.session.changes[k];
    if (!ch) return undefined;
    const cached = this.viewCache.get(k);
    const abs = fromRelPosix(this.folder, rel);
    const cur = await this.readCurrent(rel, abs);
    if (cached && cached.currentSha === cur.sha) return cached;
    await this.handlePath(rel);
    return this.viewCache.get(k);
  }

  changes(): FileChange[] {
    return this.session ? Object.values(this.session.changes) : [];
  }

  // ------------------------------------------------------------------------------------------
  // review actions
  // ------------------------------------------------------------------------------------------

  setHunkStatus(rel: string, hunkId: string, status: 'accepted' | 'pending'): void {
    const ch = this.session?.changes[pathKey(rel)];
    if (!ch || !(hunkId in ch.hunks)) return;
    ch.hunks[hunkId] = status;
    if (status === 'pending') ch.fileAccepted = false;
    this.schedulePersist();
  }

  acceptFile(rel: string): void {
    const ch = this.session?.changes[pathKey(rel)];
    if (!ch) return;
    ch.fileAccepted = true;
    for (const id of Object.keys(ch.hunks)) if (ch.hunks[id] === 'pending') ch.hunks[id] = 'accepted';
    this.schedulePersist();
  }

  acceptAll(): void {
    for (const ch of this.changes()) this.acceptFile(ch.path);
    if (this.session) this.session.reviewedAt = this.now().toISOString();
    this.schedulePersist();
  }

  /** Computes what discarding a hunk means for the current text. Does not write. */
  async planDiscard(rel: string, hunkId: string): Promise<DiscardPlan | { ok: false; reason: 'stale' | 'no-baseline' | 'no-change' | 'binary' }> {
    const v = await this.view(rel);
    if (!v) return { ok: false, reason: 'no-change' };
    if (!v.hunks || v.baselineText === undefined || v.currentText === undefined) return { ok: false, reason: v.change.binary ? 'binary' : 'no-baseline' };
    const h = v.hunks.find((x) => x.id === hunkId);
    if (!h) return { ok: false, reason: 'stale' };
    const curLines = splitLines(v.currentText);
    const baseLines = splitLines(v.baselineText);
    const eol = dominantEol(curLines, dominantEol(baseLines, '\n'));
    const out = discardHunkOnLines(curLines, baseLines, h, eol);
    if (!out) return { ok: false, reason: 'stale' };
    const startLine = h.newLines === 0 ? h.newStart : h.newStart - 1;
    const endLine = startLine + h.newLines; // exclusive
    const replacementLines = out.slice(startLine, startLine + h.oldLines);
    // When the hunk touched the end of file, the terminator of the line *before* may have changed too;
    // callers use `newText` for closed documents and the range for open ones. Include the previous line
    // in the range in that case so the edit is exact.
    let rangeStart = startLine;
    let replacement = joinLines(replacementLines);
    if (startLine > 0 && out[startLine - 1].eol !== curLines[startLine - 1].eol) {
      rangeStart = startLine - 1;
      replacement = joinLines([out[startLine - 1]]) + replacement;
    }
    const newText = joinLines(out);
    // re-encode exactly like the current bytes decode (BOM kept, latin1 round-trip) so nothing outside the hunk changes
    const disk = await this.deps.fs.readFile(fromRelPosix(this.folder, rel));
    const diskInfo = disk ? decodeText(disk) : { bom: false, encoding: v.encoding ?? 'utf8' };
    const encoding: TextEncoding = diskInfo.encoding === 'latin1' && fitsLatin1(newText) ? 'latin1' : 'utf8';
    return {
      ok: true,
      rel,
      startLine: rangeStart,
      endLine,
      replacement,
      newText,
      newBytes: encodeText(newText, diskInfo.bom, encoding),
      currentSha: v.currentSha,
      isOpen: this.deps.openDoc(rel) !== undefined,
    };
  }

  /** Writes a discard plan to disk (closed documents). Marks the hunk discarded. */
  async applyDiscardToDisk(plan: DiscardPlan, hunkId: string): Promise<{ ok: boolean; reason?: 'stale' }> {
    const k = pathKey(plan.rel);
    const abs = fromRelPosix(this.folder, plan.rel);
    // the file may have moved on between planning and applying (the agent keeps writing)
    const now = await this.readCurrent(plan.rel, abs);
    if (!now.exists || now.sha !== plan.currentSha) {
      await this.handlePath(plan.rel);
      return { ok: false, reason: 'stale' };
    }
    // keep what we overwrite so "Undo last restore" can put it back
    const beforeSha = now.bytes ? await this.deps.store.putBlob(now.bytes) : '';
    const afterSha = sha256(plan.newBytes);
    this.writingOurselves.set(k, afterSha);
    await this.deps.fs.writeFile(abs, plan.newBytes);
    this.markDiscarded(plan.rel, hunkId);
    if (this.session) {
      this.session.restores.push({ at: this.now().toISOString(), kind: 'hunk', before: { [plan.rel]: beforeSha }, after: { [plan.rel]: afterSha }, paths: [plan.rel] });
    }
    await this.handlePath(plan.rel);
    return { ok: true };
  }

  /** After the VS Code layer applied the plan through WorkspaceEdit. */
  markDiscarded(rel: string, hunkId: string): void {
    const ch = this.session?.changes[pathKey(rel)];
    if (ch && hunkId in ch.hunks) {
      ch.hunks[hunkId] = 'discarded';
      this.schedulePersist();
    }
  }

  /** Marks that we are about to write these bytes so the watcher echo is not treated as an agent change. */
  expectOwnWrite(rel: string, bytes: Buffer): void {
    this.writingOurselves.set(pathKey(rel), sha256(bytes));
  }

  // ------------------------------------------------------------------------------------------
  // restore
  // ------------------------------------------------------------------------------------------

  /**
   * Restores files to their baseline. Every overwritten/deleted current version is copied into the
   * store first, so the operation can be undone. Returns per-path outcomes.
   */
  async restore(rels: string[], kind: 'file' | 'session'): Promise<{ record?: RestoreRecord; results: { rel: string; status: 'restored' | 'deleted' | 'skipped'; reason?: string }[] }> {
    if (!this.session) return { results: [] };
    const results: { rel: string; status: 'restored' | 'deleted' | 'skipped'; reason?: string }[] = [];
    const before: Record<string, string> = {};
    const done: string[] = [];
    for (const rel of rels) {
      const abs = fromRelPosix(this.folder, rel);
      const base = await this.resolveBaseline(rel);
      if (base.kind === 'unavailable') {
        results.push({ rel, status: 'skipped', reason: base.reason });
        continue;
      }
      const cur = await this.deps.fs.readFile(abs);
      before[rel] = cur ? await this.deps.store.putBlob(cur) : '';
      try {
        if (base.kind === 'none') {
          if (cur) {
            this.writingOurselves.set(pathKey(rel), '');
            await this.deps.fs.unlink(abs);
          }
          results.push({ rel, status: 'deleted' });
        } else {
          this.writingOurselves.set(pathKey(rel), base.sha);
          const row = this.baselineRow(rel);
          await this.deps.fs.writeFile(abs, base.bytes, row && row[3] === '100755' ? 0o755 : undefined);
          results.push({ rel, status: 'restored' });
        }
        done.push(rel);
      } catch (e: any) {
        results.push({ rel, status: 'skipped', reason: e?.message ?? String(e) });
      }
    }
    let record: RestoreRecord | undefined;
    if (done.length) {
      record = { at: this.now().toISOString(), kind, before, paths: done };
      this.session.restores.push(record);
      for (const rel of done) {
        const ch = this.session.changes[pathKey(rel)];
        if (ch) for (const id of Object.keys(ch.hunks)) ch.hunks[id] = 'discarded';
        await this.handlePath(rel);
      }
      this.schedulePersist();
    }
    return { record, results };
  }

  lastUndoableRestore(): RestoreRecord | undefined {
    if (!this.session) return undefined;
    for (let i = this.session.restores.length - 1; i >= 0; i--) {
      const r = this.session.restores[i];
      if (r.undone) continue;
      if (r.paths.some((p) => !(r.undonePaths ?? []).includes(p))) return r;
    }
    return undefined;
  }

  /**
   * Puts back what a restore overwrote. A path whose current bytes are no longer what the restore
   * wrote (someone edited it since) is skipped unless `force`.
   */
  async undoRestore(record: RestoreRecord, force = false): Promise<{ rel: string; status: 'undone' | 'skipped'; reason?: string }[]> {
    const out: { rel: string; status: 'undone' | 'skipped'; reason?: string }[] = [];
    if (!this.session) return out;
    const undonePaths = new Set(record.undonePaths ?? []);
    for (const rel of record.paths) {
      if (undonePaths.has(rel)) continue;
      const abs = fromRelPosix(this.folder, rel);
      const cur = await this.deps.fs.readFile(abs);
      let expectedSha: string;
      if (record.after && rel in record.after) expectedSha = record.after[rel];
      else {
        const base = await this.resolveBaseline(rel);
        expectedSha = base.kind === 'bytes' ? base.sha : '';
      }
      const curSha = cur ? sha256(cur) : '';
      if (!force && curSha !== expectedSha) {
        out.push({ rel, status: 'skipped', reason: 'changed-since' });
        continue;
      }
      const beforeSha = record.before[rel];
      try {
        if (!beforeSha) {
          if (cur) {
            this.writingOurselves.set(pathKey(rel), '');
            await this.deps.fs.unlink(abs);
          }
        } else {
          const bytes = await this.deps.store.getBlob(beforeSha);
          if (!bytes) {
            out.push({ rel, status: 'skipped', reason: 'lost' });
            continue;
          }
          this.writingOurselves.set(pathKey(rel), beforeSha);
          await this.deps.fs.writeFile(abs, bytes);
        }
        out.push({ rel, status: 'undone' });
        undonePaths.add(rel);
        await this.handlePath(rel);
      } catch (e: any) {
        out.push({ rel, status: 'skipped', reason: e?.message ?? String(e) });
      }
    }
    if (out.some((r) => r.status === 'undone')) {
      record.undonePaths = [...undonePaths];
      record.undone = record.paths.every((p) => undonePaths.has(p));
      this.schedulePersist();
    }
    return out;
  }

  // ------------------------------------------------------------------------------------------
  // reconciliation after a reload
  // ------------------------------------------------------------------------------------------

  /** Finds what changed while no watcher was running and re-inspects it. Returns candidate count. */
  async reconcile(progress?: (msg: string) => void): Promise<number> {
    if (!this.session || !this.baseline) return 0;
    const candidates = new Set<string>();
    for (const c of Object.values(this.session.changes)) candidates.add(c.path);
    // rows that were copied/absent/uncertain at start cannot be compared by OID: re-check them all (bounded by the copy limits)
    for (const row of this.baseline.rows) if (row[1] !== 'git-blob') candidates.add(row[0]);
    if (this.deps.git) {
      progress?.('index');
      const ls = await this.deps.git.run(['ls-files', '-s', '-z', '--recurse-submodules'], { maxBuffer: 256 * 1024 * 1024 });
      if (ls.code !== 0) throw new EngineError('git', `git ls-files failed: ${ls.stderr.trim()}`);
      const nowIdx = new Map<string, { oid: string; path: string }>();
      for (const e of parseLsFilesStage(ls.stdout)) if (e.mode !== '160000') nowIdx.set(pathKey(e.path), { oid: e.oid, path: e.path });
      for (const row of this.baseline.rows) {
        if (row[1] !== 'git-blob') continue;
        const now = nowIdx.get(pathKey(row[0]));
        if (!now || now.oid !== row[2]) candidates.add(row[0]);
      }
      for (const [k, e] of nowIdx) {
        const row = this.baselineRows.get(k);
        if (!row) candidates.add(e.path);
      }
      const st = await this.deps.git.run(['status', '--porcelain=v2', '-z', '--untracked-files=all', '--ignored=matching', '--no-renames', '--', '.'], { maxBuffer: 256 * 1024 * 1024 });
      if (st.code !== 0) throw new EngineError('git', `git status failed: ${st.stderr.trim()}`);
      for (const e of this.localStatus(parseStatusV2(st.stdout))) {
        if (e.kind === 'ignored') {
          if (!e.path.endsWith('/') && this.deps.rules.isCritical(e.path)) candidates.add(e.path);
          continue;
        }
        candidates.add(e.path);
      }
    } else {
      progress?.('scan');
      const seen = new Set<string>();
      for await (const f of this.deps.fs.walk(this.folder, (dir) => this.deps.rules.skipDir(dir))) {
        seen.add(pathKey(f.rel));
        candidates.add(f.rel);
      }
      for (const row of this.baseline.rows) if (!seen.has(pathKey(row[0]))) candidates.add(row[0]);
    }
    const list = [...candidates];
    await this.prefetchIgnore(list);
    let n = 0;
    for (const rel of list) {
      if (++n % 100 === 0) progress?.(`recheck ${n}/${list.length}`);
      await this.handlePath(rel, { fromBurstQueue: true });
    }
    return list.length;
  }

  // ------------------------------------------------------------------------------------------
  // GC
  // ------------------------------------------------------------------------------------------

  async gc(retentionDays: number, maxBytes: number): Promise<{ droppedSessions: number; deletedBlobs: number }> {
    const store = this.deps.store;
    const idx0 = await store.readIndex();
    const sessions: { id: string; startedAt: string; stoppedAt?: string; blobRefs: string[] }[] = [];
    for (const meta of idx0.sessions) {
      const refs: string[] = [];
      const b = await store.readBaselineJson<BaselineManifest>(meta.id);
      if (b) for (const r of b.rows) if (r[1] === 'store' || (r[1] === 'uncertain' && r[3] === 'store')) refs.push(r[2]);
      const m = await store.readMaterialized(meta.id);
      for (const v of Object.values(m)) if (!v.startsWith('!')) refs.push(v);
      const s = await store.readSessionJson<Session>(meta.id);
      if (s) for (const r of s.restores) for (const sha of Object.values(r.before)) if (sha) refs.push(sha);
      sessions.push({ id: meta.id, startedAt: meta.startedAt, stoppedAt: meta.stoppedAt, blobRefs: refs });
    }
    const blobs = await store.listBlobs();
    const blobSizes: Record<string, number> = {};
    for (const b of blobs) blobSizes[b.sha] = b.size;
    // the active session may have changed while we were reading: decide against the freshest index and never drop it
    const activeNow = (await store.readIndex()).activeSessionId ?? this.session?.id;
    const plan = planGc({ now: this.now().getTime(), retentionDays, maxBytes, activeSessionId: activeNow, sessions, blobSizes });
    const drop = new Set(plan.dropSessions.filter((id) => id !== activeNow && id !== this.session?.id));
    for (const id of drop) await store.deleteSessionFiles(id);
    await this.withIndex((idx) => {
      idx.sessions = idx.sessions.filter((s) => !drop.has(s.id));
    });
    // never delete a blob younger than 10 minutes: it may belong to a session being written right now;
    // and never a blob referenced by a session that was created while we were scanning
    const young = this.now().getTime() - 10 * 60_000;
    const known = new Set(sessions.map((s) => s.id));
    const fresh = (await store.readIndex()).sessions.some((s) => !known.has(s.id));
    let deleted = 0;
    if (!fresh) {
      for (const sha of plan.deleteBlobs) {
        const b = blobs.find((x) => x.sha === sha);
        if (b && b.mtimeMs > young) continue;
        await store.deleteBlob(sha);
        deleted++;
      }
    }
    return { droppedSessions: drop.size, deletedBlobs: deleted };
  }

  // ------------------------------------------------------------------------------------------
  // helpers for the UI
  // ------------------------------------------------------------------------------------------

  /** Baseline text for the diff editor's left side ('' when the file did not exist). */
  async baselineText(rel: string): Promise<{ text: string; available: boolean; reason?: string }> {
    const b = await this.resolveBaseline(rel);
    if (b.kind === 'none') return { text: '', available: true };
    if (b.kind === 'unavailable') return { text: '', available: false, reason: b.reason };
    if (looksBinary(b.bytes)) return { text: '', available: false, reason: 'binary' };
    return { text: decodeText(b.bytes).text, available: true };
  }

  static eolOf(lines: TextLine[]): ReturnType<typeof detectEol> {
    return detectEol(lines);
  }
}

export class EngineError extends Error {
  constructor(readonly code: 'locked' | 'git' | 'cancelled' | 'io', message: string) {
    super(message);
  }
}

export type { BaselineSource };
