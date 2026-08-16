# Lanzamiento — ChangeKeeper

Textos listos para publicar desde tus cuentas (yo los publico desde la ventana de automatización cuando inicies sesión; captchas y 2FA los resuelves tú). Cada bloque tiene EN (canal principal) y ES. Reglas de la guía §7 y de la auditoría del plan (P4/P9): sin marca ajena al frente, «not affiliated» visible, recomendación honesta, sin «cero problemas», posicionamiento **agentes CLI + ediciones por shell + varios agentes + validación**, y **calendario escalonado**: soft-launch (canales sin filtro de cuenta) con la 0.1.0 ya publicada; X/LinkedIn con la 0.2.0 (Pro) o el GIF; Reddit solo con cuenta con antigüedad/karma.

Enlaces reales: Marketplace https://marketplace.visualstudio.com/items?itemName=argalla.changekeeper · Open VSX https://open-vsx.org/extension/argalla/changekeeper · Repo https://github.com/TecniartGalicia/changekeeper · Releases https://github.com/TecniartGalicia/changekeeper/releases

## 0 · Demo GIF (hazlo o dime cuándo grabo yo con el navegador de automatización)

Guion (30 s, VS Code claro): (1) terminal con un agente CLI editando `src/…` y `.env` con `sed -i`; (2) la vista ChangeKeeper se llena: `.env` primero con icono de aviso; (3) clic → diff nativo; CodeLens **Accept · Discard**; (4) *Discard* de un hunk peligroso; (5) **Restore file** de `.env` + **Undo**; (6) **Show Session Report** con el mensaje de commit. Sin audio; subtítulos EN.

## 1 · Soft-launch (0.1.0, sin filtros de cuenta)

### 1a · GitHub Discussions «Show and tell» de anthropics/claude-code — EN

**Title:** ChangeKeeper — review hunk by hunk and roll back what Claude Code (or any CLI agent) changed, including edits made with `sed`

**Body:**
Claude Code's `/rewind` covers its own edits, and Copilot/Cursor have *Keep/Undo* for theirs. What was missing for me: something that sees **every** change in the workspace — the ones made from Bash (`sed -i`, scripts, `git checkout`), the ones made by a second agent, the ones I made in between — and lets me review them **hunk by hunk** in VS Code, discard just the bad blocks and roll a file (or the whole session) back with an undo.

So I built **ChangeKeeper** (VS Code extension, free, MIT, EN+ES, works on Windows/macOS/Linux and in VSCodium/Cursor via Open VSX):

- Baseline from the git index the moment a session starts — nothing is copied until a file changes; non-git folders work too.
- Every changed file (from any process or from the editor) appears in a view; critical files (`.env*`, migrations, CI, lock files, `.claude/`…) first — even when git-ignored.
- Native diff (baseline ↔ now), CodeLens **Accept · Discard** above each hunk, *Discard* rewrites only that block (line endings and encodings preserved), **Restore** file/session with **Undo**.
- Session report in Markdown with a suggested commit message.
- Guardrails: burst guard for `npm install`-style storms, notice when the agent moves HEAD, catch-up after a reload.

Everything local, no telemetry, no account. Not affiliated with Anthropic or any agent vendor. If Claude Code's own `/rewind` is all you need, keep it — ChangeKeeper is for the CLI-heavy, multi-agent, "what exactly changed and why is my `.env` different" workflows.

Marketplace: https://marketplace.visualstudio.com/items?itemName=argalla.changekeeper · Open VSX: https://open-vsx.org/extension/argalla/changekeeper · Source: https://github.com/TecniartGalicia/changekeeper

Feedback very welcome — especially on which agents/hook shapes you'd like tagged first (Claude Code hooks are supported in the optional Pro tier; Codex/Cursor next).

### 1b · dev.to / Hashnode — EN (artículo corto)

**Title:** I stopped trusting "the agent will tell me what it changed" — a VS Code extension that watches the file system instead

Outline: the gap (agent-side undo vs. what really happened on disk) → design (baseline = git index by object id, hunks as line-range replacements, critical files beat `.gitignore`) → the three things it does not do (no telemetry, no hooks that decide permissions, no writes inside your repo) → limitations (needs VS Code open; gutter blocks ≠ hunks) → links. 600-800 words, two screenshots (tree + diff with CodeLens).

### 1c · PRs a listas «awesome» — EN

- `awesome-claude-code` (categoría "IDE / VS Code"): `[ChangeKeeper](https://github.com/TecniartGalicia/changekeeper) — Review hunk by hunk and roll back every change your agent makes in VS Code, including edits made from the shell. Free, local-first.`
- `awesome-vscode` (categoría "Git/SCM" o "AI"): misma línea.

