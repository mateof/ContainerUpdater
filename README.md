# ContainerUpdater

<p align="center">
  <a href="https://github.com/mateof/ContainerUpdater/actions/workflows/release.yml"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/mateof/ContainerUpdater/release.yml?branch=main&amp;label=CI&amp;logo=github"></a>
  <a href="https://github.com/mateof/ContainerUpdater/releases/latest"><img alt="Version" src="https://img.shields.io/github/v/release/mateof/ContainerUpdater?label=version&amp;color=blue"></a>
  <a href="https://github.com/mateof/ContainerUpdater/pkgs/container/container-updater"><img alt="GHCR image" src="https://img.shields.io/badge/ghcr.io-image-2496ED?logo=docker&amp;logoColor=white"></a>
  <a href="https://nodejs.org/"><img alt="Node.js" src="https://img.shields.io/badge/Node.js-TypeScript-339933?logo=nodedotjs&amp;logoColor=white"></a>
  <a href="LICENSE"><img alt="License" src="https://img.shields.io/github/license/mateof/ContainerUpdater"></a>
  <a href="https://github.com/mateof/ContainerUpdater/commits/main"><img alt="Last commit" src="https://img.shields.io/github/last-commit/mateof/ContainerUpdater"></a>
</p>

***English** · [Español](README.es.md)*

Self-hosted panel for watching and updating the Docker images on a **Synology NAS
running Container Manager**.

Container Manager never tells you when a new version of an image is out, and the
case that stings most is GHCR: a `latest` tag can sit months out of date with no
sign of it anywhere in the DSM interface. This app fixes that, and while it is at
it gathers in one place the things that used to mean opening an SSH session.

## What it does

- **Detects updates** by comparing the local digest against the registry
  manifest. Works with Docker Hub, GHCR (public and private), lscr.io, quay.io
  and your own registries.
- **Follows semantic versions** as well as digests: it tells you
  `postgres:18-alpine` exists when you are on `17-alpine`, without ever
  suggesting a jump between different base images.
- **Updates and restarts** the affected project, with Docker Compose when the
  YAML is reachable and by recreating the container through the API when it is
  not.
- **Per-image auto-update**: you mark the ones you want updated on their own and
  the rest just notify.
- **Force**: pulls again and recreates even when nothing changed.
- **Image cleanup**: marks the ones nobody uses, or that only stopped
  containers use, and deletes them. With stopped containers it names them
  first, because they will no longer be able to start.
- **Performance** of the NAS and of each container, live.
- **Telegram bot** restricted to the accounts you authorise, which notifies
  without repeating itself and takes commands.
- **Creates projects** from the web: you paste or upload a `docker-compose.yml`
  and its `.env`, and the folder is created, validated and brought up.
- **Interface in Spanish and English**, with light and dark themes.

## Installing on the NAS

1. Create the folder `/volume1/docker/container-updater`.
2. Copy [docker-compose.example.yml](docker-compose.example.yml) as
   `docker-compose.yml` and [.env.example](.env.example) as `.env` inside that
   folder.
3. Generate the encryption key and put it in the `.env`:
   ```bash
   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
   ```
   **Keep a copy off the NAS.**
4. In Container Manager, create a project pointing at that folder.
5. Go to `http://NAS-IP:8099`.

If you did not set `CU_ADMIN_PASSWORD`, the initial password is written once to
the logs: `docker logs container-updater`.

### The two mounts worth understanding

```yaml
- /volume1/docker:/volume1/docker
- /proc:/host/proc:ro
```

The first one **has to use the same path on both sides**. The containers
Container Manager creates carry labels holding NAS paths
(`/volume1/docker/n8n/docker-compose.yml`), and those paths only resolve inside
the container if the mount point matches exactly. Mounting it somewhere else does
not break the app, but every project would fall back to being updated by
recreating the container through the API instead of with Compose.

