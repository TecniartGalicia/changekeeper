# Auditorías por fase — ChangeKeeper (nombre provisional)

Cada fase se cierra con una revisión independiente (agente revisor sin contexto de la implementación). Se registran los hallazgos y qué se hizo con cada uno. Patrón heredado de `handsfree-claude-code/docs/AUDITORIA.md`.

## Auditoría 0 · PLAN.md v1 (2026-08-16)

Dos revisores independientes sobre `docs/PLAN.md` v1: **T** = lente técnica (API de VS Code, git, hooks, arquitectura; verificó afirmaciones contra docs oficiales y fuente de VS Code) y **P** = lente de producto/proceso (guía maestra, README de ideasVs, nombre/marcas, Free/Pro, validación, lanzamiento, tareas humanas). Resultado: 24 + 25 hallazgos; **todos aplicados en PLAN.md v2** salvo los marcados «Aceptado con matiz» o «Descartado».

### T · Técnica

| # | Sev. | Hallazgo (resumen) | Resolución en PLAN v2 |
|---|------|--------------------|-----------------------|
| T1 | Alta | El blob del índice git no son los bytes del working tree (`autocrlf`, LFS pointer, `working-tree-encoding`): diff «todo cambiado» en Windows y Restore escribiría LF/pointer/UTF-8; `eol` no puede venir del blob | §4.3: materializar con `git cat-file --batch --filters` (`<oid> <path>`); `eol/bom` del fichero real (`ls-files --eol`); `filter=lfs` → baseline unavailable; fixture con `autocrlf=true` y `false` (§4.8, F1b) |
| T2 | Alta | Carrera: materializar «al primer evento» releyendo el índice pierde la línea base si el agente hace `edit && git add && commit` en un Bash; y el watcher se creaba después de `ls-files`/`status` | §4.3: materializar **por el OID capturado al inicio** (sobrevive a commit/checkout/stash; gc >2 semanas); watchers **antes** de la línea base con cola; segundo `status` → «uncertain»; materialización en background al evento |
| T3 | Alta | Contradicción: exclusión por `.gitignore` vs críticos `.env*`, `.claude/**` (casi siempre ignorados) → justo lo prometido no se vigila | §3.1/§4.2: **los globs críticos prevalecen sobre las exclusiones** (con límite de tamaño); test «`.env` ignorado editado aparece como crítico» |
| T4 | Alta | Hook `node <ext>/dist/hook.js`: Claude Code es binario nativo (Node puede faltar), la ruta de la extensión cambia por versión, `hook.json` único se pisa entre ventanas | §4.6: runner sin Node (hooks `type: http` contra puerto fijo por usuario, o sh/PowerShell+curl) en ruta estable `globalStorageUri/hooks/`; registro por ventana `<pid>.json` enrutado por `cwd`; opción por proyecto; `vscode:uninstall` |
| T5 | Alta | Solo se protegía el origen de `validations`; el agente puede poner `exclude: ["**"]`, `files.watcherExclude`, `.gitignore`, o cambiar `scripts.lint` en `package.json` | §4.5: `restrictedConfigurations`; valores de workspace solo tras confirmación y reconfirmar al cambiar; hash del script resuelto; reglas de ignorado congeladas; aviso si cambia `files.watcherExclude`; sin auto-run con críticos sin revisar; texto explícito |
| T6 | Alta | «<1 s en cualquier tamaño» es optimista: `status -uall` recorre el árbol (segundos en Windows con 50–100 k); `vscode.git` descubre repos asíncronamente; `workingTreeChanges` está truncado | §4.3/§4.9: promesa rebajada a «sin copiar nada»; medir en F1a; progreso cancelable; esperar `state==='initialized'` con timeout; sugerir `untrackedCache`/`fsmonitor`; nunca `workingTreeChanges` |
| T7 | Media | Gutter del diff: solo hay **revert** nativo (no «accept»); los bloques usan el diff de VS Code (no jsdiff); `vscode.diff` con lado inexistente falla | §4.4: Accept contribuido en `menus.diffEditor/gutter/hunk|selection` con `when` sobre `ck-baseline:` (contrato interno → test de integración); hunks no 1:1 documentado; `ck-empty:` para A/D |
| T8 | Media | Normalizar a `\n` y reescribir con EOL dominante homogeneiza ficheros mixtos; escribir a disco con doc cerrado se salta el modelo de VS Code | §4.4: Discard = **reemplazo por rango de líneas** con `applyEdit(isRefactoring)` también en docs cerrados; fs solo fallback |
| T9 | Media | «<50 ms sin I/O» choca con GC al activar y con reanudar sesión (hay que reconciliar lo cambiado con VS Code cerrado) | §2.9/§4.7: GC en idle/cierre; reanudación con reconciliación y progreso; medir por separado |
| T10 | Media | Misma carpeta en dos ventanas → dos watchers pisando `index.json`; hooks a la ventana equivocada | §4.7: `lock.json` por pid (2.ª ventana solo lectura); §4.6 registro por ventana |
| T11 | Media | Hooks de Copilot (`.github/hooks`, `~/.copilot/hooks` **y `~/.claude/settings.json`**), Codex (`hooks.json`, `[hooks]`) y Cursor (`hooks.json` `afterFileEdit`) son reales; el plan los daba por dudosos y la detección pasiva por mtime como plan A | §4.6 reescrito: receptor tolerante a payloads; Copilot cubierto por el mismo fichero; instaladores Codex/Cursor; detección pasiva solo como sugerencia |
| T12 | Media | Exit 0 no basta: stdout JSON influye y en `SessionStart` se añade al contexto; `MultiEdit` ya no existe; ediciones por Bash no se atribuyen; timeout por defecto 600 s | §4.6: stdout vacío siempre, timeout explícito, matcher `Edit|Write|NotebookEdit`, Bash «unattributed» documentado |
| T13 | Media | `git checkout/stash/reset` del agente vuelca miles de ficheros; `.git/HEAD|index` sí emiten eventos; submódulos (`160000`) | §4.2: watcher de `.git/{HEAD,index,ORIG_HEAD,MERGE_HEAD,REBASE_HEAD}` → Re-baseline/Pausar; `ls-files --recurse-submodules` o sesión por repo anidado |
| T14 | Media | Ediciones sin guardar al iniciar → aparecerían como «del agente»; `onDidChangeTextDocument` dispara para `git:`, `output:`, `ck-baseline:` | §4.2/§3.1: línea base = texto del documento si está abierto y sucio; filtrar a `file:` dentro de carpetas |
| T15 | Media | Tests: latencia del watcher en CI Windows, fixture git (`autocrlf=false`, `user.*`, `gpgsign=false`), esperar API git, «recarga» = 2.ª invocación con el mismo `--user-data-dir`; `--disable-extensions` mantiene built-ins | Fila F1b de §5 |
| T16 | Media | Task API: `exitCode` `undefined` si se mata; `TaskExecution` no `===`; múltiples eventos de fin; sin salida; Restricted Mode lanza | §4.5: definición con `id` propio, idempotencia, `CustomExecution`+`Pseudoterminal` para salida, gate `isTrusted` |
| T17 | Media | Clave `sha256(ruta)`: `c:\` vs `C:\` y barra final → sesiones perdidas | §4.7: normalización (fsPath, minúscula, sin barra, `/`); test win32 |
| T18 | Media | «Undo restore» sin verificar cambios posteriores; Restore session no transaccional | §4.4: verificación por hash; plan ordenado con `before-restore` por fichero y resumen de fallos |
| T19 | Baja | Lib `ignore` pierde `.git/info/exclude`, `core.excludesFile` | §4.2: `git check-ignore --stdin -z` primario; `ignore` solo sin git |
| T20 | Baja | Servidor local: bind `127.0.0.1` explícito, token en cabecera (preflight CORS), solo JSON, validar rutas | §4.6 |
| T21 | Baja | `dist/out` excluidos sin forma de des-excluir | §4.2: `changekeeper.exclude` sustituye defaults / `excludeDefaults: false` |
| T22 | Baja | `vscode.changes` es estático | §4.4: «Review all» recalcula; documentado |
| T23 | Baja | `onUri` sin uso | §2.9: eliminado |
| T24 | Baja | F1 en 2-3 días irreal | §5: F1a (3-4) + F1b (2-3); resto ×2 |

Verificado OK por T (con URL en el informe original): `vscode.changes`/`vscode.diff`; gutter `diffEditor.revert` con `diffEditorModifiedWritable`; `createFileSystemWatcher` (procesos externos, `files.watcherExclude`, casing); `TextDocumentContentChangeEvent` sin texto anterior; API `vscode.git` (`git.path`, `show/buffer` solo por ref+path); `ls-files -s`, `cat-file --batch`, prune 2 semanas, índice como raíz; `executeTask`/`TaskProcessEndEvent`; hooks de Claude Code (eventos, stdin, `type: http`, timeout, Windows Git Bash/PowerShell); hooks de Copilot/Codex/Cursor; `onStartupFinished`/`onView`; `extensionKind: workspace`; `untrustedWorkspaces: limited` + `restrictedConfigurations`; `globalStorageUri`/`workspaceState`; `WorkspaceEditMetadata.isRefactoring` en 1.95; jsdiff `structuredPatch/reversePatch/applyPatch`; `--disable-extensions` mantiene built-ins; Claude Code nativo sin Node.
No verificado por T (a comprobar en la fase correspondiente): forma exacta de `tool_input` de Copilot y Codex `apply_patch` (F5); tiempos de `git status -uall` en Windows con 50 k (F1a); estabilidad del contrato de `diffEditor/gutter/hunk` (F1b, test); `applyEdit(isRefactoring)` con `files.refactoring.autoSave=false` en docs cerrados (F1b); EBUSY/EPERM bajo Defender/OneDrive (F1a); `allowedHttpHookUrls` de Claude Code (F5).

### P · Producto / proceso

| # | Sev. | Hallazgo (resumen) | Resolución en PLAN v2 |
|---|------|--------------------|-----------------------|
| P1 | Alta | «Change Warden» es un producto ITSM real en Microsoft AppSource; «Diff Warden» quemado por `pi-diffwarden` (npm) | §1: descartados; barrido ampliado (Marketplace, Open VSX, npm, GitHub, web) → **ChangeKeeper** recomendado (limpio), HunkGuard y Vigía como alternativas; A1 humano con opción de dominio/EUIPO |
| P2 | Alta | El plan construía F1–F5 completos antes de las 15 entrevistas / 5 demos / 3 compromisos que exige el README de ideasVs | §0/§5/§8: 0.1.0 = prototipo público; **puerta V1** entre F3 y F4 (guion en D0, ≥8 conversaciones, 2 agentes reales en Windows, dogfooding); sin señal → replantear antes de Pro/hooks |
| P3 | Alta | Sin telemetría ninguna métrica de la ficha es medible; no se reutilizaba `metrics.mjs`/METRICAS/PLAN-SEGUIMIENTO de Handsfree | §9: proxies (Reports, Open VSX, ratings, issues, Polar, entrevistas); copiar `metrics.mjs`+METRICAS; opt-in «Share anonymous stats» en backlog; seguimiento unificado con Handsfree |
| P4 | Alta | «Sin hunks» en la fila de nativos era falso (Copilot Keep/Undo por bloque, Cursor); issue `claude-code#61794` pide hunks nativos → riesgo | §0/§1/§7: tabla corregida; posicionamiento **CLI agents + shell edits + cross-agent + validación**; riesgo y plan B añadidos |
| P5 | Media | La `description` anunciaba «validate» (Pro) en la 0.1.0 gratuita; README/CHANGELOG 0.1.0 sin regla | §2.6/§6: dos descriptions (0.1.0 sin validate/Pro; 0.2.0 con); puerta F3 lo comprueba |
| P6 | Media | Retención Free 7 días/200 MB rompe la promesa de restaurar y arriesga GC de la sesión activa; regresión 0.1.0→0.2.0 | §3.3/§4.7: Free 30 días; nunca GC de la sesión activa; tope solo sobre cerradas; misma retención en 0.1.0; downgrade nunca borra |
| P7 | Media | Arranque automático era Pro/F5 → nadie pulsa Start → validación con falso negativo; contradice la ficha | §2.12: `autoStart: "git"` por defecto en Free 0.1.0 (línea base sin copiar); Pro = etiqueta/hook y `whenAgentDetected` |
| P8 | Media | Estimaciones irreales (F1 2-3 días; 0.1.0 en la semana 1) | §5/§8: ×2, F1 partida, calendario por semanas |
| P9 | Media | Lanzamiento Reddit/X con cuentas nuevas (Reddit creada 2026-08-15); r/ChatGPTCoding no natural; faltaban canales sin filtro | §10: soft-launch (Discussions de claude-code, dev.to, awesome-*, HN Show, Discord), Reddit condicionado a karma/antigüedad con subs por agente, X/LinkedIn con la 0.2.0/demo |
| P10 | Media | Criterios con «OR» dispararían Team por instalaciones sin ventas; 30 vs 60 días sin aclarar | §8: Team solo con ≥3 compromisos; 30 días = cualitativa; 60 días = cuantitativa por tramos (>2.500 o >30 / 800–2.500 / <800) |
| P11 | Media | `.env*` crítico pero excluido por `.gitignore` | = T3 (§3.1/§4.2) |
| P12 | Media | Confirmación por «comando exacto» no protege presets `npm run lint/test` | = T5: hash del script resuelto (§4.5) |
| P13 | Media | Ruta versionada del hook, afecta a todos los proyectos y a Claude fuera de VS Code; latencia sin medir | = T4 (§4.6): ruta estable, opción por proyecto, uninstall, medir |
| P14 | Media | Regla «quitar lo que Pro añadió es gratis» no explicitada | §2.4/§3.3: declarada (revert hooks, borrar reglas, purgar, leer/restaurar lo retenido) + `ensurePro` solo protege añadir + test |
| P15 | Media | TUS-TAREAS incompleto (marca, PRIVACY legal, calendario, 2.º agente, Discord, textos, dogfooding, entrevistados/pilotos, «0.1.0 menciona Pro», tocar `~/.claude/settings.json`) | `docs/TUS-TAREAS.md` creado con A/B/C + calendario incluyendo todo; §12 |
| P16 | Media | La cabecera decía «auditado» y remitía a ficheros inexistentes | Cabecera v2 + este fichero + TUS-TAREAS creados |
| P17 | Baja | `HANDSFREE_PRO_DEV=1` copiado desbloquearía Pro en este producto | §4.1/§5 F4: env `CK_PRO_DEV`; comprobación de ausencia en la prueba real |
| P18 | Baja | Tokens duplicados en dos ficheros de secretos | §6: fuente única `handsfree-secrets.txt` (comentario «sirven a todo `argalla`»); `changekeeper-secrets.txt` solo Polar/producto |
| P19 | Baja | Riesgo de dejar «agent change guard» en keywords/carpeta/docs | §1/§2.1: prohibido; renombrar carpeta y limpiar al fijar nombre |
| P20 | Baja | Export `.md` en Pro pierde efecto viral | §3.3: export `.md` en Free; commit message al SCM en Pro |
| P21 | Baja | Textos del flujo prometían insignia «secret?» e informe con validaciones en Free | §3.2 ajustado |
| P22 | Baja | 9 € vs 7 € sin justificación | §2.4: recomendación 7 € (unificar) con 9 € como alternativa razonada; A2 |
| P23 | Baja | Dos productos, mismo humano, mismas cuentas nuevas | §8/§9: seguimiento y calendario de contenidos unificados con Handsfree |
| P24 | Baja | Sin VS Code abierto no hay captura; no documentado | §2.10/§7: limitación en README; «CLI companion» en backlog |
| P25 | Baja | Formato de la description con cuatro marcas | §6: «Works with … and more» + disclaimer |

