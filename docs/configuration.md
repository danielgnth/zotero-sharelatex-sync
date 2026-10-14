# Configuration

All configuration comes from environment variables. Any variable marked as a secret can be given
either directly (`NAME`) or as a path to a file containing it (`NAME_FILE`). Setting both is an
error. The file content is trimmed, so trailing newlines are fine. Prefer `_FILE` with Docker or
Kubernetes secrets.

With Docker Compose, set the variables in a `.env` file. Copy [.env.example](../.env.example), which
lists the common ones. With Kubernetes, set them in the Deployment's `env`, or in a ConfigMap
referenced via `envFrom`.

Invalid configuration makes the process exit with code **2** and a message naming the variable.

## Zotero

| Variable | Default | Description |
| --- | --- | --- |
| `ZOTERO_API_KEY` / `ZOTERO_API_KEY_FILE` | required, **secret** | Zotero API key with read access to the library. Create it at <https://www.zotero.org/settings/keys>. |
| `ZOTERO_LIBRARY_TYPE` | `user` | `user` for your personal library, `group` for a group library. |
| `ZOTERO_LIBRARY_ID` | required | Numeric user ID (shown on the API keys page) or group ID (in the group's URL). |
| `ZOTERO_COLLECTION_KEY` | empty | 8-character collection key (e.g. `ABCD2345`, from the web library URL). Empty exports the whole library. |
| `ZOTERO_INCLUDE_SUBCOLLECTIONS` | `true` | Also export items from all subcollections of `ZOTERO_COLLECTION_KEY`. |
| `BIB_FORMAT` | `bibtex` | `bibtex` or `biblatex` (Zotero's built-in translators). |

## ShareLaTeX / Overleaf

| Variable | Default | Description |
| --- | --- | --- |
| `SHARELATEX_GIT_URL` | required | The project's git URL, e.g. `https://latex.example.edu/git/<project-id>`. It **must not** contain credentials, and must use `https://`. |
| `SHARELATEX_GIT_TOKEN` / `SHARELATEX_GIT_TOKEN_FILE` | required, **secret** | Git authentication token from your ShareLaTeX account settings. |
| `SHARELATEX_GIT_USERNAME` | `git` | Username sent with the token. Overleaf uses `git`; change it only if your instance expects something else. |
| `SHARELATEX_GIT_BRANCH` | `master` | Branch to push to (Overleaf projects use `master`). |
| `SHARELATEX_BIB_PATH` | `references.bib` | Path of the generated file inside the project. Must be relative and stay inside the project. |
| `SHARELATEX_COMMIT_MESSAGE` | `Update bibliography from Zotero` | Commit message. |
| `SHARELATEX_COMMIT_AUTHOR_NAME` | `Zotero Sync` | Commit author and committer name. |
| `SHARELATEX_COMMIT_AUTHOR_EMAIL` | `zotero-sync@localhost` | Commit author and committer email. |
| `SHARELATEX_ALLOW_INSECURE_HTTP` | `false` | Allow an `http://` git URL. Only use this for a server you reach over a trusted network. |

## Sync behaviour

| Variable | Default | Description |
| --- | --- | --- |
| `SYNC_DEBOUNCE_SECONDS` | `30` | Wait this long after the last change event before syncing. |
| `SYNC_MAX_DEBOUNCE_SECONDS` | `300` | Sync at the latest this long after the first event of a burst. |
| `SYNC_SAFETY_INTERVAL_SECONDS` | `3600` | Interval of the cheap fallback check (`304` if unchanged). Minimum 60. |
| `SYNC_RETRY_BASE_SECONDS` | `30` | First retry delay after a failed sync; doubles per failure. |
| `SYNC_RETRY_MAX_SECONDS` | `900` | Upper bound for the retry delay. |

## Health and watchdog

| Variable | Default | Description |
| --- | --- | --- |
| `WATCHDOG_STREAM_MAX_DOWN_SECONDS` | `900` | Exit (and get restarted) if the streaming API stays disconnected this long. Minimum 60. |
| `WATCHDOG_STALE_AFTER_SECONDS` | 3 × safety interval | Exit if no sync or version check succeeded for this long. Minimum 120. |
| `HEALTH_FILE` | `$TMPDIR/zotero-sharelatex-sync.health.json` (`/tmp/...` in the image) | Where the daemon writes its health state for the `healthcheck` command. |

## Runtime

| Variable | Default | Description |
| --- | --- | --- |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn` or `error`. Logs are JSON lines on stdout. |
| `WORK_DIR` | OS temp dir (`/tmp` in the image) | Where temporary clones are created and removed. |
| `ZOTERO_API_URL` | `https://api.zotero.org` | Override for tests. |
| `ZOTERO_STREAM_URL` | `wss://stream.zotero.org` | Override for tests. |

## Commands

The container's entrypoint is `bun /app/src/index.ts`. The command is the first argument:

| Command | Purpose |
| --- | --- |
| `daemon` (default) | Long-running, event-driven sync. |
| `once` | One full sync, then exit 0 (success) or 1 (failure). Useful for testing credentials or for a cron job. |
| `healthcheck` | Exit 0 if the running daemon reports healthy. Used by Docker `HEALTHCHECK` and the Kubernetes liveness probe. |
| `git-credential` | Internal: the git credential helper. |
