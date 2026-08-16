# PLAN — Idea #1 «Agent Change Guard» → producto **ChangeKeeper** (nombre provisional, recomendado; ver §2.1)

> Plan de ejecución escrito el 2026-08-16 a partir de `ideasVs/01-agent-change-guard.md`, del `README.md` de ideasVs (regla «validar antes de desarrollar») y de la **Guía maestra de extensiones VS Code** (`ideasVs/GUIA-EXTENSION-VSCODE-COMPLETA.md`), con `Desktop/Apps/handsfree-claude-code` como base de código, CI, cuentas y seguimiento.
> **Versión 2 — auditada.** La v1 fue revisada por dos agentes independientes (técnico: 24 hallazgos; producto/proceso: 25). Todos están aplicados o razonados en `docs/AUDITORIA.md` (Auditoría 0). Lo que solo puede hacer el humano está en `docs/TUS-TAREAS.md`.
> Carpeta de trabajo: `C:\Users\kirne\Desktop\Apps\agent-change-guard\` — se renombra (y se limpia el término «agent change guard» de todo el proyecto) al fijar el nombre.

---

## 0. Resumen ejecutivo

**Qué construimos:** una extensión de VS Code, agnóstica del agente, que (1) mantiene una **línea base** del workspace, (2) detecta y agrupa **todo lo que cambia en disco o en el editor** mientras trabaja un agente (Claude Code, Codex CLI, OpenCode, Cline, Copilot, Cursor…) —incluidas las ediciones hechas por shell (`sed`, scripts, `git`) que ningún agente registra—, (3) permite **revisar hunk a hunk** (aceptar / descartar / editar) desde el árbol, el diff nativo o CodeLens en el propio editor, (4) **restaura** hunk, fichero o sesión con deshacer, (5) ejecuta **validaciones** configurables (lint, tests, build) y un **escaneo local de secretos**, (6) señala **ficheros críticos** y (7) genera un **informe de sesión** listo para commit/PR. Local, sin telemetría, sin red salvo la licencia Pro.

**Posicionamiento (corregido tras auditoría):** los agentes con IDE propio (Copilot en VS Code, Cursor, Windsurf) ya tienen *Keep/Undo* por bloque; Claude Code tiene `/rewind` por fichero. El hueco real es **agentes CLI + ediciones por shell + varios agentes a la vez + validación y trazabilidad después del cambio**. Copy, keywords y canales apuntan ahí.

**Cómo:** fases F1a/F1b/F2/F3 → **0.1.0 gratis** (prototipo público que valida la hipótesis) → **puerta de validación V1** (entrevistas + prueba real con 2 agentes) → F4 Pro (pago único vía Polar, código de licencia ya probado) → F5 hooks → F6 lanzamiento. Cada fase se **audita** por un agente independiente antes de continuar. El backend Team/Enterprise queda **fuera** y solo se abre con ≥3 compromisos reales (README de ideasVs).

**Bloqueante para empezar el código:** el nombre (§2.1). Todo lo demás está decidido o tiene recomendación.

---

## 1. Mercado (verificado 2026-08-16 contra la API del Marketplace, Open VSX, npm, GitHub y web)

**El nombre «Agent Change Guard» YA EXISTE** en ambas tiendas: `PraveenMalagudi.agent-change-guard` (v0.2.5, 2026-06-10, 52 inst. Marketplace / 930 desc. Open VSX, gratis). Hay que renombrar y **no dejar rastro** del término (keywords, carpeta, docs).

| Competidor | Inst. | Enfoque | Lo que NO cubre |
|---|---:|---|---|
| Copilot Chat en VS Code (checkpoints + **Keep/Undo por bloque**), Cursor/Windsurf (checkpoints + accept por bloque) | — | Su propio agente dentro de su IDE | Agentes CLI; ediciones por shell; nada cruzado; sin validaciones/informe |
| Claude Code `/rewind`; extensión oficial | — | Restaurar por fichero/turno | Sin hunks (issue `anthropics/claude-code#61794`, abierto may-2026, lo pide → **riesgo de función nativa**); no ve `sed`/scripts (Bash) |
| `molon/hunkwise` (solo GitHub; usa API propuesta `editorInsets` → **no puede publicarse** en las tiendas) | — | Accept/Discard por hunk inline para cualquier cambio externo; shadow git; persiste | Sin validaciones/críticos/informe; instalación manual vía skill; sin Windows probado |
| `FotisPanokis.claude-changes` (abr-2026) | 2.664 | Lee los checkpoints propios de Claude Code; diff por fichero, revert all | Solo Claude; no ve cambios por bash; sin hunks |
| `yamakawanin.codex-diff-guard` (jun-2026) | 274 | Snapshot antes de editar + diff nativo | Solo fichero; manual |
| `aiyuekuang.recode` (ene-2026) | 174 | Track & rollback automático de cambios IA | Sin hunks/validaciones; inactivo |
| `lance0212.claude-diff-viewer` · `SamuraiAgent.samurai-agent` | 189 · 189 | Accept/Reject Claude · riesgo de regresión JS/TS | Solo Claude · solo JS/TS |
| `PraveenMalagudi.agent-change-guard` (jun-2026) | 52 | Multi-agente, checkpoint/revert sin git | Sin hunks/validaciones/informe |
| `madiyarzhunussov.traceback-ai` (jun-2026, activo) | 19 | «Control plane» Claude Code por hooks: timeline, net-diff, pausar/redirigir | Solo Claude; sin restauración por hunk |
| `srbsa.diffgate-review`, `llm-guardr41l`, `glyphmap-ai` | <30 | Veredictos/guardarraíles de calidad | Otro problema |
| `micnil.vscode-checkpoints` (abandonado), `xyz.local-history` | 241 k / 1 M | Historial local al guardar desde el editor | No ven escrituras de un CLI; sin sesión/agente |