Comprobado OK por P: orden de fases coherente con la guía; `pricing` Free→Trial coherente con la regla de oro si 0.1.0 no anuncia Pro (aplicado); reutilización correcta de VSCE_PAT/OVSX_PAT/namespace/Polar/token GitHub/herramientas de navegador; description sin frases del filtro; gotchas §11 cubiertos (1, 2, 5-8, 13, 14, 15); «Not affiliated», MIT, EN/ES, `^1.95`, `preview`, `extensionKind`, untrusted limited, sin telemetría; nombre original detectado como ocupado; Team fuera y sin límite «1 repositorio»; privacidad local con Purge; `before-restore` = regla de la guía.
No verificado por P: registro de marca de los candidatos en EUIPO/USPTO/OEPM; dominios; política del Marketplace para cambiar `pricing` entre versiones; estado real (karma) de las cuentas de Argalla.

### Hallazgos propios durante la auditoría (agente principal)
- `molon/hunkwise` (GitHub, no publicable por usar API propuesta `editorInsets`) hace accept/discard por hunk inline para cualquier cambio externo → añadido a §1 y §7; nuestra respuesta: CodeLens + decoraciones + gutter nativo (API estable) en F2.
- Handsfree tiene `scripts/metrics.mjs`, `docs/METRICAS.md`, `docs/DIFUSION.md`, `docs/PLAN-SEGUIMIENTO.md` → reutilizables (§9).