It goes **without `:ro`** so projects can be created from the web. It is the same
folder your stacks already live in: new ones are created right beside them, each
in its own subfolder, which is where you would expect to find them. If you are
not going to create projects from here, add `:ro`: Compose only needs to **read**
the YAML, and the volumes the services declare are resolved by the NAS daemon
without going through this mount.

That the app cannot overwrite one of your stacks does not come from this mount
but from the code: it refuses to create over a folder that already exists, and
only lets you edit projects created from the web. The `:ro` is one more layer,
not the main protection.

If you would still rather keep your stacks folder read-only and be able to create
projects, mount both and point `CU_PROJECTS_DIR` at the second:

```yaml
- /volume1/docker:/volume1/docker:ro
- /volume1/docker/projects:/volume1/docker/projects
```

The `/proc` mount is the one that gives you the real NAS metrics. Without it the
app still works, but shows approximate figures derived from Docker and says so in
the interface.

If your volume is not `volume1`, adjust the mount and `CU_COMPOSE_ROOTS`, which
takes a comma-separated list.

`CU_COMPOSE_ROOTS` and `DOCKER_HOST` are optional: without them the app probes
the usual Docker and Podman sockets and derives the project folders from what the
containers themselves declare. What it found is shown under **Settings →
Environment**, which is the first screen to look at when something is missing.
For other environments (Linux, Podman, TrueNAS SCALE, Unraid), see
[docs/PLATFORMS.md](docs/PLATFORMS.md).

## Security

**The Docker socket is equivalent to root on the NAS.** Whoever reaches this app
controls every container you have. Plainly:

- Do not open its port on the router. Publish it on the LAN only.
- If you want remote access, put it behind the DSM reverse proxy with HTTPS and a
  certificate, and turn on `CU_SECURE_COOKIES=1`.
- The initial password must be changed on first sign-in.

What the app does on its side: Argon2id password hashing, sessions with an
`httpOnly` cookie and an opaque token, attempt limits per IP and per username
with growing backoff, constant-time responses so it does not leak which usernames
exist, registry credentials encrypted with AES-256-GCM, and a strict CSP.

### If you lose `CU_ENCRYPTION_KEY`

The stored registry credentials are unrecoverable, by design. The app **still
starts** in degraded mode: it deletes nothing, marks those registries as needing
credentials, keeps checking the public ones and shows a warning. Entering them
again is a manual action on your part; nothing is ever deleted automatically.

## How it decides to update

For each container it looks at its Compose labels:

- **The YAML is reachable** → `docker compose up -d`, exactly what Container
  Manager would do. By default it only recreates the affected service
  (`--no-deps`), because you almost never want to take the database down to
  update the frontend. It validates the file with `compose config` first, since
  Container Manager keeps the project variables in its own store and there may be
  no `.env` at all.
- **It is not** → it recreates the container through the API: pull, rename the
  old one, create the new one with the same configuration, check it comes up
  properly and only then delete the previous one. If the new container fails to
  start, **it restores the previous one automatically**.

Updates run **in the background**. When you press the button the request returns
immediately and the job carries on by itself: you can close the dialog, switch
screens or walk away from the browser. Under **Updates** you see the running job
with live terminal output, and if you launch several they queue up and run one at
a time (two Compose invocations against the same project would corrupt its
state).

Some containers are refused up front because they cannot be reproduced reliably:
those sharing a network stack with another (`network_mode: container:`), those
using legacy `--link`, and those managed by Swarm or Kubernetes. The app says so
and points you at Container Manager rather than trying.

### About "force"

The literal sequence of delete the image, pull it again and refresh has a
problem: an image in use cannot be deleted, so it forces destroying the container
first, and it leaves a window where a failed pull means there is no image left to
go back to.

So the default behaviour of force is: pull first (which refreshes the local
digest even when the tag does not change), recreate, and clean up the now orphan
old image at the end. The result you see is the same and it can be rolled back.
The literal delete-first is still available as a checkbox, with the warning that
there is no safety net there, and only from the web: the bot does not offer it.

