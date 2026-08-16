# ChangeKeeper

**Instalar:** [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=argalla.changekeeper) · [Open VSX](https://open-vsx.org/extension/argalla/changekeeper) (Cursor / VSCodium / Windsurf) · o `code --install-extension argalla.changekeeper`.

**Guarda, revisa bloque a bloque y deshaz todos los cambios que hace tu agente de programación — incluidos los que hace desde la shell.** ChangeKeeper toma una línea base de tu espacio de trabajo, vigila lo que cambia después (desde *cualquier* proceso: Claude Code, Codex, OpenCode, Cline, Copilot en modo agente, Cursor, un script, `sed -i` o tú) y te deja revisar cada cambio por bloques, descartar los malos y restaurar un fichero — o la sesión entera — con un clic. Local, sin telemetría, sin cuenta.

> **Sin relación con ningún fabricante de agentes.** Claude Code, Codex, Copilot, Cursor y demás nombres pertenecen a sus dueños. ChangeKeeper solo vigila tus ficheros.
>
> [Read in English](README.md)

---

## Por qué existe

Los agentes con IDE propio ya ofrecen *Mantener / Deshacer* para las ediciones que hacen ellos mismos. Pero en cuanto usas un **agente de terminal** (Claude Code, Codex CLI, OpenCode…), un **segundo agente**, o el agente lanza un **comando de shell** que reescribe ficheros, esa red de seguridad desaparece: nada agrupa lo que cambió, nada te enseña el antes/después por bloque y «deshacer» significa bucear en git o en la línea de tiempo. ChangeKeeper es esa capa que faltaba, y funciona igual con todos los agentes porque vigila el sistema de ficheros, no al agente.

## Qué hace

| | |
| :-- | :-- |
| **Línea base al instante** | En un repositorio git la línea base es el índice al empezar la sesión: no se copia nada hasta que un fichero cambia de verdad. Las carpetas sin git se copian (con límites). |
| **Ve todos los cambios** | Ficheros escritos por cualquier proceso (CLI del agente, scripts, `git checkout`), ficheros editados en el editor, creados, borrados y renombrados. Los ignorados por git se saltan — salvo los **críticos** como `.env*`, que siempre se vigilan. |
| **Revisión por bloques** | La vista ChangeKeeper lista los ficheros cambiados (críticos primero) y sus bloques. Pulsa un fichero para ver el diff nativo (línea base ↔ ahora); el margen del diff ofrece *Revertir bloque* y *ChangeKeeper: aceptar*; en el editor normal un CodeLens sobre cada bloque ofrece **Aceptar · Descartar · Diff** y las líneas cambiadas van resaltadas. |
| **Descartar exactamente un bloque** | Descartar reescribe solo ese bloque con las líneas de la línea base — el resto conserva su contenido y su propio salto de línea. Los documentos abiertos se editan por el editor (con deshacer); los cerrados, en disco. |
| **Restaurar fichero / sesión, deshacer** | Restaura un fichero (o toda la sesión) a la línea base; los creados se borran. Todo lo sobrescrito se guarda, así que **Deshacer la última restauración** lo devuelve — y se niega a pisar ficheros que cambiaron después. |
| **Ficheros críticos** | Migraciones, SQL, workflows de CI, Dockerfiles, `.env*`, carpetas auth/security, manifiestos y locks de paquetes, `.vscode`, `.claude`, `.cursor`, `.github` se marcan y se listan primero. Añade tus propios globs. |
| **Informe de sesión** | Resumen en Markdown de la sesión (ficheros, bloques aceptados/descartados, críticos) con propuesta de mensaje de commit — expórtalo o pégalo en un PR. |
| **Guardarraíles** | Una ráfaga de cientos de ficheros nuevos (`npm install`, build, checkout) pausa el registro de ficheros nuevos y te pregunta. Binarios y ficheros enormes se registran pero no se comparan. ¿El agente hace commit o checkout? Se te avisa y puedes tomar una línea base nueva. |
| **Funciona en todas partes** | Windows (CRLF preservado), macOS, Linux; Remote-SSH / WSL / Dev Containers (corre donde están los ficheros); VS Code, VSCodium, Cursor, Windsurf. Inglés y español. |

## Cómo funciona

1. Abre una carpeta dentro de un repositorio git → ChangeKeeper empieza a vigilarla (barra de estado `CK`). ¿Sin git? Usa **ChangeKeeper: Nueva sesión** o pon `changekeeper.autoStart` en `always`.
2. Deja trabajar al agente. Cada fichero cambiado aparece en la vista ChangeKeeper con sus bloques.
3. Revisa: **Aceptar** lo que te quedas, **Descartar** lo que no, **Restaurar** lo que salió mal. **Revisar todos los cambios** abre todo en el editor multi-diff.
4. Al terminar: **Mostrar informe de sesión** → copia el mensaje de commit, o **Nueva sesión** para tomar una línea base fresca.

### Dónde viven los datos

Las líneas base y el estado de sesión viven en el almacenamiento global de la extensión en esta máquina (`…/globalStorage/argalla.changekeeper/`), nunca dentro de tu repositorio ni en un servidor. Las líneas base de ficheros que cambiaron pueden contener secretos — los mismos que ya están en tu disco. Las sesiones cerradas se conservan `changekeeper.retentionDays` días (30 por defecto) o hasta `changekeeper.retentionMaxMB`; la sesión en curso nunca se borra. **ChangeKeeper: Purgar todos los datos** lo elimina todo. Ver [PRIVACY.es.md](PRIVACY.es.md).

### Limitaciones (las de verdad)

- ChangeKeeper necesita VS Code abierto: lo que un agente hace con la ventana cerrada se recupera al reabrir (reconciliación por git), pero sin el detalle paso a paso.
- La línea base es el estado de tus ficheros *cuando empezó la sesión*. Si el agente hace commit, checkout o stash a mitad se te avisa; **Nueva sesión** toma otra línea base.
- Los bloques del margen del diff los calcula el propio comparador de VS Code y no siempre coinciden 1:1 con los bloques de ChangeKeeper; la vista ChangeKeeper y el CodeLens son la fuente de verdad.
- Los ficheros mayores que `changekeeper.maxFileSizeKB` (2 MB) y los binarios se registran pero no se comparan; los ficheros en Git LFS no tienen línea base.

## Ajustes

| Ajuste | Por defecto | Significado |
| :-- | :-- | :-- |
| `changekeeper.autoStart` | `git` | Vigilar automáticamente: carpetas en un repo git (`git`), todas (`always`), o solo con **Nueva sesión** (`off`). |
| `changekeeper.exclude` | `[]` | Globs extra que nunca se registran (los críticos sí). Aplica a la siguiente sesión. |
| `changekeeper.excludeDefaults` | `true` | Exclusiones integradas (`node_modules`, `dist`, `out`, `build`, cachés, logs). |
| `changekeeper.criticalGlobs` | `[]` | Globs críticos adicionales. |
| `changekeeper.maxFileSizeKB` | `2048` | Los mayores se registran, no se comparan. |
| `changekeeper.burstThreshold` | `500` | Ficheros nuevos en 5 s que disparan la guardia de ráfagas. |
| `changekeeper.retentionDays` / `retentionMaxMB` | `30` / `500` | Retención de sesiones cerradas. |
| `changekeeper.codeLens` / `decorations` | `true` | Acciones y resaltados en el editor. |

## Requisitos

VS Code 1.95 o superior (o un host compatible). `git` en el PATH (o configurado en la extensión git integrada) para líneas base por git; las carpetas sin git funcionan con `autoStart: always`.

## Privacidad y seguridad

Todo ocurre en tu máquina. Sin telemetría, sin llamadas de red, sin cuenta. Detalles en [PRIVACY.es.md](PRIVACY.es.md); vulnerabilidades por [SECURITY.md](SECURITY.md).

## Contribuir y licencia

MIT. Issues y pull requests en [GitHub](https://github.com/TecniartGalicia/changekeeper); ver [CONTRIBUTING.md](CONTRIBUTING.md). Hecho por [Argalla](https://github.com/TecniartGalicia) (Tecniart Galicia).