**Estado tras la Auditoría 0:** PLAN.md v2 escrito; sin código aún. Siguiente puerta: decisión de nombre (A1) → F1a.

## F1a · Motor (`src/core`) — auditoría del 2026-08-16

Revisor independiente sobre el commit `166639f`: lectura completa, `npm test`, **fuzz de 135.587 casos** sobre `computeHunks/discardHunkOnLines` (limpio) y scripts contra git 2.55 real. 27 hallazgos; todos aplicados en `7f3db21` salvo los marcados.

| # | Sev. | Hallazgo (resumen) | Resolución |
|---|------|--------------------|------------|
| A1 | Alta | Ficheros no UTF-8 se corrompían al descartar (decodificación con pérdida + reescritura completa) | `decodeText` con `TextDecoder(fatal)`; si falla, latin1 (biyectivo) y `encoding` recordado; `planDiscard` recodifica igual; docs abiertos se hashean con la codificación del disco. Test A1 (bytes idénticos) |
| A2 | Alta | Críticos ignorados **preexistentes** (`.env`) sin línea base → «Restore» los borraba | `status --ignored=matching`; entradas `!` críticas se copian al store; en plain, `skipDir` solo salta hard/heavy. Test A2 (M con hunks, restore intacto) |
| A3 | Alta | `cat-file --batch --filters` con ruta relativa a la carpeta: atributos por ruta mal resueltos en subcarpetas | Ruta = `gitPrefix + rel`. Test A3 (`.gitattributes` `sub/*.txt eol=crlf`) |
| A4 | Media | Re-baseline perdía el lock | `stop({ keepLock })` antes de crear la sesión; test A4 |
| A5 | Media | `fileAccepted` aceptaba en silencio ediciones posteriores | Se anula al cambiar el sha; los hunks aceptados conservan su estado por id; test A5 |
| A6 | Media | `reconcile` ignoraba filas `store/missing/uncertain/unavailable` | Todas las filas no git-blob son candidatas; test A6 |
| A7 | Media | Submódulos: OIDs de otro ODB → «blob-missing» y ficheros dentro como «nuevos» | Se detectan gitlinks; sus ficheros quedan `unavailable:submodule` (honesto); test A7. Materializar con `git -C <sub>` queda en backlog |
| A8 | Media | Ventana de copia sin detección de contenido | Re-stat (size/mtime) tras el 2.º status → `uncertain`; test A8 |
| A9 | Media | Materialización sin tope de tamaño | `cat-file --batch-check` antes; `> maxFileBytes` → `unavailable:large`; test A9 |
| A10 | Media | Renombrado dependía del orden A/D y duplicaba la D en contadores | Detección simétrica (la D convierte la A en R; la fuente que reaparece deshace la R); la D pareja no se cuenta; test A10 |
| A11 | Media | Temporales de `atomicWrite` visibles para el watcher | Sufijo `.ck-tmp` + `HARD_EXCLUDES` + filtro en `enqueueUri` |
| A12 | Media | Un spawn de `check-ignore` por ruta | `prefetchIgnore()` en lote (reconcile, burst, drain de la UI) |
| A13 | Media | `computeHunks` síncrono hasta 3 s | Timeout por defecto 500 ms (el fallback round-tripa: fuzz) |
| A14 | Media | Cambios solo EOL/BOM → «M» sin nada que revisar | `eolOnly` en el cambio; árbol/tooltip/informe lo dicen; test A14 |
| A15 | Media | Críticos dentro de `node_modules`/`.venv`… | Nivel «heavy» no anulable por críticos (`HEAVY_EXCLUDES`); test |
| A16 | Media | `gc()` pisaba `index.json` concurrente con start/stop | `withIndex()` serializado; gc relee el índice, nunca borra la activa ni blobs de sesiones nuevas |
| A17 | Baja | `reconcile` sin comprobar códigos de git | Comprobados (lanza `EngineError`) |
| A18 | Baja | Colisión de nombre tmp en el mismo ms | Contador monótono |
| A19 | Baja | Symlinks / modo 755 | `120000` → `unavailable:symlink`; `writeFile(mode)` hace chmod en POSIX |
| A20 | Baja | Reutilización de PID en el lock | **Pendiente** (backlog): hostname/startTime + «Take over» |
| A21 | Baja | `applyDiscardToDisk` sin reverificar sha | Reverifica y devuelve `stale`; test A21 |
| A22 | Baja | Negativos de `materialize` no cacheados | Cache `!reason` en `materialized`; test A9/A22 |
| A23 | Baja | Doc abierto limpio con fichero borrado en disco → no se veía la D | `readCurrent` trata disco ausente + doc limpio como borrado; test A23 |
| A24 | Baja | JSON corrupto bloqueaba la activación | `readJson` aparta `.corrupt` y sigue |
| A25 | Baja | Paso a D sin archivar estados | `reconcileHunks(ch, [])` |
| A26 | Baja | Hash de ficheros grandes por lectura completa | **Pendiente** (backlog): hash por streaming |
| A27 | Baja | Undo parcial reofrecía el mismo registro | `undonePaths` por ruta |

