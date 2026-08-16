# Contributing

Thanks for helping. ChangeKeeper is deliberately small and boring where it matters (file safety); keep it that way.

## Ground rules
- The engine (`src/core/`) never imports `vscode`. Everything that touches disk or git goes through the injected adapters so it can be unit-tested against a temp folder and a real `git`.
- A file is only ever written on an explicit user action (discard, restore, undo). Every overwrite keeps the previous bytes in the store first.
- Discards are line-range replacements: never rewrite lines you did not change, never normalise line endings or BOM.
- Every user-facing string goes through `vscode.l10n.t` and gets a Spanish entry in `l10n/bundle.l10n.es.json`. `node scripts/l10n-sync.mjs` reports missing/orphan keys; the unit tests fail on both.
- Nothing leaves the machine. No telemetry, no network.

## Dev loop
```bash
npm install
npm run check            # typecheck + lint + unit tests (needs git on PATH)
npm run test:integration # downloads VS Code once, runs the hermetic end-to-end suite
# Same suite inside another host (VSCodium, Cursor…): CK_VSCODE_EXE=<path to its executable> npm run test:integration
npm run build            # dist/extension.js
npm run package          # .vsix
```
Press F5 in VS Code to launch an Extension Development Host.

## Where things are
- `src/core/engine.ts` — sessions, baseline (git index by OID / folder copy), change detection, hunks, restore/undo, reconciliation, GC.
- `src/core/hunks.ts` — hunk model and the discard algorithm; `src/core/textfile.ts` — EOL/BOM-preserving line handling.
- `src/vscode/folderGuard.ts` — watchers and the event queue per workspace folder; `src/vscode/review.ts` — commands.
- `docs/PLAN.md` and `docs/AUDITORIA.md` — design decisions and the independent audits each phase went through.

## Internal command
`changekeeper._manager` returns the in-memory guard manager. It exists for the integration tests only; it is not a public API.
