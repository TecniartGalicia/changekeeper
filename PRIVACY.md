# Privacy

**Short version:** ChangeKeeper works entirely on your machine. It sends nothing anywhere, has no telemetry and no account; the only network access is the optional Pro licence check (see Network).

## What it stores, and where
- Session state (which files changed, hunk review status, restore records) and **baseline copies** of files that changed during a session (plus copies of anything a restore overwrote), under VS Code's global storage for the extension: `…/User/globalStorage/argalla.changekeeper/workspaces/<hash of the folder path>/`. On Windows that is inside `%APPDATA%\Code\User\globalStorage\` (or the equivalent for VSCodium/Cursor).
- In git repositories, files that were clean at session start are **not** copied: only their git object id is recorded, and the content is read from git when needed.
- Nothing of ChangeKeeper's own is written inside your repository or workspace folder, with one exception you ask for: **ChangeKeeper Pro: Install Agent Hooks** with the "this project" scope writes `<project>/.claude/settings.local.json` and adds that path to `.git/info/exclude` (never to your `.gitignore`) so the token it contains is not committed. Apart from that, the only workspace files it writes are the ones you explicitly discard or restore (atomically, through a temporary `.<name>.<pid>.<n>.ck-tmp` next to the file, removed immediately).
- The session report you can export contains file paths and, for non-critical files, the first changed line of each hunk (for critical files such as `.env*`, keys or CI only the line ranges); with Pro it also contains the last lines of output of failed validations (secret-looking strings redacted) and redacted secret findings. Nothing is exported unless you ask.

Baseline copies can contain whatever your files contain — including secrets — exactly as they already exist on your disk. They are not encrypted (they live on the same disk with the same permissions as your workspace).

## Retention and deletion
- Closed sessions are removed after `changekeeper.retentionDays` (30 by default) or when closed sessions exceed `changekeeper.retentionMaxMB` (500 by default), oldest first. The running session is never deleted automatically.
- **ChangeKeeper: Purge All Data** deletes everything the extension stored for the open folders, including the backups of Claude Code settings files edited by the Pro hooks installer. Uninstalling the extension leaves VS Code's global storage folder behind (VS Code's behaviour); delete it by hand if you want.

## What it reads
- Your workspace files (to detect and diff changes), the git index and objects of the repository (through your `git` executable), and open editor documents.
- Agent configuration files are only touched when you run **ChangeKeeper Pro: Install Agent Hooks** (Claude Code's `~/.claude/settings.json` or a project's `.claude/settings.local.json`): our HTTP hook entries are added after a consent dialog and a byte-exact backup (the last 10 backups are kept in the extension's global storage, mode 0600 where the OS supports it; symlinked settings files are written through and keep their mode), nothing else in the file changes, and **Revert Agent Hooks** removes them. Uninstalling the extension removes the user-level entries and leaves `settings.json.changekeeper-uninstall.bak` next to the file; project-level files must be reverted before uninstalling. The hooks post to `127.0.0.1:<changekeeper.hooks.port>` on this machine only, with a per-user random token that is stored in clear in that settings file and in the extension's storage (`hooks/token`) — anyone who can read those files can post events to ChangeKeeper (events are file paths, never file contents; nothing is ever answered). The receiver listens only while hooks are installed or `autoStart` is `whenAgentDetected`; with several VS Code windows one owns the port and forwards events to the others through files in the extension's storage (paths and event names, no file contents, deleted within seconds).

## Network
None in the free features. **Pro licence:** when you enter a licence key, ChangeKeeper calls Polar (`api.polar.sh`) to activate it and again at most once every 24 hours to re-validate it (14-day offline grace). Sent: the key, this computer's name, your operating system and the extension version — never any file, path or setting. Machines where no key was entered make no network calls at all.

Questions: info@tecniartgalicia.com
