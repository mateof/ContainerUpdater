# Architecture

*[Español](ARCHITECTURE.es.md)*

Monorepo using npm workspaces. A single container serves the API and the
interface from the same origin, which is what makes session cookies work without
CORS.

```
packages/shared/     zod schemas, DTO types and i18n catalogue (web + bot)
apps/server/         Fastify + SQLite + Docker + registries + Telegram
apps/web/            React + Vite, served by the backend itself
```

The translation catalogue lives in `packages/shared` on purpose: it is consumed
by both the web and the bot, so the two cannot drift apart and the bot speaks the
language the user picked in the interface.

## The flow of a check

```
cron (croner)
  → InventoryService.refresh()      reads containers and images from the socket
  → CheckerService.runCheck()       queries the registries
  → NotifierService                 notifies over Telegram, without repeating
  → UpdaterService.runAutoUpdates() applies whatever is marked automatic
```

## Update detection

`apps/server/src/registry/`

The hot path is **a single `HEAD` per image**. Verified against Docker Hub:
manifest HEADs do not count against the quota, so checking twenty images every
six hours is free.

1. **Normalise** (`reference.ts`). `nginx:alpine` becomes
   `registry-1.docker.io/library/nginx:alpine`. The implicit `library/` namespace
   only applies to Docker Hub; a component is a host rather than part of the
   repository if it contains a dot, a colon, or is `localhost`.

2. **Challenge-driven auth** (`auth.ts`). On a 401 the `WWW-Authenticate` header
   is read and the token requested from the `realm` **the header names**. This
   cannot be hardcoded: `lscr.io` answers with `realm="https://ghcr.io/token"`,
   meaning the registry you ask for the image and the one issuing the token are
   different hosts. There is also the no-challenge branch (public quay.io answers
   200 straight away) and the `Basic` branch for htpasswd registries.

   Tokens are cached per `(host, repository, scope)`. Verified: the Docker Hub
   token is scoped to one repository, and reusing the one for `library/nginx` to
   request `library/postgres` returns 401.

3. **Compare digests** (`manifest.ts`). `RepoDigests` is a **list** and can hold
   both the OCI index digest and the local architecture manifest digest:
   verified, `nginx:alpine` has two. The comparison is against the whole set. If
   the index digest matches there is nothing new, and that is where 95% of cases
   end. Only when it does not match is the index body downloaded and the child
   for the local platform looked up, discarding attestation entries whose
   platform is `unknown`.

4. **Versions** (`semver.ts`), when the policy asks for it. Tags are grouped by
   "flavour": `17-alpine` is only compared against `NN-alpine`, never against
   `17-bookworm` or plain `17`, and the `v` prefix of the original tag is kept in
   the proposal. Partial tags such as `8.2` are watched in both modes, because
   they are at once an anchor and a moving target, and those are different pieces
   of information.

### Images that cannot be checked

Images built on the machine have nothing remote to compare against, and pulling
would fetch somebody else's image that happens to share the name on Docker Hub.

The "no `RepoDigests` means local" heuristic is not enough: Podman assigns them a
local digest anyway. So detection is **reactive**: when the registry confirms the
repository does not exist (the public Docker Hub API does distinguish 404 from
private, unlike the registry endpoint, which returns 401 for both), the image is
marked `local-build` and left out of future checks. That mark survives inventory
refreshes.

## Updating

`apps/server/src/docker/{compose,recreate}.ts`

**Compose** when the YAML is reachable. `spawn` with `shell: false`, validated
names and paths resolved with `realpath` **before** checking them against the
allowed folders: the other way around, a symlink inside `/volume1/docker`
pointing elsewhere would pass the filter. The subprocess environment is explicit
and minimal, not inherited from the process, which holds the encryption key and
the Telegram token.

**Recreate** when it is not. Two things tools of this kind usually get wrong:

- Copying `Config.Env` verbatim pins the defaults of the **old** image, so if the
  new version changes one, the recreated container keeps the old value. A diff is
  taken against that image's configuration and only what the user set is carried
  over. Same for `Cmd`, `Entrypoint` and `Labels`.
- Anonymous volumes (64-hex names) do not show up in `Binds`. If they are not
  copied explicitly, the new container creates empty ones and the data is
  silently orphaned.

Secondary networks are attached **before** the start: afterwards, the app comes
up unable to resolve its neighbours and many fail at startup without retrying.

The health gate waits for `healthy` if the image declares a healthcheck; if not,
it waits and checks it has not restarted, because a container in a crash loop
passes a naive "is it running?" check. If anything fails, the previous container
is restored, which still exists because it was renamed rather than deleted.

## Metrics

`apps/server/src/docker/stats.ts` and `services/{host,metrics}.ts`

The usual CPU% formula uses `precpu_stats` as the previous sample. Verified: with
`stream=false`, Podman returns that block empty and dockerd leaves it empty on
the first read. So we keep our own previous sample and treat `precpu_stats` as an
optional hint. Fallback chain for the CPU count: `online_cpus`, then
`percpu_usage.length` (cgroup v1, old Synology kernels), then the daemon's
`NCPU`.

Memory subtracts the file cache (`inactive_file` on cgroup v2,
`total_inactive_file` on v1). Without subtracting it containers appear to use
three times what they do.

The host is read from `/host/proc` with our own reader. `systeminformation` was
ruled out: it reads fixed `/proc` paths, meaning the container's rather than the
NAS's, and would return container figures passing them off as the system's.
`MemAvailable` is used rather than `MemFree`, because with a file cache `MemFree`
is misleadingly low. Disks are sampled every five minutes: `df` wakes hibernating
drives.

**One global sampler**, not one per client, and it only runs while somebody is
watching. The interface closes the `EventSource` when the tab is hidden, at which
point the server stops sampling entirely.

Transport over SSE rather than WebSocket: the flow is one-way, `EventSource`
sends the cookie with no extra work, reconnects on its own and gets through the
DSM reverse proxy without configuring `Upgrade`. It needs `X-Accel-Buffering:
no`, or DSM's nginx buffers it and the events arrive in fits and starts.

## Data

SQLite with WAL and `synchronous=NORMAL`. Migrations by `PRAGMA user_version`.

Live metrics do **not** go to disk: writing every few seconds per container
punishes the NAS drives. They live in a ring buffer in memory and are only rolled
up to disk if the user turns on history.

The key of a Compose project is `(name, working_dir)`, not the name. Verified in
a real environment: Container Manager derives the name from the folder, so two
different stacks can both be called `docker`, and grouping by name would land a
`compose down` on the wrong one.

Projects created from the app are also recorded in the database. That is what
keeps one visible before it has any containers, which is exactly when you need to
get back into it to fix the YAML.

## Encryption

`crypto/keyring.ts`. Envelope encryption with `node:crypto`: a master key from
the environment wraps a data key generated on first start. Rotating the master
key means re-wrapping one key, not re-encrypting every row.

AES-256-GCM with a fresh IV on every write and an AAD binding the ciphertext to
its row and key version, so copying the blob from one registry to another fails
authentication instead of decrypting the neighbour's secret.

The same envelope protects the archived versions of the project files. A backup
of a secret is still a secret, and a `.env` holds database passwords and API
tokens.