Verificado OK por el revisor: modelo de hunks (fuzz), rangos de `planDiscard` para docs abiertos, BOM, parsers git, `gitPrefix` en ls-files/check-ignore/check-attr/status, materialización por OID (sobrevive a commit/reset/gc), `uncertain`, serialización por ruta, restore/undo, store/lock/GC, `NodeGit.run`, reglas, `paths`.

## F1b · Capa VS Code — auditoría del 2026-08-16

Revisor independiente sobre `166639f` (copia limpia): `npm run check`, `test:integration` 7/7 en VS Code 1.133, sondas propias en un VS Code real y verificación contra la fuente de VS Code. 23 hallazgos; aplicados en `7f3db21` salvo los marcados.

| # | Sev. | Hallazgo (resumen) | Resolución |
|---|------|--------------------|------------|
| B1 | Alta | `menus.diffEditor/gutter/hunk` es **API propuesta** (`contribDiffEditorGutterToolBarMenus`): en producción la entrada no existe | Contribución retirada; comandos **Accept/Discard hunk at cursor** en `editor/title` (diff con `ck-baseline:`) y `editor/context`; el argumento con `mapping` sigue entendiéndose si algún día se publica. PLAN §4.4 y T7 corregidos |
| B2 | Alta | = A1 (no UTF-8) también desde la UI | Motor: round-trip latin1; UI: verificación de sha antes de aplicar en documento |
| B3 | Alta | Renombrado/movimiento de **directorio** por CLI: hijos invisibles y «D» fantasma | `drain` expande directorios: creado → walk de hijos; ausente → `knownPathsUnder`; test de integración con `renameSync` de un directorio |
| B4 | Media | Activación esperaba a la API git (hasta 4 s) | Detección de git perezosa dentro de `activate()` (background); `activated in N ms` ya no la incluye |
| B5 | Media | Aviso de primera vez incondicional y antes de terminar | Se muestra tras activar y con texto distinto si no hay sesión |
| B6 | Media | Config de workspace sin `inspect()`: un agente podía cegar la siguiente sesión | Claves sensibles de workspace solo tras **aprobación** (hash en `workspaceState`); hasta entonces valores de usuario; aviso con «Apply / Keep»; `restrictedConfigurations` ampliado |
| B7 | Media | `purgeData`/GC desde una ventana sin lock destruían la sesión de otra | `mayTouchStore()` (lock propio o sin dueño vivo) antes de purgar/GC |
| B8 | Media | `hasChanges` sobre sesiones detenidas | Solo guards con sesión; `when` de acciones exige `hasSession` |
| B9 | Media | Watcher `.git` recursivo sobre la raíz del repo; `.git` fichero; `lastHead` tras resume | Patrón sin `/` sobre `--absolute-git-dir` (`{HEAD,ORIG_HEAD,MERGE_HEAD,REBASE_HEAD,index}`); `refreshHead()` tras resume |
| B10 | Media | 50 procesos git en paralelo en ráfagas | Lotes de 8 + `prefetchIgnore` por lote |
| B11 | Baja | Tooltip sin escapar (`__init__.py`) | `appendText` para rutas |
| B12 | Baja | `Range(0,0,lineCount,0)` | `validateRange` |
| B13 | Baja | Selección en línea de contexto; R con lado izquierdo vacío | `hunkMeta.firstLine`; R usa la línea base de `renamedFrom` |
| B14 | Baja | Sin `TreeItem.id` | id `folder|path` |
| B15 | Baja | Aviso de ráfaga repetido en cada lote | Se mantiene hasta resolver |
| B16 | Baja | Stubs de informe visibles | F2 implementado (informe, export, commit message) |
| B17 | Baja | Salidas silenciosas de stop/undo | `pickGuard(filter)` + mensajes |
| B18 | Baja | Cambios de config sin aviso | Aviso con «New session»; descripciones «Applies to the next session» |
| B19 | Baja | Doble activación / timers | `activated`; timers limpiados |
| B20 | Baja | Reutilización de PID | **Pendiente** (= A20) |
| B21 | Baja | `includes` O(n²) | `Map` |
| B22 | Baja | Mensajes de progreso del motor sin l10n | Códigos → `l10n.t` en la capa VS Code |
| B23 | Baja | Espera de 10 s en el test; `globalStorage` de runs anteriores | Espera eliminada; limpieza por run |

Verificado OK por el revisor: contratos `vscode.changes`/`vscode.diff`/`<viewId>.focus`/context keys/ThemeColors/codicons; activación y colas; watchers y carrera doc-recarga (curada por `onDidChangeTextDocument`); escrituras propias sin cambios fantasma; discard por WorkspaceEdit (normal y EOF); HEAD watcher; package.json/nls/l10n; content provider.

**Estado tras F1a+F1b:** `npm run check` (56 unit) e integración 8/8 en VS Code 1.133 (Windows). Commit `7f3db21`.

## F2 + F3 · Revisión inline, informe y publicación 0.1.0 — auditoría del 2026-08-16

Revisor independiente sobre `b0f8484` (copia limpia): `npm run check`, `l10n-sync`, `.vsix` descomprimido, `test:integration` (dos veces + sonda propia de CodeLens), APIs/colores/codicons contra la fuente de VS Code 1.95, SHAs de acciones contra `git ls-remote`. 19 hallazgos (4 medios); confirmó por muestreo que A1, A2, A3, A10, B1, B3, B6 y B7 están aplicados.

