# Privacy

**Short version:** ChangeKeeper works entirely on your machine. It sends nothing anywhere, has no telemetry, no account and no network access.

## What it stores, and where
- Session state (which files changed, hunk review status, restore records) and **baseline copies** of files that changed during a session (plus copies of anything a restore overwrote), under VS Code's global storage for the extension: `…/User/globalStorage/argalla.changekeeper/workspaces/<hash of the folder path>/`. On Windows that is inside `%APPDATA%\Code\User\globalStorage\` (or the equivalent for VSCodium/Cursor).
- In git repositories, files that were clean at session start are **not** copied: only their git object id is recorded, and the content is read from git when needed.
- Nothing is written inside your repository or workspace folder.

Baseline copies can contain whatever your files contain — including secrets — exactly as they already exist on your disk. They are not encrypted (they live on the same disk with the same permissions as your workspace).

## Retention and deletion
- Closed sessions are removed after `changekeeper.retentionDays` (30 by default) or when closed sessions exceed `changekeeper.retentionMaxMB` (500 by default), oldest first. The running session is never deleted automatically.
- **ChangeKeeper: Purge All Data** deletes everything the extension stored for the open folders. Uninstalling the extension leaves VS Code's global storage folder behind (VS Code's behaviour); delete it by hand if you want.

## What it reads
- Your workspace files (to detect and diff changes), the git index and objects of the repository (through your `git` executable), and open editor documents.
- No configuration files of any agent are read or written in this version.

## Network
None. Future optional Pro features would use the network only for licence validation, and would say so here first.

Questions: info@tecniartgalicia.com
