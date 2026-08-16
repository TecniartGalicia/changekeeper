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
| **Revisión por bloques** | La vista ChangeKeeper lista los ficheros cambiados (críticos primero) y sus bloques. Pulsa un fichero para ver el diff nativo (línea base ↔ ahora): el margen propio de VS Code ofrece *Revertir bloque*, y la barra de título y el menú contextual del diff ofrecen **Aceptar / Descartar bloque bajo el cursor**; en el editor normal un CodeLens sobre cada bloque ofrece **Aceptar · Descartar · Diff** y las líneas cambiadas van resaltadas. |
| **Descartar exactamente un bloque** | Descartar reescribe solo ese bloque con las líneas de la línea base — el resto conserva su contenido y su propio salto de línea. Los documentos abiertos se editan por el editor (deshacer con Ctrl+Z); los cerrados, en disco, guardando antes los bytes previos para que **Deshacer la última restauración** los devuelva. |
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

Las líneas base y el estado de sesión viven en el almacenamiento global de la extensión en esta máquina (`…/globalStorage/argalla.changekeeper/`), nunca dentro de tu repositorio ni en un servidor (los únicos ficheros que ChangeKeeper escribe en tu espacio de trabajo son los que descartas o restauras explícitamente, de forma atómica mediante un temporal `.ck-tmp` junto a ellos). Las líneas base de ficheros que cambiaron pueden contener secretos — los mismos que ya están en tu disco. Las sesiones cerradas se conservan `changekeeper.retentionDays` días (30 por defecto) o hasta `changekeeper.retentionMaxMB`; la sesión en curso nunca se borra. **ChangeKeeper: Purgar todos los datos** lo elimina todo. Ver [PRIVACY.es.md](PRIVACY.es.md).

### Limitaciones (las de verdad)

- ChangeKeeper necesita VS Code abierto: lo que un agente hace con la ventana cerrada se recupera al reabrir (reconciliación por git), pero sin el detalle paso a paso.
- La línea base es el estado de tus ficheros *cuando empezó la sesión*. Si el agente hace commit, checkout o stash a mitad se te avisa; **Nueva sesión** toma otra línea base.
- Los bloques del margen del diff (*Revertir bloque*) los calcula el propio comparador de VS Code y no siempre coinciden 1:1 con los bloques de ChangeKeeper; la vista ChangeKeeper y el CodeLens son la fuente de verdad.
- El informe de sesión lista rutas y, en ficheros no críticos, la primera línea cambiada de cada bloque; en los críticos (`.env*`, claves, CI) solo los rangos de líneas.
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
| `changekeeper.validations` | `[]` | **Pro.** Comandos a ejecutar tras la revisión (`name`, `command`, `cwd`, `runOn`: `manual` / `afterReview` / `onSessionEnd`, `timeoutSec`). |

## Pro

El núcleo de arriba es gratis para siempre y lo seguirá siendo: sesiones, revisión por bloques, restaurar/deshacer, ficheros críticos, el informe y su exportación. **ChangeKeeper Pro** (7 €, pago único por persona, clave de licencia mediante [Polar](https://polar.sh)) añade la automatización alrededor:

| Función Pro | Qué hace |
| :-- | :-- |
| **Validaciones** | Ejecuta `npm test`, `tsc`, `pytest`, `cargo check`… (presets detectados de tu proyecto, o cualquier comando) a mano, automáticamente cuando todos los bloques estén revisados (`afterReview`) o al terminar la sesión. Cada comando se confirma la primera vez en un espacio de trabajo y de nuevo si cambian el comando, su `cwd`, su disparador *o los scripts de package.json a los que apunta (incluidos `pre`/`post`)*: eso reduce el riesgo, pero una validación sigue ejecutando código del repositorio (`node_modules`, `.npmrc`…) que el agente puede haber tocado: revisa antes los críticos. Los resultados (código de salida, duración, cola de la salida) van al informe. Nunca se ejecuta en modo restringido. |
| **Escáner de secretos** | Las líneas añadidas se comprueban en local contra formas de token (AWS, GitHub, Slack, Stripe, claves privadas, JWT, `password = "…"`, credenciales en URL). Los hallazgos van redactados, marcados en el árbol y listados en el informe. Sin red. |
| **Mensaje de commit en la caja de SCM** | El mensaje sugerido va directo a la caja de git (exportar el informe es gratis). |
| **Atribución por agente mediante hooks** | Opcional: **ChangeKeeper Pro: Instalar hooks de agente** escribe hooks HTTP en los ajustes de Claude Code (usuario o un proyecto) — con diálogo de consentimiento, copia byte a byte y **Revertir hooks de agente** — para que ChangeKeeper sepa cuándo empieza una sesión y qué ficheros editó cada herramienta. Los ficheros muestran *by claude-code* en el árbol y en el informe; `autoStart: whenAgentDetected` inicia una sesión vigilada en cuanto lo hace un agente. Los hooks solo hacen POST a `127.0.0.1` en tu máquina, nunca deciden permisos ni añaden contexto al agente (los agentes que leen el mismo fichero, como los hooks de Copilot, se etiquetan también). Los instaladores para Codex/Cursor están en la hoja de ruta. |

Todo lo que añade Pro se puede quitar sin licencia: borrar una validación de los ajustes, apagar el escáner (`changekeeper.secretScan`), revertir los hooks — las funciones gratuitas nunca dependen de ello. Actívalo con **ChangeKeeper Pro: Introducir clave de licencia**; la clave se valida una vez y se recomprueba cada 24 h con 14 días de gracia sin conexión. A Polar se envía: la clave, el nombre de este equipo, tu SO y la versión de la extensión — nada más, nunca. Comprar: **ChangeKeeper Pro: Conseguir ChangeKeeper Pro**.

## Requisitos

VS Code 1.95 o superior (o un host compatible). `git` en el PATH (o configurado en la extensión git integrada) para líneas base por git; las carpetas sin git funcionan con `autoStart: always`.

## Privacidad y seguridad

Todo ocurre en tu máquina. Sin telemetría, sin cuenta y sin llamadas de red salvo la activación de la licencia Pro y su revalidación cada 24 h, solo en equipos donde hayas introducido una clave. Detalles en [PRIVACY.es.md](PRIVACY.es.md); vulnerabilidades por [SECURITY.md](SECURITY.md).

## Contribuir y licencia

MIT. Issues y pull requests en [GitHub](https://github.com/TecniartGalicia/changekeeper); ver [CONTRIBUTING.md](CONTRIBUTING.md). Hecho por [Argalla](https://github.com/TecniartGalicia) (Tecniart Galicia).
