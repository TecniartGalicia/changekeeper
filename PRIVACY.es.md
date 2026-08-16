# Privacidad

**Versión corta:** ChangeKeeper funciona por completo en tu máquina. No envía nada a ningún sitio, no tiene telemetría ni cuenta; el único acceso a red es la comprobación opcional de la licencia Pro (ver Red).

## Qué guarda y dónde
- El estado de sesión (qué ficheros cambiaron, estado de revisión de los bloques, restauraciones) y **copias de línea base** de los ficheros que cambiaron durante una sesión (más copias de lo que una restauración haya sobrescrito), en el almacenamiento global de VS Code para la extensión: `…/User/globalStorage/argalla.changekeeper/workspaces/<hash de la ruta de la carpeta>/`. En Windows está dentro de `%APPDATA%\Code\User\globalStorage\` (o el equivalente en VSCodium/Cursor).
- En repositorios git, los ficheros que estaban limpios al empezar la sesión **no** se copian: solo se anota su identificador de objeto git y el contenido se lee de git cuando hace falta.
- ChangeKeeper no escribe nada propio dentro de tu repositorio ni de la carpeta del espacio de trabajo. Los únicos ficheros que escribe son los que descartas o restauras explícitamente (de forma atómica, mediante un temporal `.<nombre>.<pid>.<n>.ck-tmp` junto al fichero, borrado de inmediato).
- El informe de sesión que puedes exportar contiene rutas y, en ficheros no críticos, la primera línea cambiada de cada bloque (en los críticos como `.env*`, claves o CI solo los rangos de líneas); con Pro también las últimas líneas de salida de las validaciones fallidas (cadenas con pinta de secreto redactadas) y los hallazgos de secretos redactados. No se exporta nada si no lo pides.

Las copias de línea base pueden contener lo que contengan tus ficheros — secretos incluidos — exactamente igual que ya están en tu disco. No van cifradas (viven en el mismo disco y con los mismos permisos que tu espacio de trabajo).

## Retención y borrado
- Las sesiones cerradas se eliminan pasados `changekeeper.retentionDays` días (30 por defecto) o cuando las sesiones cerradas superan `changekeeper.retentionMaxMB` (500 por defecto), empezando por las más antiguas. La sesión en curso nunca se borra automáticamente.
- **ChangeKeeper: Purgar todos los datos** borra todo lo que la extensión guardó para las carpetas abiertas. Desinstalar la extensión deja la carpeta de almacenamiento global de VS Code (comportamiento de VS Code); bórrala a mano si quieres.

## Qué lee
- Los ficheros de tu espacio de trabajo (para detectar y comparar cambios), el índice y los objetos git del repositorio (a través de tu ejecutable `git`) y los documentos abiertos en el editor.
- Los ficheros de configuración de agentes solo se tocan al ejecutar **ChangeKeeper Pro: Instalar hooks de agente** (`~/.claude/settings.json` de Claude Code o `.claude/settings.local.json` de un proyecto): se añaden nuestras entradas de hook HTTP tras un diálogo de consentimiento y una copia byte a byte, nada más del fichero cambia, y **Revertir hooks de agente** (o desinstalar la extensión) las quita. Los hooks solo envían a `127.0.0.1` en esta máquina.

## Red
Ninguna en las funciones gratuitas. **Licencia Pro:** al introducir una clave, ChangeKeeper llama a Polar (`api.polar.sh`) para activarla y, como mucho, una vez cada 24 horas para revalidarla (14 días de gracia sin conexión). Se envía: la clave, el nombre de este equipo, tu sistema operativo y la versión de la extensión — nunca ficheros, rutas ni ajustes. Los equipos sin clave no hacen ninguna llamada de red.

Preguntas: info@tecniartgalicia.com
