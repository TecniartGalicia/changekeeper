# ChangeKeeper

**Install:** [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=argalla.changekeeper) · [Open VSX](https://open-vsx.org/extension/argalla/changekeeper) (Cursor / VSCodium / Windsurf) · or run `code --install-extension argalla.changekeeper`.

**Keep, review hunk by hunk and roll back every change your AI coding agent makes — including the ones made from the shell.** ChangeKeeper takes a baseline of your workspace, watches what changes afterwards (from *any* process: Claude Code, Codex, OpenCode, Cline, Copilot agent mode, Cursor, a script, `sed -i`, or you) and lets you review each change block by block, discard the bad ones and restore a file — or the whole session — with one click. Local-first, no telemetry, no account.

> **Not affiliated with, endorsed by, or sponsored by any agent vendor.** Claude Code, Codex, Copilot, Cursor and other names belong to their owners. ChangeKeeper only watches your files.
>
> [Leer en español](README.es.md)

---

## Why this exists

Agents with their own IDE already offer *Keep / Undo* for the edits they make themselves. But the moment you use a **CLI agent** (Claude Code, Codex CLI, OpenCode…), a **second agent**, or the agent runs a **shell command** that rewrites files, that safety net is gone: nothing groups what changed, nothing shows you the before/after per block, and "undo" means digging in git or the timeline. ChangeKeeper is that missing layer, and it works the same for every agent because it watches the file system, not the agent.

## What it does

| | |
| :-- | :-- |
| **Baseline in a blink** | In a git repository the baseline is the index at session start — nothing is copied until a file actually changes. Non-git folders are copied (within limits). |
| **Sees every change** | Files written by any process (agent CLI, scripts, `git checkout`), files edited in the editor, created, deleted and renamed files. Git-ignored files are skipped — except **critical** ones like `.env*`, which are always watched. |
| **Review hunk by hunk** | The ChangeKeeper view lists changed files (critical ones first) and their hunks. Click a file for the native diff (baseline ↔ now): VS Code's own gutter offers *Revert block*, and the diff's title bar and context menu offer **Accept / Discard hunk at cursor**; in the normal editor a CodeLens above each hunk offers **Accept · Discard · Diff** and changed lines are highlighted. |
| **Discard exactly one hunk** | Discarding rewrites only that block with the baseline lines — every other line keeps its content and its own line ending. Open documents are edited through the editor (undoable with Ctrl+Z); closed ones on disk, with the previous bytes kept so **Undo last restore** can put them back. |
| **Restore file / session, undo** | Restore a file (or the whole session) to the baseline; created files are deleted. Everything overwritten is kept, so **Undo last restore** puts it back — and refuses to overwrite files that changed since. |
| **Critical files** | Migrations, SQL, CI workflows, Dockerfiles, `.env*`, auth/security folders, package manifests and lock files, `.vscode`, `.claude`, `.cursor`, `.github` are flagged and listed first. Add your own globs. |
| **Session report** | A Markdown summary of the session (files, hunks accepted/discarded, critical files) with a suggested commit message — export it or paste it in a PR. |
| **Guardrails** | A burst of hundreds of new files (`npm install`, build, checkout) pauses the tracking of new files and asks you. Binary and huge files are recorded but not diffed. Agent commits or checkouts move HEAD? You are told and can re-baseline. |
| **Works everywhere** | Windows (CRLF preserved), macOS, Linux; Remote-SSH / WSL / Dev Containers (runs where the files are); VS Code, VSCodium, Cursor, Windsurf. English and Spanish. |

## How it works

1. Open a folder inside a git repository → ChangeKeeper starts guarding it (status bar `CK`). No git? Use **ChangeKeeper: New Session** or set `changekeeper.autoStart` to `always`.
2. Let the agent work. Every changed file appears in the ChangeKeeper view with its hunks.
3. Review: **Accept** what you keep, **Discard** what you don't, **Restore** what went wrong. **Review All Changes** opens everything in the multi-diff editor.
4. When you are done: **Show Session Report** → copy the commit message, or **New Session** to take a fresh baseline.

### Where the data lives

Baselines and session state live in the extension's global storage on this machine (`…/globalStorage/argalla.changekeeper/`), never inside your repository and never on a server (the only files ChangeKeeper writes in your workspace are the ones you explicitly discard or restore, written atomically through a temporary `.ck-tmp` next to them). Baselines of files that changed can contain secrets — the same secrets that are already on your disk. Closed sessions are kept for `changekeeper.retentionDays` (30 by default) or until `changekeeper.retentionMaxMB`; the running session is never deleted. **ChangeKeeper: Purge All Data** wipes everything. See [PRIVACY.md](PRIVACY.md).

### Limitations (honest ones)

- ChangeKeeper needs VS Code open: what an agent does while the window is closed is caught up when you reopen (git-based reconciliation), but without the per-step detail.
- The baseline is what your files looked like *when the session started*. If the agent commits, checks out or stashes mid-session you are told; **New Session** re-baselines.
- The diff gutter blocks (*Revert block*) are computed by VS Code's own differ and do not always coincide 1:1 with ChangeKeeper's hunks; the ChangeKeeper view and the CodeLens are the source of truth.
- The session report lists file paths and, for non-critical files, the first changed line of each hunk; for critical files (`.env*`, keys, CI) only the line ranges are included.
- Files larger than `changekeeper.maxFileSizeKB` (2 MB) and binaries are tracked but not diffed; files stored with Git LFS have no baseline.

## Settings

| Setting | Default | Meaning |
| :-- | :-- | :-- |
| `changekeeper.autoStart` | `git` | Guard automatically: folders in a git repo (`git`), every folder (`always`), or only on **New Session** (`off`). |
| `changekeeper.exclude` | `[]` | Extra globs never tracked (critical files are tracked anyway). Applies to the next session. |
| `changekeeper.excludeDefaults` | `true` | Built-in exclusions (`node_modules`, `dist`, `out`, `build`, caches, logs). |
| `changekeeper.criticalGlobs` | `[]` | Extra critical globs. |
| `changekeeper.maxFileSizeKB` | `2048` | Larger files are recorded, not diffed. |
| `changekeeper.burstThreshold` | `500` | New files in 5 s that trigger the burst guard. |
| `changekeeper.retentionDays` / `retentionMaxMB` | `30` / `500` | Retention of closed sessions. |
| `changekeeper.codeLens` / `decorations` | `true` | Inline review actions and highlights in the editor. |

## Requirements

VS Code 1.95 or newer (or a compatible host). `git` on your PATH (or configured in the built-in git extension) for git-based baselines; folders without git work with `autoStart: always`.

## Privacy & security

Everything happens on your machine. No telemetry, no network calls, no account. Details in [PRIVACY.md](PRIVACY.md); vulnerabilities via [SECURITY.md](SECURITY.md).

## Contributing & licence

MIT. Issues and pull requests on [GitHub](https://github.com/TecniartGalicia/changekeeper); see [CONTRIBUTING.md](CONTRIBUTING.md). Made by [Argalla](https://github.com/TecniartGalicia) (Tecniart Galicia).
