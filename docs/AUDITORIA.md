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