| # | Sev. | Hallazgo (resumen) | Resolución |
|---|------|--------------------|------------|
| C1 | Media | README/CHANGELOG/PLAN anunciaban «ChangeKeeper: Accept» en el gutter (retirado en B1) | Textos reescritos: gutter nativo = *Revert block*; **Accept/Discard hunk at cursor** en título y menú contextual del diff; PLAN §4.4 corregido |
| C2 | Media | El informe incluía la primera línea cambiada de cada hunk también en ficheros críticos (`.env` → valor del secreto) | En críticos solo el rango `@@ … @@`; cabecera acotada a 100 chars; PRIVACY y README lo dicen |
| C3 | Media | Al teclear en un fichero con cambios: CodeLens/decoraciones + debounce → 2-3 recomputaciones y lecturas por pausa | `processPath` devuelve el cambio cacheado cuando el sha no varió; el resto sirve la caché |
| C4 | Media | Discard con documento cerrado escribía en disco sin copia previa (sin undo; A/R = fichero entero) | `applyDiscardToDisk` guarda los bytes previos y registra `RestoreRecord{kind:'hunk', before, after}`; `undoRestore` verifica contra `after`; docs alineados |
| C5 | Baja | CodeLens en la línea de contexto | `firstChangedLine(h)` |
| C6 | Baja | Cursor en el lado base del diff | Se usa el editor del lado modificado; en el lado base se mapea por `oldStart/oldLines` |
| C7 | Baja | Tipo de commit `fix` sin límites de palabra; scope duplicado | Regex acotada; sin «in scope» cuando ya va como `(scope)`; tests |
| C8 | Baja | `headerOf` sin tope | 100 chars + «…» |
| C9 | Baja | Aviso «settings changed» al alternar CodeLens | Solo comparan `autoStart/rules/limits` |
| C10 | Baja | Informe inaccesible tras Stop | Context key `changekeeper.hasReport` (sesión activa o detenida en memoria) |
| C11 | Baja | Renombrados: hunks contra vacío | Hunks contra la línea base de `renamedFrom` |
| C12 | Baja | Sin unit tests de informe ni de CodeLens; e2e dependía del portapapeles | `report.test.ts`; e2e ejecuta `vscode.executeCodeLensProvider` y acepta desde el lens; portapapeles tolerante |
| C13 | Baja | `@types/diff` stub | Eliminado (lock regenerado) |
| C14 | Baja | Triple build en CI; suscripción del CodeLens sin disponer | Paso `build` retirado; `dispose()` |
| C15 | Baja | Sin avisos de terceros en el vsix | `THIRD_PARTY_NOTICES.md` (diff BSD-3, minimatch BlueOak-1.0.0, ignore MIT) incluido |
| C16 | Baja | PRIVACY «nada se escribe en el workspace» vs `.ck-tmp` | Matizado en PRIVACY (EN/ES) y README |
| C17 | Baja | CHANGELOG/PRIVACY mencionan un Pro futuro | Aceptado (PLAN §2.6 lo permite fuera de la `description`) |
| C18 | Baja | PLAN.md público con cabecera vieja y referencias internas | `docs/PLAN.md` pasa a gitignored (interno, como TUS-TAREAS.md); cabecera actualizada |
| C19 | Baja | Categoría «SCM Providers» sin proveedor SCM | `["AI", "Other"]` |

Verificado OK por el revisor: CodeLens (codicons, rangos, comandos con `FileNode/HunkNode`, ajuste `codeLens`), decoraciones (colores válidos, mapeo, refresh), informe y export, package.json/Marketplace (description sin frases del filtro, keywords, `pricing: Free`, `preview`, capabilities, activación, l10n/nls), APIs ≤ 1.95, `.vsix` (15 ficheros, sin restos Pro ni red), CI/release (SHAs, matriz, idempotencia), docs.

**Estado tras F2+F3:** 58 unit + 8 integración en verde; `.vsix` 0.1.0 empaquetado. Siguiente: repo público, secretos, tag `v0.1.0`.

## F4 · Pro (validaciones, secretos, commit→SCM, licencia Polar) — auditoría del 2026-08-16

Revisor independiente sobre `5bbdce0`: copia limpia, `npm run check`/`test:integration` en verde, sonda e2e propia (cwd/timeout/env/stdin/concurrencia), lectura de `workbench.desktop.main.js` 1.133 (Task API real), diff contra el `license.ts` de referencia (idéntico byte a byte), benchmark del scanner. 25 hallazgos (8 medios, 0 altos); aplicados en el commit siguiente salvo los marcados.

| # | Sev. | Hallazgo (resumen) | Resolución |
|---|------|--------------------|------------|
| D1 | Media | El timeout mataba solo la shell (`child.kill()`), no el árbol (`node` nieto seguía vivo) | `CommandPty.close()`: Windows `taskkill /T /F`; POSIX `detached` + `process.kill(-pid, SIGTERM)` y `SIGKILL` a los 5 s |
| D2 | Media | El fingerprint no incluía `pre<script>`/`post<script>` | `resolvedScripts()` = script + pre + post (JSON estable) en fingerprint y en el diálogo; README matizado («reduce el riesgo…») |
| D3 | Media | `cwd` admitía `..` (salía de la carpeta); el modal no mostraba cwd ni runOn | `safeCwd()` rechaza escapes (regla ignorada con aviso); modal con directorio, disparador y scripts en `detail` |
| D4 | Media | `runOn` fuera del fingerprint: un agente podía pasar una regla aprobada de manual a automática | `runOn` en el fingerprint |
| D5 | Media | `onSessionEnd` sin gate de críticos pendientes; no se disparaba en re-baseline | Gate único `criticalPending()` en `runRule` para disparos silenciosos; `beforeStop` también en «New session» |
| D6 | Media | `outputTail` persistido/informado sin redactar | Cada línea del tail pasa por `scanSecrets`/`redact` antes de guardarse; ANSI eliminado; líneas partidas reagrupadas; PRIVACY lo dice |
| D7 | Media | «Show output» abría `showTasks` (solo tareas activas) | Muestra el terminal de la tarea; fallback: documento con el tail |
| D8 | Media (F1b) | Carrera `ensureGit()`/`start()` durante `activate()` → línea base plain en un repo git | Detección memoizada (promesa única) + `start()` espera la activación (sin interbloqueo: `startInternal` desde la propia activación) |
| D9 | Baja | El scanner no se retiraba al perder la licencia en la revalidación | `onDidChangeProStatus` → `refreshScanner()`; ajuste `changekeeper.secretScan` |
| D10 | Baja | `runOne` sin gate de trust; PLAN decía que `executeTask` lanza en Restricted Mode (no: pide confianza y no arranca) | Gate `isTrusted` único en `runRule`; nota en PLAN |
| D11 | Baja | El hijo heredaba `ELECTRON_RUN_AS_NODE` | Eliminado del env (y `ELECTRON_NO_ATTACH_CONSOLE`) |
| D12 | Baja | stdin abierto → comandos que leen stdin esperaban al timeout | `stdio: ['ignore', 'pipe', 'pipe']` |
| D13 | Baja | ANSI y líneas partidas en el tail | = D6 |
| D14 | Baja | «Resolved script» duplicado en el modal | Solo `detail` |
| D15 | Baja | `addPreset` escribía en `.vscode/settings.json` (crítico y vigilado) | Escribe en ajustes de usuario (Global) |
| D16 | Baja | Firma de auto-run fijada antes de comprobar gates; silencio si falta la primera ejecución manual | Firma solo al ejecutar; aviso único «needs one manual run first» |
| D17 | Baja | Regex `url-credentials` cuadrática en líneas patológicas | Esquema acotado `{0,30}` + corte de línea a 1 000 chars; test de rendimiento |
| D18 | Baja | Orden openai/anthropic; asignaciones sin comillas/prefijo; falso positivo `sk-` slug | Reordenado; asignación más amplia; `sk-` exige ≥20 alfanuméricos; tests |
| D19 | Baja | `.npmrc`/`.yarnrc`/`.pnpmfile.cjs` no críticos | Añadidos a `DEFAULT_CRITICAL` |
| D20 | Baja | `running` persistido si se cierra VS Code | Al reanudar → `error` |
| D21 | Baja | README «turn the scanner off» sin ajuste | Ajuste `changekeeper.secretScan`; upsell ya coherente (hooks entran en 0.2.0) |
| D22 | Baja | PRIVACY versión corta contradecía la sección Red | Corregida (EN/ES) |
| D23 | Baja | PLAN §3.3 vs código (criticalGlobs/retención gratis) | Decisión: gratis; PLAN corregido |
| D24 | Baja | TUS-TAREAS sin puerta 0.2.0 | Bloque «Puerta v0.2.0» añadido |
| D25 | Baja | `taskDefinitions` sin nls | `%task.id%`/`%task.command%` |

