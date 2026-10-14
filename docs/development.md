# Development

Requirements: [Bun](https://bun.sh) (version in `package.json` → `packageManager`) and git.
Docker is only needed to build the image or run the workflow linters locally.

```sh
bun install
bun run check        # biome lint+format check, tsc typecheck, bun test
bun run format       # apply biome fixes and formatting
TEST_LOGS=1 bun test # show application logs during tests
```

All project scripts are Bun: either `package.json` scripts or TypeScript files run with `bun`.
Do not add shell, Python or Node scripts.

## Running locally

```sh
export ZOTERO_LIBRARY_ID=1234567 ZOTERO_COLLECTION_KEY=ABCD2345
export ZOTERO_API_KEY_FILE=$PWD/secrets/zotero_api_key
export SHARELATEX_GIT_URL=https://latex.example.edu/git/<project-id>
export SHARELATEX_GIT_TOKEN_FILE=$PWD/secrets/sharelatex_git_token
bun src/index.ts once      # single sync
LOG_LEVEL=debug bun src/index.ts   # daemon
```

## Tests

| Test | Covers |
| --- | --- |
| `test/config.test.ts` | Env parsing, `_FILE` secrets, validation |
| `test/bib.test.ts` | Key extraction, filtering, collisions, deterministic output |
| `test/collections.test.ts` | Subcollection resolution |
| `test/zotero-client.test.ts` | Paging, 304 handling, retries, `Backoff`/`Retry-After`, errors (fake `fetch`) |
| `test/stream.test.ts` | Streaming protocol, reconnects, rejected subscriptions, handshake timeout (local WebSocket server) |
| `test/scheduler.test.ts` | Debounce, max wait, single flight, retries, shutdown |
| `test/syncer.test.ts` | Sync orchestration with fakes |
| `test/git.test.ts` | Publishing to a real local bare repo; git environment hygiene |
| `test/git-credential.test.ts` | Credential helper logic and invocation through the entrypoint |
| `test/health.test.ts` | Health evaluation and health file |
| `test/e2e.test.ts` | The real daemon process against a fake Zotero (REST + WebSocket) and `git http-backend` with Basic auth; also checks that no secret appears in the logs |

Nothing in the test suite talks to the real Zotero or ShareLaTeX servers.

## CI/CD

[.github/workflows/ci.yml](../.github/workflows/ci.yml) runs on pull requests, pushes to `main`,
and `v*` tags:

| Job | Tools |
| --- | --- |
| Lint, typecheck & test | `biome ci`, `tsc --noEmit`, `bun test` |
| Lint workflows | [actionlint](https://github.com/rhysd/actionlint), [zizmor](https://docs.zizmor.sh) (GitHub Actions security) |
| Lint Dockerfile | [hadolint](https://github.com/hadolint/hadolint) |
| Secret scan | [gitleaks](https://github.com/gitleaks/gitleaks) over the full history |
| Build & scan image | Builds the image, smoke-tests it, and runs [grype](https://github.com/anchore/grype) (fails on fixable high/critical CVEs) |
| Publish (push events only) | Multi-arch build and push to GHCR with BuildKit SBOM/provenance, a Syft SPDX SBOM, and GitHub attestations for provenance and SBOM |

Publishing only runs after all other jobs pass. Releases: push a tag `vX.Y.Z` on `main`.

Workflow conventions (zizmor enforces most of them):

- Every action is pinned to a full commit SHA with a `# vX.Y.Z` comment. Dependabot updates them.
- Top-level `permissions: {}`; each job requests only what it needs.
- `actions/checkout` always uses `persist-credentials: false`.
- No caches in this workflow (it publishes artifacts, so caches would be a poisoning risk).

Run the same linters locally:

```sh
hadolint Dockerfile
docker run --rm -v "$PWD:/repo" -w /repo rhysd/actionlint:1.7.12 -color
docker run --rm -v "$PWD:/repo:ro" -w /repo ghcr.io/zizmorcore/zizmor:1.30.1 .
```

## Updating Bun

The Bun version appears in two places: `packageManager` in `package.json` (CI) and the base image
tag and digest in the `Dockerfile` (runtime). Dependabot bumps the Dockerfile. Keep both in step.
