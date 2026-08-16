# Changelog

All notable changes to ChangeKeeper are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [0.2.1] - 2026-08-16

### Added
- A demo GIF and three screenshots in the listing (recorded from a real session: an agent edits from the shell, the changes show up with critical files first, a hunk is discarded from the diff and the session report redacts the secret it found). They are served from the repository, so the extension package does not grow.
- `npm run demo`: the scripted session used to record them, so the media can be reproduced when the UI changes.

## [0.2.0] - 2026-08-16

### Added
- **Pro tier** (7 €, one-time, licence key via Polar): validations after review (confirmed per command and per resolved package.json script, exact exit codes, never in Restricted Mode), local secret scanner over added lines (redacted findings in tree and report), commit message straight into the SCM input box, **agent hooks** (opt-in HTTP hooks for Claude Code — `SessionStart` + `PostToolUse` — with consent/backup/revert/doctor; project scope by default and git-excluded; per-user token; lazy local receiver, one owner window per machine; files tagged with the agent that edited them; `autoStart: whenAgentDetected`), licence commands (enter key, status, deactivate, buy). Everything Pro adds can be removed without a licence; the user-level hooks are also removed on uninstall (`vscode:uninstall`).
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