**Lecturas:** (a) demanda real y fragmentada; el mayor tiene 2,6 k instalaciones y todos son gratis → techo de pago individual modesto: MVP barato, Pro pago único, Team condicionado; (b) hueco = **universal + shell edits + hunks + validaciones + críticos + informe + calidad (EN/ES, tests, Windows)**; (c) hunkwise demuestra que la UX de hunks inline se desea; nosotros la damos con **API estable** (CodeLens + decoraciones + gutter del diff nativo), publicable en las tiendas.

**Nombres (barrido 2026-08-16: Marketplace, Open VSX, npm, GitHub, web):**
| Candidato | Resultado | Valoración |
|---|---|---|
| **ChangeKeeper** (`changekeeper`) | Libre en las 4 fuentes; 4 repos GitHub sin estrellas; sin producto conocido | **Recomendado**: descriptivo, amplio (guarda y devuelve tus cambios), sin conflicto |
| HunkGuard (`hunkguard`) | Libre en todo (0 repos) | Muy distintivo pero jerga («hunk») y familia «guard» saturada (`agent-change-guard`, `codex-diff-guard`) |
| Vigía (`vigia`) | Libre en tiendas; palabra común (898 repos, npm menores) | Sabor Argalla; poco descriptivo en EN |
| ~~Change Warden~~ | Producto ITSM real en Microsoft AppSource (Solution Park) | Descartado (misma casa Microsoft, misma categoría genérica) |
| ~~Diff Warden~~ · ~~Agent Rewind~~ · ~~SnapBack~~ | `pi-diffwarden` (npm) · «rewind» es función de Claude Code · 2 extensiones SnapBack | Descartados |
Pendiente humano (A1): confirmar nombre y, si quiere, dominio y consulta EUIPO/OEPM básica. Todo lo que sigue usa **ChangeKeeper / `changekeeper` / prefijo `CK`** como provisional.

---

## 2. Fase 0 — Decisiones

| Decisión | Propuesta (guía §1) | Estado |
|---|---|---|
| **2.1 Nombre** | displayName **ChangeKeeper**, `name` `changekeeper`, ID `argalla.changekeeper`, repo `TecniartGalicia/changekeeper`. Sin marcas ajenas en el nombre; en `description`/README: «Works with Claude Code, Codex, Copilot, Cursor and more. Not affiliated with any agent vendor.» Elegir a la primera (IDs despublicados no se reutilizan). Prohibido «agent change guard» en keywords/docs. | **HUMANO decide** (A1) |
| 2.2 Publisher / marca | `argalla` (publisher Marketplace, namespace Open VSX verificado, org Polar aprobada) | Reutilizar |
| 2.3 Licencia | MIT, repo público | Decidido |
| 2.4 Modelo de negocio | Ver matriz §3.3. **Free** = todo el control de cambios (autoarranque en repos git, detección, hunks, restaurar, undo, críticos por defecto, informe en pantalla y **export .md**, retención 30 días). **Pro (pago único; recomendación 7 € = mismo precio que Handsfree; alternativa 9 € por más superficie)** = validaciones + presets, escaneo de secretos, reglas de críticos propias, mensaje de commit al SCM, hooks/etiqueta de agente/`whenAgentDetected`, retención configurable. **Regla explícita:** todo lo que Pro añade se puede quitar sin licencia (revert hooks, borrar reglas, purgar datos, seguir leyendo/restaurando lo retenido) → `ensurePro` solo protege *añadir* + test. Marketplace `pricing: "Free"` en 0.1.0 → `"Trial"` en 0.2.0. Team/Enterprise fuera (§8). | **HUMANO confirma precio** (A2) |
| 2.5 Idiomas | EN principal + ES (`vscode.l10n`, `l10n/bundle.l10n.es.json`, `package.nls(.es).json`, `scripts/l10n-sync.mjs` + test) | Decidido |
| 2.6 Alcance 0.1.0 | F1a+F1b+F2+F3: vigilar (autoarranque en git), revisar por hunks (árbol + diff nativo + CodeLens), restaurar/undo, críticos por defecto, informe/export. **Sin Pro, sin hooks; README/CHANGELOG/description 0.1.0 no mencionan Pro** (a lo sumo «Pro coming soon» en README, nunca en description). | Decidido |
| 2.7 Compatibilidad | `engines.vscode ^1.95.0` + `@types/vscode 1.95.0`; VSCodium/Cursor/Windsurf vía Open VSX y suite con `CK_VSCODE_EXE`; Win/mac/Linux; Remote-SSH/WSL/Containers con `extensionKind: ["workspace"]`; virtual `supported: false`; untrusted `"limited"` + `restrictedConfigurations` (validaciones, exclusiones, críticos) | Decidido |
| 2.8 Versionado | SemVer + Keep a Changelog; tag `vX.Y.Z` = publicación; 0.1.0 `preview: true` | Decidido |
| 2.9 Activación | `onStartupFinished` (ligera: comandos, status bar, leer `index.json`; **watchers y línea base solo si `autoStart` aplica o hay sesión persistida**; GC nunca al activar) + `onView:changekeeper.changes` + comandos. Sin `onUri`. Medir por separado: activación sin sesión (<50 ms) y reanudación con sesión (con progreso) | Decidido |
| 2.10 Privacidad | Todo en `globalStorageUri`; sin telemetría; red solo `api.polar.sh` en Pro. Nada dentro del repo del usuario. Snapshots pueden contener secretos: sin cifrado (mismo disco), permisos de usuario, retención, «Purge all data»; PRIVACY lo dice. Limitación documentada: sin VS Code abierto no hay captura | Decidido |
| 2.11 Terceros | Nombres de agentes solo como compatibilidad; sin logos; hooks en config ajena solo con consentimiento + revert + desinstalación | Decidido |
| 2.12 Sesión automática | `changekeeper.autoStart`: `"git"` (**por defecto**: sesión al abrir carpetas con repo git, línea base sin copiar nada), `"always"` (también sin git, con límites), `"off"`. Sesión abierta = «desde que abriste el workspace»; comandos «New session (re-baseline)» y «Stop». Aviso de primera vez con «Disable». Sin esto la validación daría falso negativo (nadie se acuerda de pulsar Start) | Decidido |