### Updating itself

It can, from the Images screen. The process does not do it itself, because it
would die halfway through: it launches a **helper container** that survives the
restart.

1. It pulls the new image while still running and validates the project. If
   anything fails here, nothing has been touched.
2. It launches the helper **with the old image**, the one already known to start.
3. The helper stops the panel, recreates it with the new version and checks that
   it answers. If it does not, it restores the previous one.
4. The screen waits and reloads on its own when the panel comes back.

**There are about 30 seconds without a panel.** That is unavoidable: somebody has
to survive the restart and it cannot be the one restarting. Everything the helper
does goes to `/data/self-update.log`, which is what to look at if it goes wrong.

With Docker Compose there is **no automatic rollback**: Compose deletes the
previous container and going back would mean changing the tag in your YAML, which
is yours. The interface warns you before you confirm. With direct recreation
there is automatic restore.

It is not offered from the Telegram bot: the panel goes down for a few seconds
and from a phone you would have no way to see what happened.

## Actions on a service

Under **Projects**, each service has a menu with what you would normally do over
SSH: recreate, restart, stop, start and pull the image. It only shows up when the
project file is reachable.

**Recreate** solves the typical case of a service that has got stuck and that you
used to fix like this:

```bash
cd /volume1/docker/media
docker compose rm -f -s player
docker compose up -d player
```

It does exactly those two steps, and not `up --force-recreate`, for one specific
reason: `--force-recreate` **would also recreate the dependencies**. If your
service sits behind a VPN or depends on a database, with this sequence those are
left untouched and are only started if they were stopped.

An example of a project where the difference matters:

```yaml
# /volume1/docker/media/docker-compose.yml
services:
  vpn:
    image: qmcgaw/gluetun:latest
    container_name: media-vpn

  player:
    image: ghcr.io/example/player:latest
    container_name: media-player
    network_mode: service:vpn
    depends_on:
      - vpn
```

Recreating `player` from the panel does not touch `vpn`. A `--force-recreate`
would take it down, and with it the connection of everything sitting behind it.

All these actions go through the same queue as the updates: they run one at a
time, they stay in the history and you can watch their output live.

## Creating projects from the web

Under **Projects**, the **New project** button opens an editor with two tabs: the
`docker-compose.yml` and the `.env`. In both you can type, paste, upload a file or
drop one on top.

The name you give it does two things: it names the Compose project and it names
its folder. That is why it only accepts lowercase, digits, dash and underscore.

```
/volume1/docker/player/docker-compose.yml
/volume1/docker/player/.env
```

Before anything is taken as good it is validated with Compose itself, with the
files already in place (which is the only way `${VARIABLE}` can be resolved
against the `.env` next to it). If the file has an error you are told which one
and no half-made folder is left behind. If you tick bring it up, it starts in the
background and progress shows under **Updates**.

### Editing the ones you already have

From the three-dot menu on each project, **regardless of who created it**. The
ones you made in Container Manager or over SSH can be edited exactly like the
ones created here.

What decides whether you can is what actually matters, not the provenance:

- That its file is reachable from inside the container.
- That there is **only one**. With several (`-f a.yml -f b.yml`) it is not clear
  which one to edit, and picking one ourselves would be guessing about your
  configuration.
- That its folder is writable, meaning it is not mounted with `:ro`.

When you cannot, the project card says which of the three is failing, rather than
leaving you a disabled button with no explanation.

The real filename is respected: if your project uses `compose.yaml`, that is what
gets edited rather than creating a `docker-compose.yml` next to it that nothing
would read.

### What happens to the `.env`

Compose has to read it in the clear, and so does anyone else bringing that stack
up over SSH, so **encrypting it on disk is not an option**: only this app could
start the project. What is done instead:

- It is written with `0600` permissions, readable only by its owner.
- On the project card, values whose key looks like it names a secret
  (`PASSWORD`, `TOKEN`, `SECRET`, `KEY`...) come up covered, with a button to
  show them **one at a time**.
- Every save archives the previous version **encrypted** in the database, with
  the same envelope as the registry credentials, in case you need to go back.
- Reading the file to edit it and showing a particular value both go into the
  audit log.

## In-app help

The **Help** button in the sidebar opens the documentation without leaving the
panel, with an index and a search box, in Spanish and English. It covers how
updates are detected, the per-service actions, private registries, the bot and
what to do when something fails.

## Telegram bot

Create it with [@BotFather](https://t.me/BotFather), put the token in
`CU_TELEGRAM_BOT_TOKEN` and restart. Under Settings, press "Link an account":
a single-use code is generated that expires in 10 minutes. Only the accounts on
that list can use the bot; any other gets a refusal and is logged.

| Command | What it does |
|---|---|
| `/images` | Lists your images and their status |
| `/status` | CPU, memory and a container summary |
| `/check` | Looks for updates now |
| `/update <image>` | Updates that image, with confirmation |
| `/force <image>` | Pulls and recreates it even with no changes |
| `/auto <image> on\|off` | Turns automatic updating on or off |
| `/projects` | Projects and their status |
| `/logs <container> [n]` | Last lines of the log |
| `/language es\|en` | Changes the language of that chat |

The commands have Spanish aliases (`/imagenes`, `/estado`, `/comprobar`,
`/actualizar`, `/forzar`, `/proyectos`, `/idioma`).

Notifications **do not repeat**: the dedupe key includes the remote digest, so
while `latest` points at the same image nothing is sent again, but as soon as it
points at a new one the notification goes out by itself.

## Development

```bash
npm install
npm run dev:server   # API on :8099
npm run dev:web      # interface on :5173, proxying to the API
npm test             # unit tests
npm run typecheck
```

Building the image locally:

```bash
npm run docker:build     # your architecture only, tag container-updater:local
npm run docker:push      # amd64 + arm64 to GHCR, normally done by the workflow
```

## Publishing

The image publishes itself to `ghcr.io/mateof/container-updater`. **The version in
the root `package.json` is what decides.** On every push to `main`, the workflow:

1. Runs typecheck, tests and build.
2. Reads the version from `package.json`.
3. If the tag `v{version}` **does not exist**, builds the image for `amd64` and
   `arm64`, pushes it to GHCR and creates the GitHub release.
4. If it **already exists**, it publishes nothing and says so in the run summary.

It does not fail when the version has not changed: a push that only touches
documentation should not paint Actions red, and getting used to seeing failures
is how real ones end up ignored.

To publish a new version, bump it before merging:

```bash
npm run version:patch    # fix
npm run version:minor    # new functionality
npm run version:major    # breaks existing configuration
```

Those scripts only touch the root `package.json` and create no tag; the tag is
created by the workflow. The version is injected into the image, so the one shown
under Settings is the real one.

No secrets need configuring: the workflow uses the `GITHUB_TOKEN` that Actions
already provides. Just make sure **Settings → Actions → General → Workflow
permissions** has *Read and write permissions* ticked.

To republish a version that already went out (say a release went wrong), run the
workflow by hand from the Actions tab with the force checkbox ticked.

## Documentation

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): how it is put together inside.
- [docs/SYNOLOGY.md](docs/SYNOLOGY.md): DSM specifics and common problems.
- [docs/PLATFORMS.md](docs/PLATFORMS.md): compose per environment for Linux,
  Podman, TrueNAS SCALE, Unraid and the rest, and what is actually verified.
- [docs/DECISIONS.md](docs/DECISIONS.md): why each technical decision, and what
  was ruled out.

Every document is also available in Spanish, with the `.es` suffix.

## Licence

MIT.