Verificado OK por el revisor: `license.ts` idéntico al de referencia y sus 9 tests; claves de almacenamiento y `CK_PRO_DEV` sin restos de Handsfree; `polarConfigured` exige org+checkout; guarda de release.yml bloquea 0.2.0 con Polar vacío; PRIVACY refleja lo enviado a Polar; exit codes exactos con `CustomExecution`; `taskDefinitions`; notificaciones no bloqueantes; `restrictedConfigurations` con `validations`; `approveRule` solo vía comando interno; «quitar es gratis» respetado; scanner sin fugas y coste típico despreciable.

## F5 · Hooks de agente (receptor local, instalador, atribución) — auditoría del 2026-08-16

Revisor independiente sobre `9d1fe4e`: lectura completa de los ficheros de F5, `npm run check` y `test:integration` en verde, y **sondas propias** contra `out/vscode/hooks/server.js` con `vscode` stubeado (OPTIONS/GET/POST sin token/token en query/JSON inválido/600 KB/traversal/cwd no registrado/pid muerto/inbox/200 POST concurrentes/bind en interfaces no loopback/carrera de token/re-bind), sonda de `settingsEdit` + `dist/uninstall.js` con `CLAUDE_CONFIG_DIR`, y contraste con la documentación oficial (hooks de Claude Code, hooks de Copilot en VS Code y en Copilot CLI, fuente de VS Code `extensionLifecycle.ts`). 21 hallazgos (7 medios, 0 altos), todos aplicados en el commit siguiente.

Además, tras la auditoría se hizo la **prueba real que el PLAN §4.6 exigía** (no estaba hecha): Claude Code 2.1.233 en modo `-p` contra un receptor de pruebas, con nuestros hooks en `.claude/settings.local.json`. Resultado en E22.

| # | Sev. | Hallazgo (resumen) | Resolución |
|---|------|--------------------|------------|
| E1 | Media | Carrera al crear el token: dos ventanas que arrancan a la vez generan tokens distintos y gana la última escritura; la dueña valida contra su copia en memoria → 401 permanentes y silenciosos para los hooks de la otra ventana | Creación exclusiva (`flag: 'wx'`, modo 0600) y relectura en `EEXIST`; ante un 401 el receptor **relee el fichero** (con freno de 2 s) antes de rechazar; el doctor compara el token instalado con el actual y avisa «reinstala» |
| E2 | Media | Una carpeta abierta en dos ventanas (o carpetas anidadas): `route()` elegía **una sola** destinataria (la de ruta más larga). Si le tocaba a la ventana sin lock se perdía la atribución y cada `SessionStart` provocaba un aviso «ya vigilada por otra ventana» repetido | El receptor entrega a **todas** las ventanas/carpetas que contienen la ruta (cada guard decide); el aviso `locked` en `startInternal` solo se muestra si no es un arranque silencioso |
| E3 | Media | `.claude/settings.local.json` creado por nosotros no queda ignorado por git (solo lo ignora Claude cuando lo crea él) → el token podía acabar commiteado; y la escritura aparecía como **cambio crítico sin revisar** (bloqueando validaciones automáticas) | Tras escribir: `git check-ignore` y, si no está ignorado, se añade a `.git/info/exclude` (nunca al `.gitignore` del proyecto); el fichero se inspecciona y se marca como revisado (es nuestra propia escritura) |
| E4 | Media | El receptor (puerto, registro por ventana y sondeo cada 1,5 s) arrancaba para **todos** los usuarios, también Free y sin hooks instalados; el puerto abierto no se documentaba | Arranque **perezoso**: solo si hay hooks instalados (fichero de usuario o de una carpeta abierta), si se instalaron alguna vez desde esta máquina, o si alguna carpeta usa `autoStart: whenAgentDetected`; «Revertir hooks» lo apaga cuando ya no hace falta; puerto y token documentados en README y PRIVACY |
| E5 | Media | Afirmación sin respaldo en README/CHANGELOG: «los agentes que leen el mismo fichero, como los hooks de Copilot, se etiquetan también» (Copilot solo ejecuta hooks `command` y usa otros nombres de herramienta) | Retirada: «de momento solo Claude Code»; el comentario de `events.ts` lo explica |
| E6 | Media | `atomicWrite` sobre `~/.claude/settings.json`: el `rename` sustituiría un **symlink** por un fichero normal, y el fichero nuevo nacía con el modo de la umask (0644) aunque el anterior fuese 0600 | El instalador resuelve `realpath` (escribe a través del enlace) y conserva el modo previo (`atomicWrite` acepta `mode`; 0600 por defecto para ficheros nuevos) |
| E7 | Media | Consentimiento y documentación incompletos: no se decía que los hooks de usuario se disparan en **todas** las sesiones de la máquina (con VS Code cerrado Claude muestra «hook error»), ni dónde viven las copias de seguridad, ni el alcance del desinstalador | El modal lo dice según el ámbito elegido; el quick pick ofrece **proyecto primero** (recomendado); README y PRIVACY documentan token, puerto, copias (tope 10, las borra «Purgar datos») y el `.bak` que deja el desinstalador |
| E8 | Baja | Comparación del token con `!==` (no en tiempo constante) | `crypto.timingSafeEqual` con comprobación previa de longitud |
| E9 | Baja | Token escrito con el modo por defecto; el modal mostraba el token en claro | Modo 0600; en la vista previa el valor se sustituye por `<token>` |
| E10 | Baja | La bandeja entre ventanas serializaba el **payload crudo** (`tool_input.content` completo: 100 KB para un `Write` de 100 KB) | `HookEvent` ya no tiene `raw`; solo tipo, agente, ruta, cwd, sesión y herramienta |
| E11 | Baja | `agentTouches` no se vaciaba nunca: un fichero tocado una vez por el agente seguía «by claude-code» en sesiones posteriores; una etiqueta genérica no se refinaba | `agentTouches.clear()` al arrancar sesión; una etiqueta específica puede sustituir a la genérica `agent`, nunca al revés (también para `session.agent`) |
| E12 | Baja | `hooks.port` sin validar: `0`/`null` daban puerto aleatorio; `70000`/`1.5`/`-1` lanzaban en `listen` y abortaban el arranque antes del temporizador de la bandeja | `HookServer.validPort` (entero 1024–65535, si no 47391 + log); `minimum`/`maximum` en el esquema del ajuste |
| E13 | Baja | `tryBind` no era reentrante y `setPort` no cancelaba el reintento: podía producirse EADDRINUSE contra uno mismo, dejando el servidor viejo escuchando y fuera de `dispose()` | `tryBind` sale si ya hay servidor o hay un bind en curso; `setPort` limpia el reintento; el servidor que no llega a escuchar se cierra |
| E14 | Baja | El doctor no comprobaba el token, decía «otra ventana es dueña» aunque el puerto lo ocupase un programa ajeno, y no mencionaba las políticas administradas | La registración incluye `owner`; el doctor distingue «otra ventana» de «otro programa: cambia el puerto», compara tokens y añade una nota sobre `allowedHttpHookUrls` administrado |
| E15 | Baja | `addChangeKeeperHooks` devolvía siempre `changed = true` (reinstalar pedía consentimiento y hacía copia sin necesidad) y un grupo `null` lanzaba TypeError | `changed` se calcula comparando la serialización; los grupos malformados (`null`, sin array `hooks`) se conservan tal cual; test dedicado |
| E16 | Baja | Copias de seguridad sin tope, fuera del alcance de «Purgar datos» y con nombre que no distinguía el proyecto | Tope de 10 (FIFO), nombre con hash corto de la ruta, modo 0600 y borrado desde «Purgar datos» (documentado) |
| E17 | Baja | `whenAgentDetected` dependía de que el `cwd` del `SessionStart` cayese en una carpeta registrada; con Claude lanzado desde un directorio padre no arrancaba nunca | Un `PostToolUse` sobre un fichero de la carpeta también arranca la sesión en ese modo (la línea base git es el índice: no se pierde el primer cambio) |
| E18 | Baja | Si la ventana dueña se cerraba, hasta 30 s sin receptor; una registración con pid reutilizado no se limpiaba nunca | Latido cada minuto en la registración; las que no laten en 10 min (o cuyo pid está muerto) se descartan con su bandeja; las ventanas no dueñas comprueban cada ~4,5 s si ha quedado el puerto libre y lo toman al momento |
| E19 | Baja | `Stop` y `SessionEnd` se instalaban pero solo se registraban en el log: más POSTs y más «hook error» con VS Code cerrado | Retirados de `CK_HOOK_EVENTS` (y las entradas antiguas se limpian al reinstalar) |
| E20 | Baja | Con `autoStart: git`/`always` un `SessionStart` reiniciaba la sesión que el usuario había parado a mano | `stoppedByUser` en el guard: solo `whenAgentDetected` (que es explícitamente «arranca cuando llegue un agente») rearranca |
| E21 | Baja | El e2e usaba el puerto real 47391: fallaba si el desarrollador tenía VS Code + ChangeKeeper abierto | El perfil de test escribe `changekeeper.hooks.port: 47399` en sus ajustes de usuario |
| E22 | — | **Prueba real pendiente del PLAN §4.6** (forma del payload, latencia, comportamiento con VS Code cerrado) | Hecha con Claude Code 2.1.233 (`-p`, receptor de pruebas): el payload real coincide con lo documentado (`hook_event_name`, `cwd`, `tool_input.file_path`, `transcript_path`, `permission_mode`) y se añadió como fixture de test. Hallazgo: **`SessionStart` no disparó el hook `http`** en ese modo (un hook `command` en el mismo evento sí), mientras que `UserPromptSubmit`, `PostToolUse`, `Stop` y `SessionEnd` sí llegaron → se instala también `UserPromptSubmit` (una vez por prompt, antes de cualquier edición) como señal fiable de «hay un agente trabajando aquí». Con el receptor apagado, Claude sigue adelante y muestra un aviso no bloqueante (`Stop hook error occurred · ctrl+o to see`, `ECONNREFUSED` en stderr): coincide con la documentación y es lo que ahora advierte el modal. Coste: ~3 ms por evento. |

