# Deployment

The image is published to `ghcr.io/danielgnth/zotero-sharelatex-sync` for `linux/amd64` and
`linux/arm64`. Tags:

- `latest`: the current `main` branch
- `sha-<commit>`: one per commit on `main`
- `1.2.3` and `1.2`: for git tags `v1.2.3`

For production, pin the image by digest (`...@sha256:…`) or by version tag.

Run **exactly one** instance per ShareLaTeX project.

## 1. Get the credentials

### Zotero API key

1. Open <https://www.zotero.org/settings/keys> and click **Create new private key**.
2. For a personal library: tick **Allow library access** and leave **Allow write access** off.
   For a group library: under **Per group permissions**, give **Read Only** access to that group
   only.
3. Note the key, and your **user ID** ("Your userID for use in API calls is …") on the same page.
   For a group, the ID is the number in the group's URL (`zotero.org/groups/<id>/…`).
4. Collection key: open the collection in the Zotero web library. The URL ends in
   `/collections/<KEY>`.

### ShareLaTeX git token

1. In ShareLaTeX/Overleaf, open **Account settings → Git integration** and generate a token.
2. The project's git URL is shown under **Menu → Git** in the project, e.g.
   `https://latex.example.edu/git/<project-id>`. Use it **without** any credentials.

### Store them as files

```sh
mkdir -p secrets
printf '%s' 'YOUR_ZOTERO_KEY' > secrets/zotero_api_key
printf '%s' 'YOUR_GIT_TOKEN'  > secrets/sharelatex_git_token
chmod 400 secrets/*
```

`secrets/` is git-ignored. Keep these files out of version control and shell history (e.g. paste
them with an editor instead of `printf`).

## 2a. Docker Compose

Edit [compose.yaml](../compose.yaml) (library, collection, git URL) and start the service:

```sh
# The container runs as UID 1000; the secret files must be readable by it.
sudo chown 1000:1000 secrets/*
docker compose up -d
docker compose logs -f
```

To test the credentials once before running the daemon:

```sh
docker compose run --rm zotero-sharelatex-sync once
```

The example is hardened: read-only root filesystem with a `/tmp` tmpfs, all capabilities
dropped, `no-new-privileges`, and limits on memory and processes. `restart: unless-stopped` restarts
the service whenever the internal watchdog exits.

## 2b. Kubernetes

```sh
kubectl create secret generic zotero-sharelatex-sync \
  --from-file=zotero_api_key=./secrets/zotero_api_key \
  --from-file=sharelatex_git_token=./secrets/sharelatex_git_token
# edit the env values in the manifest first
kubectl apply -f deploy/kubernetes/deployment.yaml
```

[deploy/kubernetes/deployment.yaml](../deploy/kubernetes/deployment.yaml) mounts the secret as files
(`*_FILE` variables). It runs non-root with a read-only root filesystem, a memory-backed `/tmp`,
and no service-account token. A liveness probe runs the `healthcheck` command. External secret
managers (External Secrets Operator, Sealed Secrets, Vault agent) work the same way, as long as
they produce a Kubernetes secret or files. Plain `env.valueFrom.secretKeyRef` also works with the
non-`_FILE` variable names.

The pod only needs **egress** to `api.zotero.org:443`, `stream.zotero.org:443` and your ShareLaTeX
host. Add a NetworkPolicy if your cluster enforces them.

## Verify the image

Every published image carries a SLSA build-provenance attestation and an SPDX SBOM attestation,
signed through GitHub's Sigstore integration:

```sh
gh attestation verify oci://ghcr.io/danielgnth/zotero-sharelatex-sync:latest --owner danielgnth
gh attestation verify oci://ghcr.io/danielgnth/zotero-sharelatex-sync:latest --owner danielgnth \
  --predicate-type https://spdx.dev/Document/v2.3
```

BuildKit also attaches its own SBOM and provenance to the image index
(`docker buildx imagetools inspect --format '{{json .SBOM}}' <image>`).

## Operating it

- Logs are JSON lines. Useful messages: `Pushed bibliography`, `Bibliography unchanged`,
  `Duplicate citation key renamed`, `Sync failed` (with `retryInMs`), and
  `Unhealthy, exiting so the container gets restarted`.
- Exit codes: `0` clean shutdown, `1` watchdog or runtime failure (restarted), `2` invalid
  configuration (fix the config; restarting will not help).
- Rotating a secret: replace the secret file or Kubernetes secret and restart the container.
