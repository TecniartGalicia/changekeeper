import { execFile, spawn } from 'child_process';
import * as fs from 'fs/promises';
import * as path from 'path';
import { FsAdapter, FsStat, GitRunner } from './engine';
import { atomicWrite } from './store';

/** Node implementations of the engine adapters (no vscode). */

export class NodeFs implements FsAdapter {
  async readFile(abs: string): Promise<Buffer | undefined> {
    try {
      return await fs.readFile(abs);
    } catch (e: any) {
      if (e && (e.code === 'ENOENT' || e.code === 'EISDIR' || e.code === 'ENOTDIR')) return undefined;
      // transient Windows lock while another process writes: retry once
      if (e && (e.code === 'EBUSY' || e.code === 'EPERM')) {
        await new Promise((r) => setTimeout(r, 60));
        try {
          return await fs.readFile(abs);
        } catch {
          return undefined;
        }
      }
      throw e;
    }
  }

  async stat(abs: string): Promise<FsStat | undefined> {
    try {
      const l = await fs.lstat(abs);
      if (l.isSymbolicLink()) {
        try {
          const s = await fs.stat(abs);
          return { size: s.size, mtimeMs: s.mtimeMs, isFile: s.isFile(), isDirectory: s.isDirectory(), isSymbolicLink: true };
        } catch {
          return { size: 0, mtimeMs: l.mtimeMs, isFile: false, isDirectory: false, isSymbolicLink: true };
        }
      }
      return { size: l.size, mtimeMs: l.mtimeMs, isFile: l.isFile(), isDirectory: l.isDirectory(), isSymbolicLink: false };
    } catch (e: any) {
      if (e && (e.code === 'ENOENT' || e.code === 'ENOTDIR')) return undefined;
      throw e;
    }
  }

  /**
   * Atomic write that preserves the mode of the file being replaced (temp file + rename would
   * otherwise reset it to the umask default and, for instance, make a script non-executable — C9).
   * An explicit `mode` wins (used when the baseline says the file was 100755).
   */
  async writeFile(abs: string, data: Buffer, mode?: number): Promise<void> {
    let keep: number | undefined;
    if (mode === undefined && process.platform !== 'win32') {
      keep = await fs
        .stat(abs)
        .then((st) => st.mode & 0o777)
        .catch(() => undefined);
    }
    await atomicWrite(abs, data);
    const want = mode ?? keep;
    if (want !== undefined && process.platform !== 'win32') await fs.chmod(abs, want).catch(() => undefined);
  }

  async unlink(abs: string): Promise<void> {
    await fs.rm(abs, { force: true });
  }

  async *walk(root: string, skipDir: (relDir: string) => boolean): AsyncIterable<{ rel: string; size: number; mtimeMs: number }> {
    const stack: string[] = [''];
    while (stack.length) {
      const relDir = stack.pop()!;
      let entries;
      try {
        entries = await fs.readdir(path.join(root, ...relDir.split('/').filter(Boolean)), { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        const rel = relDir ? `${relDir}/${e.name}` : e.name;
        if (e.isDirectory()) {
          if (!skipDir(rel)) stack.push(rel);
        } else if (e.isFile()) {
          try {
            const st = await fs.stat(path.join(root, ...rel.split('/')));
            yield { rel, size: st.size, mtimeMs: st.mtimeMs };
          } catch {
            /* vanished */
          }
        }
      }
    }
  }
}

/** Runs `git` in a folder. `gitPath` comes from the VS Code git extension when available. */
export class NodeGit implements GitRunner {
  constructor(readonly gitPath: string, readonly cwd: string) {}

  run(args: string[], opts: { stdin?: Buffer; maxBuffer?: number } = {}): Promise<{ code: number; stdout: Buffer; stderr: string }> {
    const env = { ...process.env, GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C', GIT_TERMINAL_PROMPT: '0' };
    if (opts.stdin === undefined) {
      return new Promise((resolve, reject) => {
        execFile(
          this.gitPath,
          args,
          { cwd: this.cwd, encoding: 'buffer', maxBuffer: opts.maxBuffer ?? 64 * 1024 * 1024, env, windowsHide: true },
          (err: any, stdout: Buffer, stderr: Buffer) => {
            if (err && (err.code === 'ENOENT' || err.code === 'EACCES')) return reject(err);
            if (err && typeof err.code !== 'number' && !stdout) return reject(err);
            resolve({ code: err && typeof err.code === 'number' ? err.code : err ? 1 : 0, stdout: stdout ?? Buffer.alloc(0), stderr: (stderr ?? Buffer.alloc(0)).toString('utf8') });
          },
        );
      });
    }
    return new Promise((resolve, reject) => {
      const child = spawn(this.gitPath, args, { cwd: this.cwd, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      let total = 0;
      const max = opts.maxBuffer ?? 64 * 1024 * 1024;
      child.stdout.on('data', (d: Buffer) => {
        total += d.length;
        if (total > max) {
          child.kill();
          return;
        }
        out.push(d);
      });
      child.stderr.on('data', (d: Buffer) => err.push(d));
      child.on('error', reject);
      child.on('close', (code) => resolve({ code: code ?? 1, stdout: Buffer.concat(out), stderr: Buffer.concat(err).toString('utf8') }));
      child.stdin.on('error', () => undefined);
      child.stdin.end(opts.stdin);
    });
  }
}

/** Finds the repository root that contains `folder`, or undefined when not a git work tree. */
export async function gitToplevel(gitPath: string, folder: string): Promise<string | undefined> {
  const g = new NodeGit(gitPath, folder);
  try {
    const r = await g.run(['rev-parse', '--show-toplevel']);
    if (r.code !== 0) return undefined;
    const top = r.stdout.toString('utf8').trim();
    return top || undefined;
  } catch {
    return undefined;
  }
}