### 1d · Hacker News «Show HN» — EN (publicar entre semana, 14:00-16:00 CET = mañana US)

**Title:** Show HN: ChangeKeeper – review and roll back what AI coding agents change, hunk by hunk (VS Code)
**Text:** Two paragraphs from 1a (gap + what it does), then "Free/MIT/local; optional Pro (7 €, one-time) adds validations after review, secret scanning and agent hooks. Not affiliated with any agent vendor. Happy to discuss the baseline-by-git-object-id design and why the diff gutter menu turned out to be a proposed API."

## 2 · X @ArgallaTec — EN (hilo de 4, ≤ 280 chars, URLs = 23)

1/ AI coding agents undo their *own* edits fine. They don't see what `sed -i`, a script or a second agent just did to your repo. ChangeKeeper for VS Code does: baseline → every change → review hunk by hunk → discard/restore/undo. Free, local. https://marketplace.visualstudio.com/items?itemName=argalla.changekeeper

2/ Baseline = the git index at session start (nothing copied until a file changes). Critical files (.env, migrations, CI, lock files) are listed first — even when git-ignored. Native diff + CodeLens Accept · Discard above each hunk. Line endings and encodings preserved.

3/ Restore a file or the whole session with Undo. Session report in Markdown with a suggested commit message. Burst guard for npm install storms. Windows/macOS/Linux, VSCodium & Cursor via Open VSX. EN+ES. Not affiliated with any agent vendor.

4/ Optional Pro (7 €, one-time, Polar): validations after review (confirmed per command), local secret scanner, commit message into the SCM box, Claude Code hooks for agent attribution. Everything Pro adds can be removed for free. Source: https://github.com/TecniartGalicia/changekeeper

## 3 · LinkedIn (perfil) — EN + ES en un solo post (≤ 3.000 chars)

**EN —** Agents with their own IDE undo their own edits. The moment you use a CLI agent, a second agent or the agent runs a shell command, that safety net is gone. **ChangeKeeper** (VS Code, free, MIT) takes a baseline of the workspace, shows every change made afterwards — by any process — and lets you review it hunk by hunk, discard the bad blocks and roll back a file or the whole session with undo. Critical files first (`.env*`, migrations, CI). Session report with a suggested commit message. Local-first, no telemetry. Optional Pro (7 € once) for validations after review, secret scanning and agent hooks. Not affiliated with any agent vendor. → https://marketplace.visualstudio.com/items?itemName=argalla.changekeeper

**ES —** Los agentes con IDE propio deshacen sus propias ediciones. En cuanto usas un agente de terminal, un segundo agente o el agente lanza un comando de shell, esa red desaparece. **ChangeKeeper** (VS Code, gratis, MIT) toma una línea base del espacio de trabajo, muestra todo lo que cambia después — desde cualquier proceso — y te deja revisarlo bloque a bloque, descartar los bloques malos y restaurar un fichero o la sesión entera con deshacer. Críticos primero (`.env*`, migraciones, CI). Informe de sesión con mensaje de commit sugerido. Local, sin telemetría. Pro opcional (7 € una vez) con validaciones tras la revisión, escáner de secretos y hooks de agente. Sin relación con ningún fabricante de agentes. → https://open-vsx.org/extension/argalla/changekeeper

## 4 · Reddit — EN (SOLO con cuenta con antigüedad y karma > 50; subs: r/ClaudeAI, r/ClaudeCode, r/codex, r/cursor, r/GithubCopilot, r/vscode; flair "Built with Claude" en r/ClaudeAI)

**Title:** ChangeKeeper: review hunk by hunk and roll back what your CLI agent changed — including the `sed -i` and script edits nobody tracks (VS Code, free)

**Body:** = 1a, sin el último párrafo de "Feedback"; añade "Windows-first: CRLF, legacy encodings and file locks are handled; the diff never rewrites a line you didn't change."

## 5 · Product Hunt (opcional)

**Tagline (≤ 60):** Review and roll back what AI coding agents change, hunk by hunk
**Description (≤ 260):** ChangeKeeper for VS Code takes a baseline of your workspace, shows every change any agent (or shell command) makes afterwards, and lets you review hunk by hunk, discard blocks and restore files or the whole session with undo. Free, local-first, EN+ES.

## Registro de publicaciones

| Fecha | Canal | URL | Estado / reintento |
|---|---|---|---|
| — | — | — | — |