---

## 3. Producto

### 3.1 Conceptos
- **Sesión** (*guarded session*): intervalo con inicio/fin en el que todo cambio del workspace se registra y agrupa; una por carpeta de workspace; persistida (sobrevive a recargas; al reanudar se **reconcilia** lo que cambió con VS Code cerrado). Inicio: automático (§2.12), manual, o por hook de agente (F5).
- **Línea base**: contenido de cada fichero al empezar la sesión (o «missing» si se creó después). Fuente: OID del índice git capturado al inicio / copia en almacén / texto del documento si estaba abierto y sucio (§4.3).
- **Cambio**: fichero A/M/D/R respecto a la línea base, con **hunks** (jsdiff `structuredPatch`, contexto 3) e ID estable. Estado por hunk: `pending | accepted | discarded`. Contadores por fichero/sesión.
- **Reglas**: exclusiones (defaults + `.gitignore` + usuario), críticos (globs; **prevalecen sobre las exclusiones**: `.env*`, `.vscode/**`, `.claude/**`, `.github/workflows/**` se vigilan aunque estén ignorados), validaciones (Pro), secretos (Pro).
- **Informe**: markdown de sesión (ficheros, hunks aceptados/descartados/pendientes, críticos, [Pro] secretos redactados y validaciones) + propuesta de mensaje de commit (heurística local, sin IA).
- **Atribución**: la sesión es la unidad («esto pasó mientras trabajaba el agente»). Etiqueta por agente solo con hooks (F5) y solo para las herramientas de edición del agente; ediciones por Bash quedan «unattributed» aunque haya hook. Nunca se finge precisión.

### 3.2 Flujo principal
1. Abres un repo → status bar `$(shield) CK: guarding` (sesión automática). O «ChangeKeeper: New session» para re-basar.
2. El agente trabaja (CLI en terminal externo/interno, extensión que edita documentos, scripts). Status bar: «CK: 4 files · 17 hunks · 1 critical».
3. **Review**: vista lateral «ChangeKeeper» (árbol Sesión → ficheros A/M/D/R con insignias *critical* / *reviewed* → hunks). Clic = diff nativo (`vscode.diff` línea base ↔ fichero real; lado derecho editable ⇒ el gutter nativo permite **revertir bloque**; nuestro menú añade **Accept**). En el editor normal, **CodeLens por hunk** «Accept · Discard · Open diff» + decoraciones (líneas añadidas / marcador de borrado). «Review all» = `vscode.changes` (se recalcula al pulsar).
4. Por hunk: **Accept** (marca revisado), **Discard** (aplica el inverso de ese hunk con verificación de que el fichero no cambió), **Edit** (abre el rango; al guardar se recalcula), **Restore file**, **Restore session**; todo Restore guarda antes lo que pisa → «Undo last restore» (también verificado por hash).
5. **Validate** (Pro): reglas por Task API; resultados en árbol e informe. **Secrets** (Pro): insignia y detalle redactado.
6. **Report**: en pantalla + export `.md` (Free); «Use as commit message» al SCM (Pro).
7. «Stop session» / «New session». Datos hasta la retención (nunca se borra la sesión activa).

### 3.3 Matriz Free / Pro (0.2.0)
| Capacidad | Free | Pro |
|---|:-:|:-:|
| Sesión automática en git (`autoStart: git`), manual, línea base git/propia, detección disco+editor, multi-root | ✓ | ✓ |
| Árbol, diff nativo con revert/accept de bloque, multi-diff, CodeLens por hunk | ✓ | ✓ |
| Accept/Discard/Edit por hunk; restaurar fichero/sesión; undo verificado | ✓ | ✓ |
| Ficheros críticos (reglas por defecto) | ✓ | ✓ + reglas propias |
| Informe en pantalla + export `.md` | ✓ | ✓ + commit message al SCM |
| Validaciones (comandos, presets, `runOn`) | – | ✓ |
| Escaneo local de secretos (líneas añadidas) | – | ✓ |
| Hooks/etiqueta de agente/`autoStart: whenAgentDetected` | – | ✓ |
| Retención | 30 días; tope de tamaño solo sobre sesiones cerradas; nunca la activa | configurable (ilimitada) |
| Quitar lo que Pro añadió (revert hooks, borrar reglas, purgar, leer/restaurar lo retenido) | ✓ | ✓ |

---

## 4. Arquitectura técnica

