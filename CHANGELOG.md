# Changelog

All notable changes to ChangeKeeper are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [0.1.0] - 2026-08-16

First public preview.

### Added
- Guarded sessions per workspace folder, started automatically inside git repositories (`changekeeper.autoStart`), or on demand.
- Baseline from the git index at session start (no copies until a file changes; dirty and untracked files are copied); folder copy for non-git folders (within limits).
- Detection of every change made afterwards from any process or from the editor: added, modified, deleted and renamed files.
- ChangeKeeper view: changed files (critical first) with their hunks; status bar counters.
- Native diff (baseline ↔ now) with *Revert block* from VS Code's gutter and a *ChangeKeeper: Accept* gutter action; multi-diff **Review All Changes**.
- CodeLens above every hunk (Accept · Discard · Diff) and highlighted changed lines in the editor.
- Discard a single hunk (baseline lines written back, other lines untouched, line endings preserved), accept hunk/file/all.
- Restore file / restore whole session to the baseline, with **Undo last restore** (refuses to overwrite files changed since).
- Critical files (migrations, SQL, CI, Dockerfiles, `.env*`, auth/security, package manifests and locks, `.vscode`, `.claude`, `.cursor`, `.github`) always tracked — even when git-ignored — and listed first; custom globs.
- Session report (Markdown) with a suggested commit message; export to file.
- Guardrails: burst guard for mass changes, size and binary limits, HEAD-moved notice with re-baseline, catch-up reconciliation after a reload.
- Retention of closed sessions (days / MB) and **Purge All Data**.
- English and Spanish.

### Not in this version
- Validations (lint/tests after review), secret scanning, agent attribution through hooks and the commit message straight into the SCM box are planned for a later, optional Pro tier.
