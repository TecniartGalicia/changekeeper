# Changelog

All notable changes to ChangeKeeper are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [0.2.2] - 2026-08-17

### Fixed
- **A critical file inside an ignored directory (`.gitignore` = `.vscode/`, `.claude/`…) had no baseline, so it looked added and "Restore file" deleted it.** git reports the whole directory as one entry and never lists the file; those directories are now walked. Same for files inside a nested git repository, which git does not descend into.
- **The garbage collector could delete the baseline of the session you have open** if `index.json` became unreadable. It now also protects what the running session holds in memory, and does nothing at all when the index does not list that session.
- A file that cannot be read (locked by another process, antivirus) is no longer reported as **deleted** — that threw away the review you had done and could invent a rename.
- `Restore` no longer aborts on the first I/O error leaving files already overwritten without an undo record.
- A file with a UTF-8 BOM and a non-UTF-8 body kept losing its BOM when discarding a hunk.
- Discarding a hunk kept the file's POSIX mode (a script stayed executable) and, on a read-only file, reports a clear message instead of throwing after four seconds.
- With `core.autocrlf`, rewriting a CRLF file with LF endings is no longer reported as "no change".
- A file open in the editor with an encoding VS Code decodes differently (UTF-16, legacy code pages) no longer shows phantom changes.
- Two automatic starts racing (an agent's session start plus its first edit) created two sessions, and the second one swallowed everything written during the first baseline.
- Closing a window or removing a folder in the middle of a session start no longer leaves a file watcher and the folder lock behind.
- "Accept/Discard hunk at cursor" now works from the baseline (left) side of the diff; "Review all changes" shows renames against their source instead of an empty file.
- The secret scanner no longer skips lines longer than 1000 characters (a private key pasted on one line went unnoticed); the folder lock is taken exclusively; several listeners and timers that outlived `dispose()` are gone.

### Security
- The internal test commands are no longer registered in production: another installed extension could call them and read the Pro licence key and the hook token.
- Installing project hooks refuses to write through a symlink that leaves the workspace (a cloned repository could redirect the write, or get the token into a tracked file), and a repository that ships `.claude/settings.local.json` no longer makes the local receiver start for someone who never installed hooks.
- An unknown licence status from the payment provider is treated as "cannot tell" (grace) instead of a revocation, and a failed check is not retried every minute while offline.

## [0.2.1] - 2026-08-16

### Added
- A demo GIF and three screenshots in the listing (recorded from a real session: an agent edits from the shell, the changes show up with critical files first, a hunk is discarded from the diff and the session report redacts the secret it found). They are served from the repository, so the extension package does not grow.
- `npm run demo`: the scripted session used to record them, so the media can be reproduced when the UI changes.

## [0.2.0] - 2026-08-16

### Added
- **Pro tier** (7 €, one-time, licence key via Polar): validations after review (confirmed per command and per resolved package.json script, exact exit codes, never in Restricted Mode), local secret scanner over added lines (redacted findings in tree and report), commit message straight into the SCM input box, **agent hooks** (opt-in HTTP hooks for Claude Code — `SessionStart`, `UserPromptSubmit` and `PostToolUse` — with consent/backup/revert/doctor; project scope by default and git-excluded; per-user token; lazy local receiver, one owner window per machine; files tagged with the agent that edited them; `autoStart: whenAgentDetected`), licence commands (enter key, status, deactivate, buy). Everything Pro adds can be removed without a licence; the user-level hooks are also removed on uninstall (`vscode:uninstall`).
- Discarding a hunk on disk (closed document) now keeps the previous bytes: it can be undone with **Undo last restore**.
- Renamed files diff against the baseline of their source; CodeLens sits on the first changed line; accept/discard at cursor work from the baseline side of the diff too.

### Changed
- The session report no longer includes the first changed line of hunks in critical files (only the ranges); hunk headers are capped at 100 characters.
- Fewer recomputations while typing in a changed file.
- Third-party licence notices shipped in the package.

## [0.1.0] - 2026-08-16

First public preview.

### Added
- Guarded sessions per workspace folder, started automatically inside git repositories (`changekeeper.autoStart`), or on demand.
- Baseline from the git index at session start (no copies until a file changes; dirty and untracked files are copied); folder copy for non-git folders (within limits).
- Detection of every change made afterwards from any process or from the editor: added, modified, deleted and renamed files.
- ChangeKeeper view: changed files (critical first) with their hunks; status bar counters.
- Native diff (baseline ↔ now) with VS Code's own *Revert block* gutter action plus **Accept / Discard hunk at cursor** in the diff title bar and context menu; multi-diff **Review All Changes**.
- CodeLens above every hunk (Accept · Discard · Diff) and highlighted changed lines in the editor.
- Discard a single hunk (baseline lines written back, other lines untouched, line endings and legacy encodings preserved), accept hunk/file/all; every on-disk discard keeps the previous bytes so it can be undone.
- Restore file / restore whole session to the baseline, with **Undo last restore** (refuses to overwrite files changed since).
- Critical files (migrations, SQL, CI, Dockerfiles, `.env*`, auth/security, package manifests and locks, `.vscode`, `.claude`, `.cursor`, `.github`) always tracked — even when git-ignored — and listed first; custom globs.
- Session report (Markdown) with a suggested commit message; export to file.
- Guardrails: burst guard for mass changes, size and binary limits, HEAD-moved notice with re-baseline, catch-up reconciliation after a reload.
- Retention of closed sessions (days / MB) and **Purge All Data**.
- English and Spanish.

### Not in this version
- Validations, secret scanning, agent attribution through hooks and the commit message straight into the SCM box arrive with the optional Pro tier in 0.2.0.