### 4.1 Estructura (guía §2.1; TypeScript + esbuild; `core/` puro sin `vscode`)
```
src/
  extension.ts                 # activate(): comandos con wrap(), status bar, reanudación (con progreso), watchers solo si aplica
  core/
    store.ts                   # content-addressed: objects/<sha256>.blob + manifests; escritura atómica; lock por workspace; GC (idle/cierre, nunca sesión activa)
    session.ts                 # ciclo de vida, persistencia, contadores, estados de revisión, reconciliación al reanudar
    baseline.ts                # manifiesto (git-blob(oid) | store | doc | missing), materialización por OID, eol/bom del fichero real
    changes.ts                 # A/M/D/R, hunks (jsdiff), IDs estables, reemplazo por rango de líneas, re-asociación
    rules/{exclude,critical,secrets,validations}.ts   # globs (minimatch), check-ignore, críticos>exclusiones, regex secretos, esquema+hash de validaciones
    report.ts  license.ts (copiado; env CK_PRO_DEV)  guardrails.ts (tamaño, binarios, ráfagas, nº ficheros)  paths.ts (normalización win32/posix)
  vscode/
    watcher.ts                 # FileSystemWatcher por carpeta (creado ANTES de la línea base) + onDidChangeTextDocument/Save/Rename/Delete (solo file: dentro de carpetas); debounce; supresión de escrituras propias; watcher de .git/{HEAD,index,ORIG_HEAD,MERGE_HEAD,REBASE_HEAD}
    git.ts                     # API vscode.git (repos, path, estado initialized con timeout) + child_process: ls-files -s -z --recurse-submodules, status --porcelain=v2 -z, cat-file --batch --filters, check-ignore --stdin -z, ls-files --eol, check-attr
    views/{tree,statusBar,contentProvider,codelens,decorations}.ts   # árbol, `ck-baseline:`/`ck-empty:` providers, vscode.diff/changes, CodeLens por hunk, decoraciones
    review.ts                  # accept/discard/edit/restore/undo con applyEdit(isRefactoring) y verificación por hash; fallback fs atómico
    validate.ts                # Task API / CustomExecution; confirmación por comando + hash de script resuelto + origen de config; gate isTrusted
    hooks/{server,registry,installers/{claudeCode,codex,cursor},uninstall}.ts   # F5
  pro/{polarConfig,licenseService,features,statusBar}.ts   # F4 (copiado)
  hook/                        # F5: runner sin dependencia de Node (ver 4.6)
  test/unit/**  test/integration/{runTest.ts,suite/*}  test/fixtures/**
l10n/  media/  scripts/{l10n-sync.mjs,make-icon.mjs,metrics.mjs}  esbuild.mjs  docs/{PLAN,AUDITORIA,LANZAMIENTO,METRICAS,TUS-TAREAS(gitignored)}.md
```
Runtime en bundle: `diff` (jsdiff), `minimatch`, `ignore` (solo sin git). Todo lo demás dev.

### 4.2 Detección de cambios
- `workspace.createFileSystemWatcher(new RelativePattern(folder, '**/*'))` por carpeta (ve **cualquier proceso**; respeta `files.watcherExclude`; no sigue symlinks; el casing puede diferir → normalizar). Se crea **antes** de calcular la línea base y encola eventos.
- `onDidChangeTextDocument`/`onDidSaveTextDocument` (agentes que usan `WorkspaceEdit`), filtrando a esquema `file:` dentro de las carpetas (ignora `git:`, `output:`, `ck-baseline:`); `onDidRenameFiles/onDidDeleteFiles`; renombrados en disco inferidos por hash (D+A mismo sha → R). «Contenido actual» = documento abierto si existe, si no disco.
- Documentos **sucios al empezar** la sesión: su línea base es el texto del documento (no el disco).
- Exclusiones: `git check-ignore --stdin -z` (proceso persistente; primario) o lib `ignore` sin git; defaults `**/.git/**`, `**/node_modules/**`, `**/.vscode-test/**`, carpeta del almacén, `dist/out` **solo como default sustituible** (`changekeeper.exclude` reemplaza defaults; `excludeDefaults: false`); reglas de ignorado **congeladas al inicio de sesión** (cambios en `.gitignore`/`files.watcherExclude` durante la sesión → aviso, no aplicación silenciosa). **Los globs críticos prevalecen** sobre cualquier exclusión (con límite de tamaño).
- Coalescencia 300 ms por fichero; supresión de escrituras propias (conjunto en vuelo + hash) para que Restore no genere cambios fantasma; los tests simulan «CLI» escribiendo desde el proceso del test (no se suprime).
- **Ráfagas / operaciones git del agente:** >500 ficheros distintos en 5 s → pausa de incorporación + pregunta (Track anyway / Ignore burst / Add exclusion / **Re-baseline**); watcher de `.git/{HEAD,index,ORIG_HEAD,MERGE_HEAD,REBASE_HEAD}` → «El agente ha hecho commit/checkout/stash: Re-baseline · Pausar · Seguir». Submódulos: `ls-files --recurse-submodules` o sesión por repo anidado (`api.repositories`).
- Binarios (NUL en 8 KB) y >2 MB (configurable): hash/tamaño; bytes solo si ≤ límite; sin diff.

### 4.3 Línea base
- **Repo git:** (1) esperar `vscode.git` `state === 'initialized'` (timeout → `git` del PATH); (2) `git ls-files -s -z --recurse-submodules` → mapa ruta → **OID del blob del índice** (sin copiar nada); (3) `git status --porcelain=v2 -z --untracked-files=all` → sucios y no rastreados → copia al almacén (límites: >2.000 ficheros o >200 MB → aviso, sugerir exclusiones/`.gitignore`, continuar si el usuario quiere; progreso cancelable); (4) segundo `status` tras (3) → lo tocado en la ventana se marca «baseline uncertain». Nunca usar `repository.state.workingTreeChanges` (truncado por `git.statusLimit`).
- **Materialización por OID capturado** (no releyendo el índice): al **primer evento** de un fichero limpio se ejecuta en segundo plano `git cat-file --batch --filters` con `<oid> <path>` → forma de *checkout* (respeta `text`/`autocrlf`/`working-tree-encoding`); el objeto sobrevive a commit/checkout/stash/reset (solo `gc --prune` >2 semanas borra sueltos no alcanzables). `eol`/`bom` se registran **del fichero real** (`git ls-files --eol`, columna `w/`), nunca del blob. Ficheros con `filter=lfs` (`git check-attr`) → «baseline unavailable» (no se hace smudge: puede ir a red).
- **Sin git:** copia inicial de texto bajo límites (progreso; aviso si enorme). Sin línea base no hay diff/restauración: se dice «baseline unavailable for N files».
- Creados en sesión → «missing» → Restore = borrar (copia previa). Borrados → recrear.
- Manifiesto: `{ path, source: 'git-blob'|'store'|'doc'|'missing'|'uncertain', oid|sha256, size, mode, mtimeMs, eol, bom }`.
- **Promesa realista:** «sin copiar nada en repos git» (no «<1 s»): `status -uall` recorre el árbol y en Windows sin `fsmonitor` un repo de 50–100 k ficheros tarda segundos → medir en F1a, sugerir `core.untrackedCache`/`core.fsmonitor`.