Verificado OK por el revisor: bind solo en `127.0.0.1` (ECONNREFUSED en las demás interfaces y en `::1`); `OPTIONS` → 403 sin cabeceras CORS y el token se comprueba **antes** de leer el cuerpo (una petición «simple» de navegador no pasa); GET y otras rutas 404; JSON inválido 400; >512 KB 413; respuesta **siempre sin cuerpo** ⇒ un hook nuestro nunca puede añadir contexto ni decidir permisos; traversal rechazado por `engine.relOf`; solo carpetas de ventanas vivas; ~0,4 ms de servidor por evento con 200 POST concurrentes; el instalador no escribe si el JSON es inválido, preserva claves y orden ajenos, respeta `CLAUDE_CONFIG_DIR` y el revert deja el fichero igual que estaba; `dist/uninstall.js` va en el vsix y VS Code lo ejecuta solo al desinstalar del todo; solo hooks `type: http` (nada corre dentro del agente); `ensurePro` solo para instalar (revertir y diagnosticar son gratis); etiquetas de agente de un enum cerrado (sin inyección en árbol/informe); l10n ES completa.

Tests añadidos: `src/test/unit/hooksServer.test.ts` (receptor con `vscode` stubeado — códigos de respuesta, token compartido/regenerado, entrega múltiple, relevo del puerto, `tryBind`/`setPort`, limpieza de ventanas muertas; enrutado a guards falsos por modo de `autoStart`; ejecución real de `dist/uninstall.js`), fixture del payload real y casos de `settingsEdit` con grupos malformados. Total: **91 unitarios + 10 de integración**.

## F6 · Lanzamiento y métricas — auditoría del 2026-08-16

Revisor independiente sobre `2266adf`, en modo lectura: contraste de cada afirmación de los textos de lanzamiento contra el código, comprobación de las reglas reales de cada plataforma (formularios y `CONTRIBUTING.md` de las listas *awesome*, límite de título de Hacker News medido sobre 1.000 historias vía Algolia, límites de X/LinkedIn/Product Hunt contados), ejecución de `scripts/metrics.mjs` contra las APIs vivas, `npm run check`, empaquetado del `.vsix` y revisión de lo que entra en él. 21 hallazgos (4 altos, 8 medios, 9 bajos). Aplicados todos los que no dependen del titular; el resto está en la lista de tareas humanas.

