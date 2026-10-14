# CLAUDE.md

Instructions for Claude (and other agents) working in this repository.

## What this is

A Bun/TypeScript daemon, shipped as a container, that syncs a Zotero library or collection into a
`.bib` file in a ShareLaTeX/Overleaf project via the git bridge. It reacts to Zotero's streaming
API (WebSocket) instead of polling. Start with [docs/architecture.md](docs/architecture.md).
Every module is listed there.

## Commands

```sh
bun install
bun run check     # biome + tsc + bun test (run before every commit)
bun run format    # apply biome fixes
bun test          # TEST_LOGS=1 to see application logs
hadolint Dockerfile
docker run --rm -v "$PWD:/repo" -w /repo rhysd/actionlint:1.7.12 -color
docker run --rm -v "$PWD:/repo:ro" -w /repo ghcr.io/zizmorcore/zizmor:1.30.1 .
```

## Rules

- **Documentation is part of every change.** When behaviour, configuration, deployment or CI
  changes, update the matching file in `docs/` (and the README if user-facing) in the same commit.
  A new environment variable must appear in `src/config.ts`, `test/config.test.ts` and
  `docs/configuration.md`.
- **All scripts are Bun.** Use `package.json` scripts or `.ts` files run with `bun`. No shell,
  Python or Node scripts in the repo.
- **No runtime dependencies.** Bun provides fetch, WebSocket, spawn and crypto. Discuss before adding
  any runtime package. Dev dependencies are fine.
- **Keep tests offline.** Never call the real Zotero or ShareLaTeX servers from tests. Use the fakes
  in `test/` (see `test/e2e.test.ts` for the fake Zotero and `git http-backend` setup).
- **Code style:** Biome formatting (2 spaces, 100 columns), `.ts` import extensions, short
  explanatory header comments on modules, no `any`.

## Security invariants (do not regress)

- Secrets are read through `readSecret` (supports `NAME_FILE`) and registered with
  `registerSecret` so the logger redacts them.
- The git token never goes into a URL, argv, `.git/config` or any file. git gets it from the
  credential helper (`src/git-credential.ts`) via `GIT_CONFIG_*` env vars. The helper answers only
  for the configured host.
- git subprocesses get the allow-listed environment from `gitEnv()`, never `process.env`.
- The Zotero key is sent only as a header or in the WebSocket subscription message.
- The container must keep working as UID 1000 with a read-only root filesystem and no
  capabilities.
- `test/e2e.test.ts` asserts that no secret appears in the logs. Keep it passing.

## GitHub and git

- The repository is `github.com/danielgnth/zotero-sharelatex-sync`. Only ever use the GitHub
  account **danielgnth**. **Never use the account `danielgnt`** (note the missing "h"). It is a
  different account. Check with `gh auth status` before any `gh` call that writes.
- Do not set a repo-local `user.email`/`user.name`. The user's global git config includes
  `~/.config/git/config-secondary` for everything under `.../Coding/01_danielgnth/` (`includeIf`).
  That file sets the danielgnth identity (noreply email), the SSH signing key and the SSH key. Check
  with `git config --show-origin user.email`, never with `git config --global user.email`, which
  ignores the include and shows the other account's email.
- The remote uses HTTPS with a repo-local credential helper `!gh auth git-credential` (the macOS
  keychain may hold credentials for the other account).
- In workflows, pin every action to a full commit SHA with a `# vX.Y.Z` comment, keep
  `permissions` minimal per job, use `persist-credentials: false`, and avoid caches. CI runs
  actionlint and zizmor, so run them locally first.

## Known unverified assumptions

- That Zotero's BibTeX/BibLaTeX export honours `Citation Key: …` in the Extra field
  (documented as expected, not yet tested against the live API).
- The exact git username/token scheme of the target ShareLaTeX instance (default username `git`).