### 4.4 Revisión, hunks y restauración
- Hunks con jsdiff sobre texto (sin reescribir EOL): **Discard = reemplazo por rango de líneas** (`newStart/newLines` → líneas de la línea base) con `workspace.applyEdit(edit, { isRefactoring: true })` para docs abiertos **y cerrados** (conserva EOL por línea, entra en undo; guardado según `files.refactoring.autoSave`, verificar en F1); fallback `fs` atómico (tmp+rename, reintentos EBUSY/EPERM). Verificación por hash del contenido sobre el que se calculó; si no coincide → recalcular y confirmar.
- ID de hunk = hash(rango en línea base + líneas eliminadas + añadidas); si el fichero cambia, se recalcula y se re-asocia; los que desaparecen (incl. tras un revert del gutter nativo) se archivan.
- **Diff nativo:** `vscode.diff(ck-baseline:…, fileUri)`; el gutter (`diffEditor.renderGutterMenu`, side-by-side) ofrece **revert de bloque** nativo (`diffEditor.revert`; **no hay «accept» nativo**) → contribuimos **Accept** en `menus."diffEditor/gutter/hunk"` y `"diffEditor/gutter/selection"` con `when: diffEditorOriginalUri =~ /^ck-baseline:/` (el argumento `{mapping, originalUri, modifiedUri, …}` es contrato interno sin d.ts → **test de integración** que lo fije; si rompe, el árbol/CodeLens siguen funcionando). Los bloques del gutter usan el diff de VS Code, no jsdiff → no 1:1 con nuestros hunks (documentado). `ck-empty:` para el lado ausente en A/D. `vscode.changes` es estático → «Review all» recalcula.
- **CodeLens por hunk + decoraciones** en el editor normal (API estable; equivalente publicable de la UX de hunkwise): `Accept · Discard · Open diff` sobre cada hunk; líneas añadidas resaltadas; borrados como marcador de gutter con hover del texto eliminado.
- **Restore session** = plan ordenado (por fichero: `before-restore` → escribir/borrar/recrear), resumen de fallos parciales; **Undo last restore** verificado por hash (el agente puede seguir escribiendo).
- Webview propia (checkboxes lado a lado): **no en 0.1.0**; se decide tras V1.

### 4.5 Validaciones y secretos (F4, Pro)
- Config `changekeeper.validations: [{ name, command, cwd?, runOn: 'manual'|'afterReview'|'onSessionEnd', timeoutSec }]`; presets detectados (`package.json` scripts lint/test/build, `tsc --noEmit`, `pytest`, `cargo check`, `go vet`) mostrando el **script resuelto**.
- Ejecución: `tasks.executeTask` con definición `{ type: 'shell', command, id: <propio> }` (comparar por `definition.id`, no por `===`; `exitCode` `undefined` si se mata; múltiples eventos de fin → idempotente); si el informe debe incluir la salida, `CustomExecution` + `Pseudoterminal` con `child_process`. Gate `workspace.isTrusted` (en Restricted Mode `executeTask` lanza).
- **Seguridad frente a config manipulada por el agente:** (a) `validations`, `exclude`, `critical` en `restrictedConfigurations`; (b) valores de ámbito workspace/folder (`inspect()`) solo se aplican tras **confirmación**, y se reconfirman al cambiar; (c) confirmación por **comando exacto + hash del script resuelto** (`package.json#scripts` u equivalente) guardados en `workspaceState`; (d) **no auto-ejecutar** (`runOn ≠ manual`) si hay cambios sin revisar en críticos; (e) texto claro: «una validación ejecuta código del repo que el agente ha podido tocar»; (f) cambios en `.vscode/**`, `.claude/**`, `.cursor/**`, `.github/**`, `package.json` durante la sesión = críticos.
- Secretos: regex locales sobre **líneas añadidas** (AWS `AKIA…`, GitHub `ghp_/github_pat_`, Slack `xox…`, bloques `PRIVATE KEY`, JWT, `api[_-]?key\s*[:=]`), redactados en informe/UI; sin red.
- Críticos por defecto: `**/migrations/**`, `**/*.sql`, `.github/workflows/**`, `**/Dockerfile*`, `**/docker-compose*`, `**/.env*`, `**/auth/**`, `**/security/**`, `package.json`, locks (`package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`), `requirements*.txt`, `pyproject.toml`, `*.csproj`, `*.tf`, `.vscode/**`, `.claude/**`, `.cursor/**`, `.github/**`.