| # | Sev. | Hallazgo (resumen) | Resolución |
|---|------|--------------------|------------|
| F1 | Alta | Los textos de lanzamiento decían «yo los publico desde la ventana de automatización»: contradice la regla del titular (una cuenta de X ya fue suspendida por «inauthentic behaviors») | Reescrito: el agente redacta y lee, **publica el humano desde su navegador**; retirada la oferta de grabar el GIF por automatización (imposible: controla Chromium, no VS Code) |
| F2 | Alta | `docs/LANZAMIENTO.md` y `docs/METRICAS.md` estaban **versionados y accesibles públicamente** (estrategia de redes, métricas comerciales) | Añadidos al `.gitignore` y sacados del índice; el historial anterior queda a decisión del titular. `docs/AUDITORIA.md` se mantiene público a propósito |
| F3 | Alta | El canal nº 1 del soft-launch no existe: `anthropics/claude-code` **no tiene Discussions** (`has_discussions: false`) | Convertido en *issue* en ese repositorio |
| F4 | Alta | Los textos del soft-launch anunciaban Pro y los hooks **en presente** con la 0.1.0 publicada (donde no existen) | Reescritos en futuro; tabla nueva al principio con qué se puede publicar hoy y qué espera a la 0.2.0 |
| F5 | Media | Las dos listas *awesome* habrían rechazado lo propuesto: `awesome-claude-code` exige formulario web, autor humano y ≥14 días o ≥100 ★; `awesome-vscode` exige enlace al Marketplace, formato exacto y GIF, y no tiene categoría «AI» | Instrucciones corregidas con la fecha mínima (2026-08-30) y el formato real |
| F6 | Media | El título del «Show HN» medía 97 caracteres (el formulario corta en 80) | Título de exactamente 80 y URL explícita (ficha del Marketplace) |
| F7 | Media | **Falso cero en las métricas**: la galería responde sin `statistics` en ~5 de cada 6 llamadas y el script escribía `0`, que además sobrescribía una medición buena del mismo día | Reintentos (hasta 15) hasta obtener estadísticas; si no las hay, `n/d` en vez de `0`; al reescribir la fila del día se conserva el valor más alto por columna |
| F8 | Media | La columna de Polar nunca habría funcionado: `organization_id=` vacío es un filtro malformado (422) | Se omite el parámetro cuando no hay id (el token ya está acotado a la organización); `POLAR_OAT` añadido a la tarea del tag |
| F9 | Media | La puerta de decisión de 30 días (cualitativa) no tenía dónde medirse | Tablas de puerta de 30 y 60 días en `METRICAS.md` |
| F10 | Media | Se prometía macOS sin haberlo ejecutado nunca, y una lista de agentes que se lee como integraciones | `macos-latest` añadido a la matriz de CI (motor + 91 tests); README y `description` dicen ahora **agnóstico de agente: vigila los ficheros**, con la atribución por hooks marcada como «hoy, Claude Code» |
| F11 | Media | Faltaban el correo a early adopters y las respuestas a objeciones que el alcance de F6 daba por hechos | Añadidos: §6 (correo EN/ES) y §7 (seis objeciones con respuesta, incluida «¿para qué, si tengo /rewind?» y la de reembolsos) |
| F12 | Media | Cero imágenes: la ficha de la tienda no tiene ni una captura, y dev.to/`awesome-vscode` las exigen | Tarea humana registrada (D1) con guion y destino; el resto del lanzamiento se marca como bloqueado por ella |
| F13 | Media | Seis subreddits para el mismo enlace sin escalonar (el patrón que ya disparó el antispam) | Tabla de **un subreddit por semana** con casilla para anotar la regla de autopromoción leída antes de publicar |
| F14 | Baja | `## [0.2.0] - unreleased` se vería así en la pestaña Changelog de la tienda | Añadido al procedimiento del tag (P4): poner la fecha en el mismo commit |
| F15 | Baja | El *tagline* de Product Hunt medía 63 caracteres sobre un límite declarado de 60 | Recortado a 57 |
| F16 | Baja | «nothing is copied until a file changes» es inexacto (los ficheros ya modificados o sin seguimiento sí se copian) | Corregido en README (EN/ES) y en los textos de lanzamiento: «los limpios no se copian, solo su identificador de objeto git» |
| F17 | Baja | «Everything local, no telemetry, no account» junto a la mención de Pro, que sí usa la red | Matizado como en el README: la única red es la comprobación de licencia |
| F18 | Baja | El script informaba «0 claves» cuando la llamada de claves fallaba, y ponía «€» sin mirar la moneda | Comprobación de error también en claves; moneda del propio pedido |
| F19 | Baja | No había política de soporte ni de reembolsos en ninguna parte, y se va a cobrar | Sección «Soporte y reembolsos» en README (EN/ES): issues o correo, **30 días sin preguntas** vía Polar (*merchant of record*); tres plantillas de issue con aviso de no pegar secretos |
| F20 | Baja | «Open VSX descargas» y «MP instalaciones» presentadas como comparables (100 vs 1 el mismo día) | Nota en `METRICAS.md`: para las puertas solo valen instalaciones del Marketplace y pedidos de Polar |
| F21 | Baja | El registro de publicaciones no tenía ninguna fecha prevista | Columna «Fecha prevista» con las dependencias reales (GIF, v0.2.0, karma) |

Verificado OK por el revisor: `npm run check` en verde (91 tests) y `.vsix` de 17 ficheros sin `src/`, `docs/`, `scripts/` ni `node_modules`; la guarda de Polar de `release.yml` bloquea de verdad la publicación con la configuración vacía, valida que el tag esté en `main` y coincida con `package.json`, y fija todas las actions por SHA; `grep -rni telemetry src` vacío y la única URL fuera del código de licencia es `127.0.0.1`; las cifras del README coinciden con el código (7 €, 14 días de gracia, revalidación cada 24 h, lo que se envía a Polar, retención 30 días/500 MB); los hooks son solo Claude Code y la afirmación sobre Copilot ya estaba retirada; icono 256×256; endpoints de métricas vivos; enlaces del documento resuelven; límites de X (≤280), LinkedIn (1.498/3.000) y Product Hunt (251/260) correctos.

**Añadido tras la auditoría** (no era un hallazgo del revisor, apareció al ejecutar el CI de este mismo commit): los tests dejaban el proceso de mocha vivo tras terminar (91 verdes en 12 s, pero sin salir) porque un `dispose()` que llegaba mientras el receptor de hooks aún estaba arrancando no cancelaba los temporizadores que ese arranque creaba después. El CI se quedó colgado hasta el `timeout-minutes` del job. Arreglado en el propio receptor (`start()` publica su promesa, cada paso comprueba que sigue vivo y `stop()` la espera) — con lo que el fallo real que el cuelgue destapaba, una fuga de temporizadores y de puerto en producción al cerrar una ventana en pleno arranque, queda cerrado también.

## Prueba real de compra y licencia (P2) — 2026-08-16

Antes de publicar la 0.2.0 se ejecutó de principio a fin el camino que hará un cliente, contra la organización real de Polar y con una clave real (compra a 0 € con un cupón de un solo uso).

| Paso | Resultado |
|---|---|
| Producto y precio por API (`/v1/products/…`) | `ChangeKeeper Pro`, no recurrente, **700 EUR** fijos, benefit `license_keys` con `prefix: CKP`, `expires: null`, `activations {limit: 3, enable_customer_admin: true}`, uso ilimitado |
| Checkout | El enlace abre «Argalla · ChangeKeeper Pro · €7» (5,79 + 1,21 de IVA incluido) y admite códigos de descuento |
| Activar (`/activate`) | `granted`, con id de activación y sin caducidad |
| Validar con la activación | `granted` → decisión **pro: validated** |
| Decisión sin red (caché) | **pro: validated** sin tocar la red, como está diseñado |
| Validar con un id de activación desconocido | Segundo intento solo con la clave → `activationGone` → la extensión reactiva este equipo en vez de dejar al cliente fuera |
| Desactivar (`/deactivate`) | Libera la plaza; validar después da `activation-removed` y Pro se apaga |
| **Dentro de VS Code** (test `licence.live.test.ts`, se salta sin `CK_LIVE_KEY`) | «Enter licence key» activa y guarda en SecretStorage → el escáner Pro queda instalado en los guards → «Licence status» informa *active* con sus detalles → «Deactivate» lo apaga y retira el escáner |
| Clave **revocada** en Polar | Validar → «License key is no longer active.» → decisión **pro: false, reason: revoked** |

**Fallo encontrado en la prueba y corregido:** activar una clave revocada devuelve HTTP 403 con «License key is no longer active…», que el código clasificaba como `limit` (límite de activaciones). El mensaje al usuario mezclaba ambos casos; ahora ese detalle se reconoce como clave inactiva y se informa como «esta clave ya no está activa (revocada o desactivada)». Con test unitario que fija la respuesta real observada.

Nota de método: una ráfaga de llamadas seguidas a Polar puede devolver un error transitorio (429); el código lo trata como «temporal» (mantiene la gracia offline) en vez de bloquear al cliente, que es el comportamiento seguro. Repetida la misma llamada aislada, el resultado es el definitivo que se esperaba.