### 4.6 Hooks e integraciones (F5, Pro; opt-in, consentimiento, revert, desinstalación)
- **Servidor local**: bind explícito `127.0.0.1` (no `localhost`), **puerto fijo por usuario** (configurable) + token en **cabecera propia** (fuerza preflight CORS: un navegador no puede postear), solo JSON, rutas recibidas validadas dentro del workspace. **Registro por ventana** `globalStorageUri/hooks/<pid>.json` `{folders, port, token}`; el receptor enruta por `cwd` del payload; lock para evitar que dos ventanas se pisen.
- **Runner sin Node** (Claude Code es binario nativo; `node` puede no estar en PATH; la ruta de la extensión cambia por versión): opción A hooks `type: "http"` de Claude Code contra el puerto local (fallo de conexión = aviso no bloqueante; sopesar `.claude/settings.local.json` por proyecto para no molestar fuera de VS Code); opción B script `sh`/PowerShell con `curl` copiado a **ruta estable** `globalStorageUri/hooks/` y actualizado en `activate`. Script `vscode:uninstall` que retira los hooks. Medir latencia por edición en Windows.
- **Claude Code**: `SessionStart` (matcher `startup|resume|clear|compact|fork`), `Stop`, `PostToolUse` (matcher `Edit|Write|NotebookEdit`; `MultiEdit` ya no existe). Reglas: **stdout vacío siempre** (en `SessionStart` el stdout se añade al contexto; JSON en stdout influye), `timeout` explícito, nunca decisiones de permisos (lección de Handsfree). Solo se etiquetan Edit/Write/NotebookEdit; Bash queda «unattributed».
- **Copilot/VS Code** lee `.github/hooks/*.json`, `~/.copilot/hooks` **y también `~/.claude/settings.json`** → nuestros hooks se dispararán también desde Copilot con otro `tool_name`/`tool_input`: el receptor **tolera payloads distintos** y etiqueta por forma del JSON. **Codex**: hooks reales (`~/.codex/hooks.json`, `.codex/hooks.json`, `[hooks]` en `config.toml`; SessionStart/PostToolUse/Stop). **Cursor**: `~/.cursor/hooks.json` / `.cursor/hooks.json` (`afterFileEdit {file_path, edits}`). Instaladores propios por agente; verificar forma exacta de `tool_input` (Copilot, Codex `apply_patch`) en F5.
- Detección pasiva (mtime de `~/.claude/projects/<slug>/*.jsonl`) **solo** como sugerencia de arranque cuando no hay hooks; no es plan A.
- Sin hooks todo funciona igual (sesión automática) con atribución «unattributed».

### 4.7 Almacenamiento y datos
`globalStorageUri/workspaces/<sha256(clave)>/{index.json, lock.json, sessions/<id>.json, objects/<sha256>.blob}` con **clave normalizada** (`Uri.fsPath`, letra de unidad en minúscula, sin barra final, `\`→`/`); **lock por pid** (segunda ventana con la misma carpeta = solo lectura); GC en idle/cierre de sesión (nunca la activa; tope de tamaño solo sobre cerradas); «Purge all data»; nada en el repo del usuario; downgrade Pro→Free nunca borra automáticamente (avisa).

### 4.8 Windows de primera
CRLF/BOM preservados por línea; `EBUSY/EPERM` con reintentos (Defender/OneDrive); rutas largas; watcher case-insensitive; `path.win32/posix` en tests; CI Windows + Ubuntu; fixture git con `core.autocrlf=true` **y** `false`.

### 4.9 Rendimiento (medir en F1a, no prometer)
Activación sin sesión <50 ms; inicio de sesión git = `ls-files` + `status` (medir con 50 k en Windows); coste por evento <5 ms; diff de 10 k líneas <100 ms; hunks lazy por fichero; reanudación con progreso.

---

## 5. Fases, entregables y puertas

Cada fase termina con `npm run check` verde, integración hermética verde (Windows + Ubuntu), **auditoría independiente** (tabla en `docs/AUDITORIA.md`) y hallazgos aplicados. Estimaciones en tiempo de agente **ya multiplicadas ×2** respecto a la v1; el calendario real lo marcan las tareas humanas.

| Fase | Contenido | Pruebas | Puerta |
|---|---|---|---|
| **F1a Motor (Free)** — 3-4 días | store (atómico, lock, GC), session (persistencia, reanudación/reconciliación), baseline git por OID + `--filters` + eol real + LFS + uncertain, sin git, watcher (antes de baseline, supresión, ráfagas, `.git/HEAD…`), exclusiones (check-ignore, congeladas, críticos prevalecen), changes/hunks/IDs, guardarraíles, l10n base | unit ≥50: store, hunks/rango/EOL mixto/BOM, manifest, exclusiones vs críticos, ráfagas, claves win32/posix, autocrlf | Auditoría F1a |
| **F1b UI y restauración (Free)** — 2-3 días | árbol, status bar, `ck-baseline:`/`ck-empty:`, `vscode.diff`/`vscode.changes`, Accept en gutter (menús), Discard por rango con `applyEdit`, Restore fichero/sesión + Undo verificado, autoStart `git`, aviso primera vez, «New session/Stop» | integración: workspace temporal + repo fixture (`user.*`, `commit.gpgsign=false`, autocrlf true/false); esperar `getAPI(1).state==='initialized'`; cambios por `fs` (CLI) y `applyEdit` (editor); polling con timeout (no sleeps); «recarga» = 2.ª invocación con el mismo `--user-data-dir`; commit del agente a mitad + Re-baseline | Auditoría F1b |
| **F2 Hunks inline + críticos + informe (Free)** — 2-3 días | CodeLens por hunk + decoraciones, contadores, re-asociación, insignias critical, «Mark session reviewed», informe en pantalla + export .md, Purge | unit estados/informe; integración CodeLens accept/discard doc abierto y cerrado | Auditoría F2 |
| **F3 Publicación 0.1.0 (gratis)** — 1-2 días | icono 256 px (paleta Argalla), README EN/ES (Install arriba, Requirements, limitación «sin VS Code abierto», Privacy, «Not affiliated»), CHANGELOG, PRIVACY(.es), SECURITY, CONTRIBUTING, LICENSE; ci/release/dependabot de `plantillas/` (guarda de Polar añadida en F4); `.vscodeignore`; **description 0.1.0 sin «validate» ni Pro**; `.vsix` en VS Code limpio y VSCodium; medir activación | l10n-sync + tests en CI; instalación desde tienda como cliente | Auditoría F3 → **tag v0.1.0** |
| **V1 Puerta de validación** (humano + agente, en paralelo con F4 solo si hay señal) | Guion de entrevistas escrito **en D0**; ≥8 de las 15 conversaciones hechas; prueba real en Windows con **2 agentes** (Claude Code + Codex CLI o Copilot); dogfooding del humano; feedback de 0.1.0 (issues/Discussions/ratings) | — | Si no hay señal → replantear posicionamiento antes de F4/F5 |
| **F4 Pro + Polar** — 3-4 días | validaciones (Task/CustomExecution, confirmaciones, hash de script, restricted), secretos, críticos propios, commit message al SCM, retención configurable, `license.ts`/`licenseService` (env `CK_PRO_DEV`), producto Polar «ChangeKeeper Pro» (benefit License Keys, prefijo `CKP`, límite 3, never expires), `pricing: "Trial"`, release.yml con guarda de Polar, description 0.2.0 | unit reglas/secretos/report/licencia/«quitar es gratis»; integración validación con comando falso + timeout + config de workspace sin confirmar; prueba real cupón 100 % (clic real) + revocación; `CK_PRO_DEV` ausente en el entorno del usuario | Auditoría F4 → **tag v0.2.0** |
| **F5 Hooks** — 3 días | servidor + registro por ventana, runner sin Node (http o sh/ps+curl), instalador Claude Code (consentimiento, vista previa JSON, backup byte a byte, revert, doctor, uninstall), receptor tolerante (Copilot vía mismo fichero), Codex/Cursor si se verifica el payload, etiqueta de agente, `whenAgentDetected` | unit instalador idempotente/no toca otros hooks; integración POST simulados; latencia medida en Windows | Auditoría F5 → **tag v0.3.0** |
| **F6 Lanzamiento** — 1 día + espera | `docs/LANZAMIENTO.md` EN/ES, demo GIF «cambio peligroso evitado» (migración + `.env` + secreto), canales §10, `docs/METRICAS.md` + `scripts/metrics.mjs` (copiar de Handsfree) | — | Revisiones 30/60 días |

**Backlog (tras V1/60 días):** webview lado a lado; sesiones comparadas; políticas por repo (`.changekeeper.json`, con confirmación); «CLI companion» para capturar sin VS Code abierto; opt-in «Share anonymous stats»; Team (backend de **metadatos**, nunca código); cuerpo de PR desde el informe (GitHub/GitLab).

---

## 6. Cuentas, tokens y publicación (guía §4–§5; casi todo REUTILIZADO)
- Marketplace: publisher `argalla` ✓; `VSCE_PAT` de organización `tecniartgalicia` ✓ (caduca 2027-08-13). Solo subir el secreto al repo nuevo (`ghsecret.mjs VSCE_PAT`). Los tokens **no** se duplican: viven en `Documents/handsfree-secrets.txt` (fuente única, con comentario de que sirven a todas las extensiones de `argalla`); `Documents/changekeeper-secrets.txt` solo para lo específico (Polar/producto).
- Open VSX: `OVSX_PAT` ✓, namespace `argalla` **verificado** ✓ → sin issue nueva.
- GitHub: repo público `TecniartGalicia/changekeeper` (Discussions + Private vulnerability reporting + topics); secretos por API; acciones fijadas por SHA (plantillas).
- Polar: org `argalla` aprobada ✓ → nuevo producto + benefit + checkout link (F4) → `polarConfig.ts`; prueba con cupón 100 % (1 uso) y clic real por hCaptcha; revocar y borrar después.
- `description` **0.1.0**: *«Keep, review hunk by hunk and roll back every change your AI coding agent makes — including edits made from the shell. Works with Claude Code, Codex, Copilot, Cursor and more. Local-first, no telemetry. Not affiliated with any agent vendor.»* · **0.2.0**: añade «validate» («…review hunk by hunk, validate and roll back…»). Ambas revisadas contra el filtro §5.3 (nada de «keeps asking», «bypass», «auto-approve»).
- Límite de extensiones nuevas por 12 h: sin extensiones de diagnóstico salvo rechazo real. `pricing` Free→Trial entre versiones: sin política escrita conocida; si diera problema, se consulta a VSMarketplace@microsoft.com.

---

## 7. Riesgos y mitigaciones
| Riesgo | Mitigación |
|---|---|
| Nombre con conflicto (como el original) | Barrido en 5 fuentes hecho; repetir el día de la creación; A1 humano; sin rastro del nombre ajeno |
| Claude Code añade accept/reject por hunk nativo (issue #61794) o VS Code generaliza checkpoints | Plan B ya en producto: shell edits, cross-agent, validaciones/críticos/informe/hooks; velocidad de iteración; el núcleo sigue útil |
| hunkwise u otro sale al Marketplace con API estable | Publicar 0.1.0 pronto; calidad (tests, Windows, EN/ES); Pro por valor añadido |
| Cambios de usuario y agente mezclados | Sesión como unidad; hooks etiquetan; nunca fingir; excluir/aceptar hunks propios |
| Línea base incorrecta (autocrlf, LFS, encoding, carrera) | OID capturado al inicio + `--filters` + eol real + LFS unavailable + watcher antes + segundo status; tests autocrlf |
| El agente hace commit/checkout/stash/rebase | Materialización por OID; watcher `.git/*` → Re-baseline/Pausa; test específico |
| Ráfagas (npm install, build) | Guardarraíl + defaults + `.gitignore` congelado + Re-baseline |
| Config manipulada por el agente (`.vscode/settings.json`, `.gitignore`, `package.json#scripts`, `files.watcherExclude`) | Restricted configurations, confirmación por origen y por hash de script, reglas congeladas, avisos, críticos, sin auto-run con críticos sin revisar |
| Hooks rompen al agente o al usuario fuera de VS Code | stdout vacío, timeout, exit 0, nunca permisos; runner sin Node en ruta estable; opción por proyecto; revert/uninstall/doctor |
| Dos ventanas con la misma carpeta | Lock por pid; registro de hooks por ventana |
| Marketplace: filtro / marcas | Descripciones neutras; «Not affiliated»; sin logos; sin nombre ajeno |
| Rendimiento en monorepos | Baseline sin copias; hunks lazy; medir en Windows; sugerir untrackedCache/fsmonitor |
| Poca disposición a pagar | Núcleo gratis excelente; Pro barato y de pago único; Team solo con compromisos |
| Sin VS Code abierto no hay captura | Documentado; «CLI companion» en backlog |
| Windows: locks, CRLF, rutas | Reintentos, EOL por línea, tests win32, CI Windows |

---

## 8. Calendario orientativo, validación y criterios (desde la decisión de nombre = D0)
- **Semanas 1-2:** F1a + F1b (con auditorías). **Semana 3:** F2 + F3 → **v0.1.0 gratis**. **Semanas 3-5:** V1 (entrevistas, 2 agentes, dogfooding, feedback). **Semanas 5-6:** F4 → **v0.2.0 Pro** (solo si V1 da señal). **Semana 6-7:** F5 → **v0.3.0**. Lanzamiento escalonado (§10). En paralelo desde D0 (humano): guion de entrevistas, lista de 15 candidatos y 3 posibles pilotos, cuentas de redes calentándose, precio.
- **30 días** (desde 0.1.0) = validación **cualitativa** (README de ideasVs): 15 entrevistas · 5 demos · 3 compromisos (piloto/carta/pago) · funcionamiento con ≥2 agentes reales. **60 días** = decisión **cuantitativa** (como Handsfree): >2.500 instalaciones o >30 ventas Pro → seguir invirtiendo; 800–2.500 → mantenimiento; <800 → congelar. **Team** solo con ≥3 compromisos reales, nunca por instalaciones.
- Seguimiento unificado con Handsfree (mismo humano, mismas cuentas): calendario de contenidos y `METRICAS.md` común en Argalla.

## 9. Métricas sin telemetría
No hay telemetría, luego las métricas de la ficha (activaciones, hunks rechazados, conversión) **no son medibles**; proxies: Marketplace Manage → Reports (instalaciones/desinstalaciones), Open VSX (descargas), ratings/Q&A, issues y Discussions, ventas y reembolsos en Polar, entrevistas. Reutilizar `scripts/metrics.mjs` + `docs/METRICAS.md` + `docs/PLAN-SEGUIMIENTO.md` de Handsfree. Un comando **opt-in explícito** «Share anonymous stats» (nunca por defecto) queda en backlog si hace falta señal de uso.

## 10. Lanzamiento (guía §7 + auditoría)
- **Soft-launch 0.1.0 (sin filtros de cuenta):** GitHub Discussions «Show and tell» de `anthropics/claude-code`, dev.to, PR a `awesome-claude-code`/`awesome-vscode`, HN «Show» (horario US), Discord de Anthropic/VS Code (humano).
- **Reddit** condicionado a antigüedad/karma (cuenta `Argalla-Tecnoloxia` creada 2026-08-15): r/ClaudeAI, r/ClaudeCode, r/codex, r/cursor, r/GithubCopilot, r/vscode; con fecha de reintento y desde cuenta personal antigua si la hay.
- X @ArgallaTec (hilo ≤280/post) y LinkedIn (post bilingüe): con la 0.2.0 (Pro) o cuando haya demo GIF.
- Textos EN/ES en `docs/LANZAMIENTO.md`: sin marca ajena al frente, «Not affiliated», recomendación honesta («si tu agente ya tiene Keep/Undo y no usas CLI, quizá no lo necesitas»), URLs reales, registro de publicaciones y reintentos.

## 11. Checklist maestro adaptado (guía §10)
**A. Preparación** — [ ] Nombre/ID (A1) · [ ] precio (A2) · [ ] carpeta renombrada y sin «agent change guard» · [ ] `docs/TUS-TAREAS.md` A/B/C + calendario · [ ] guion de entrevistas · [ ] cuentas de lanzamiento calentándose.
**B. Código** — [ ] F1a → aud. · [ ] F1b → aud. · [ ] F2 → aud. · [ ] F3 → aud. → v0.1.0 · [ ] V1 · [ ] F4 → aud. → v0.2.0 · [ ] F5 → aud. → v0.3.0.
**C. Cuentas** — [ ] repo GitHub + secretos VSCE_PAT/OVSX_PAT · [ ] producto Polar + benefit + checkout → `polarConfig.ts` (antes de anunciar Pro).
**D. Publicación** — [ ] descriptions revisadas (0.1.0 sin Pro) · [ ] tags → workflow verde → 3 tiendas → instalar desde tienda · [ ] prueba real de compra con cupón.
**E. Lanzamiento y después** — [ ] LANZAMIENTO.md · [ ] soft-launch → redes · [ ] revisiones 30/60 días · [ ] memoria del agente al día.

## 12. Lo que solo puede hacer el humano (detalle con casillas y fechas en `docs/TUS-TAREAS.md`)
A1 nombre (recomendación ChangeKeeper; opcional dominio/EUIPO) · A2 precio Pro (7 € recomendado) · A3 aceptar que la extensión pueda tocar `~/.claude/settings.json` (solo F5, opt-in) · A4 cuentas de lanzamiento (Reddit/X/LinkedIn/Discord) · A5 guion + lista de 15 entrevistados y 3 pilotos · A6 acceso a un 2.º agente real en Windows (Codex CLI/Copilot; Cursor no está instalado) · A7 dogfooding en su flujo · B1 iniciar sesión en Polar cuando toque · B2 revisión legal de PRIVACY (snapshots con secretos) · C1 aprobar textos de lanzamiento · C2 decisión Team a 60 días · Calendario: PAT 2027-08-13, revisiones 30/60 días, reintentos Reddit.
