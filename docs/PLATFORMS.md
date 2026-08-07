# Platforms

***English** · [Español](PLATFORMS.es.md)*

ContainerUpdater does not talk to Synology, or TrueNAS, or Unraid. It talks to
the Docker API. Everything that changes from one platform to another is three
things: **where the socket is**, **where the Compose projects live** and
**whether the host's `/proc` is reachable**. All three are worked out
automatically since version 0.6.0, so in most places mounting the socket and
starting is enough.

This document explains what gets detected, what is actually verified, and what
the compose looks like for each environment.

The examples also mount a writable folder (`CU_PROJECTS_DIR`), which is what
makes creating projects from the web possible. Drop it and everything else keeps
working the same.

---

## What the app works out on its own

At startup it does three things before setting anything up:

1. **Looks for the socket** among the usual places: `/var/run/docker.sock`,
   `/run/docker.sock`, `/run/podman/podman.sock`,
   `$XDG_RUNTIME_DIR/podman/podman.sock` and `/var/run/podman/podman.sock`. It
   checks the socket can be read **and written**, not just that the file exists,
   because a socket mounted without permissions is the most common deployment
   failure and this way it can say clearly that the problem is permissions and
   not the path.

2. **Derives the project folders** by reading the
   `com.docker.compose.project.working_dir` labels of the containers already
   there. This beats a per-platform path table because it guesses nothing: it is
   where Docker itself says the stacks are. For each project it takes the parent
   folder, discards the ones not reachable from inside the container, and drops
   those already hanging off another allowed one.

3. **Identifies the platform** by combining those paths, the mounted volumes and
   what the daemon answers.

All of it shows under **Settings → Environment**. That is the first screen to
look at when something is missing: it says which socket it uses, which folders it
accepts and how many projects it can handle versus how many it sees.

Setting `DOCKER_HOST` or `CU_COMPOSE_ROOTS` turns off the corresponding
detection. You still can, and it is still the right move if your setup is
unusual.

---

## Support status

Verified support is kept distinct from support inferred from each platform's
documentation, and the interface labels it. Claiming something is verified when
it has not been tried misleads exactly when things go wrong.

| Environment | Status | Update strategy |
|---|---|---|
| Synology DSM 7.x (Container Manager) | Verified | Compose |
| Docker on Linux or macOS | Verified | Compose |
| Podman 4.x and 5.x | Verified | Compose or recreate |
| TrueNAS SCALE 24.10 or newer | Declared, untested | Compose |
| Unraid 6.12+ | Declared, untested | Recreate (see below) |
| OpenMediaVault 6/7 | Declared, untested | Compose |
| TrueNAS CORE, FreeNAS, pfSense | **Not supported** | — |

On TrueNAS CORE and FreeNAS: this is not a limitation of the app. They are
FreeBSD, and Docker does not exist on FreeBSD because it depends on Linux kernel
cgroups and namespaces. The nearest thing is jails, which are a different model.
If you want to run this on a TrueNAS CORE, the route is a Linux VM inside TrueNAS
itself, and then the app manages the containers **of that VM**, not the host's
jails.

---

## The two update strategies

Worth understanding before looking at the compose files, because it is what
decides whether a given mount is worth the trouble.

**Compose.** Used when the project YAML is reachable from inside the container.
This is the good one: it respects exactly what is written in the file, including
dependencies, networks and variables.

**Recreate.** Used when it is not. It reads the configuration of the running
container, copies it onto the new image and brings it up, with automatic rollback
if it fails to start. It works well, but it reproduces what is **running**, not
what is written in the YAML. If somebody edited the file and has not brought the
stack back up, that change is not applied.

Which one is used comes down to a single detail: **that the YAML is mounted at
the same path as on the host**. The labels hold host paths and they only resolve
inside the container if the mount point matches exactly.

---

## Docker on Linux

The simplest case. Nothing to configure beyond the socket and the data:

```yaml
services:
  container-updater:
    image: ghcr.io/mateof/container-updater:latest
    restart: unless-stopped
    ports:
      - "8099:8080"
    environment:
      TZ: Europe/Madrid
      CU_ENCRYPTION_KEY: ${CU_ENCRYPTION_KEY}
      CU_PROJECTS_DIR: /srv/stacks/own
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - ./data:/data
      # Wherever your stacks are, same path on both sides.
      - /srv/stacks:/srv/stacks:ro
      # Writing only here, so projects can be created from the web.
      - /srv/stacks/own:/srv/stacks/own
      - /proc:/host/proc:ro
```

If your projects are spread out (say `/srv/stacks` and `/home/ana/projects`),
mount both with their real path. Detection takes care of the rest.

On `user`: by default the container runs as root, which makes nothing worse
because the socket already grants root-equivalent privileges on the host. If you
would rather not, use `group_add` with the GID of the `docker` group:

```yaml
    user: "1000:1000"
    group_add:
      - "988"   # getent group docker | cut -d: -f3
```

---

## Podman

Podman implements the Docker API, so it works with no adaptation. Two details
that do matter:

**The socket has to be enabled.** It is not on by default:

```bash
# Rootful, which is usually what a server wants.
sudo systemctl enable --now podman.socket

# Rootless, if you would rather the containers belonged to your user.
systemctl --user enable --now podman.socket
```

**In rootless mode the socket goes through `$XDG_RUNTIME_DIR`** and the container
needs to see it:

```yaml
services:
  container-updater:
    image: ghcr.io/mateof/container-updater:latest
    restart: unless-stopped
    # Without this, SELinux blocks socket access on Fedora and RHEL. The symptom
    # is a "permission denied" at startup even though the permissions look right.
    security_opt:
      - label=disable
    ports:
      - "8099:8080"
    environment:
      TZ: Europe/Madrid
      CU_ENCRYPTION_KEY: ${CU_ENCRYPTION_KEY}
      # In rootless mode be explicit: detection looks at XDG_RUNTIME_DIR, which
      # inside the container is not the same one as outside.
      DOCKER_HOST: unix:///run/podman/podman.sock
    volumes:
      - /run/user/1000/podman/podman.sock:/run/podman/podman.sock
      - ./data:/data
      - /home/ana/projects:/home/ana/projects:ro
      - /proc:/host/proc:ro
```

With `podman-compose` instead of the Docker plugin, set `CU_DOCKER_BIN: podman`.

One specific warning: Podman also fills in `RepoDigests` for locally built
images, which Docker does not. The app works this out on its own as soon as the
registry confirms that repository does not exist, marks the image as locally
built and stops querying it. The first check may show up as failed before that
happens; that is normal and corrects itself.

---

## Synology DSM 7.x

Covered in detail in [SYNOLOGY.md](SYNOLOGY.md). The summary: Container Manager
projects live under `/volume1/docker` (or whichever volume you use) and that
folder has to be mounted at the same path. See
[docker-compose.example.yml](../docker-compose.example.yml) in the root.

---

## TrueNAS SCALE

From version 24.10 (Electric Eel) onwards, TrueNAS SCALE replaced Kubernetes with
Docker. That is what makes support possible: on earlier versions, built on k3s,
there is no Docker socket to talk to.

Stacks deployed from the apps interface live under `/mnt/.ix-apps`, which is a
dataset the system manages. **Do not touch them from here**: TrueNAS reconciles
them against its own configuration and will overwrite whatever you do. The
sensible thing is to use the app for your own stacks, in a separate dataset:

```yaml
services:
  container-updater:
    image: ghcr.io/mateof/container-updater:latest
    restart: unless-stopped
    ports:
      - "8099:8080"
    environment:
      TZ: Europe/Madrid
      CU_ENCRYPTION_KEY: ${CU_ENCRYPTION_KEY}
      # Your stacks, not the ones from the apps interface. Setting it explicitly
      # stops detection pulling in /mnt/.ix-apps when it sees containers there.
      CU_COMPOSE_ROOTS: /mnt/tank/stacks
      CU_PROJECTS_DIR: /mnt/tank/stacks
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - /mnt/tank/apps/container-updater:/data
      - /mnt/tank/stacks:/mnt/tank/stacks
      - /proc:/host/proc:ro
```

Apps deployed from the interface will still appear in the container and image
lists, with their metrics and their new-version notices. They simply will not be
updated from here: that is what the TrueNAS app manager is for, and it has the
final say.

---

## Unraid

Unraid manages its containers with XML templates, not with Compose. Unless you
use the community Docker Compose plugin, there will be **no Compose labels** and
therefore no project folders to derive. The app handles that: with no reachable
YAML it falls back to recreate, which is exactly the case that strategy exists
for.

```yaml
services:
  container-updater:
    image: ghcr.io/mateof/container-updater:latest
    restart: unless-stopped
    ports:
      - "8099:8080"
    environment:
      TZ: Europe/Madrid
      CU_ENCRYPTION_KEY: ${CU_ENCRYPTION_KEY}
      CU_PROJECTS_DIR: /mnt/user/appdata/cu-projects
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - /mnt/user/appdata/container-updater:/data
      - /mnt/user/appdata/cu-projects:/mnt/user/appdata/cu-projects
      - /proc:/host/proc:ro
```

An important consequence: recreating a container reproduces its **running**
configuration, not the Unraid template. If you then edit the template from the
Unraid interface and hit apply, the template wins. The two coexist, but it is
worth knowing which one wins when.

If you use the Compose plugin, mount your stacks folder as on Linux and you move
to the good strategy.

---

## OpenMediaVault

With the `openmediavault-compose` plugin, stacks live wherever you configured
them, typically under `/srv/dev-disk-by-uuid-.../compose`. It is a standard
Debian with Docker, so the Linux compose applies with that path mounted.

---

## macOS and Windows with Docker Desktop

Works for development and for managing local containers, with one limitation
there is no way around: **the system metrics will not be your machine's**. Docker
Desktop runs containers inside a Linux VM, so `/proc` is that VM's. The app
detects this and says so in the interface rather than showing invented figures.

```yaml
services:
  container-updater:
    image: ghcr.io/mateof/container-updater:latest
    ports:
      - "8099:8080"
    environment:
      CU_ENCRYPTION_KEY: ${CU_ENCRYPTION_KEY}
      CU_PROJECTS_DIR: /Users/ana/projects/own
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - ./data:/data
      - /Users/ana/projects:/Users/ana/projects
```

On Windows with WSL2, mount the socket as
`//var/run/docker.sock:/var/run/docker.sock` and use WSL paths, not `C:\` ones.

---

## Diagnosing

**Settings → Environment** answers the questions in the order they usually come
up:

| What you see | What it means |
|---|---|
| Socket labelled "auto" | It was found by probing. If it is not the one you want, set `DOCKER_HOST`. |
| "The socket exists but cannot be used" | It is mounted but permissions are missing. That is a mount problem, not a path problem. |
| Manageable projects fewer than detected | Those projects are visible but their folder is not mounted here, or not at the same path. They will be updated by recreate. |
| Project folders empty | There are no containers with Compose labels, or none of their folders is reachable. |
| Platform "Unverified" | Support is inferred from that platform's documentation, not tested on it. It should work; if it does not, that is a bug worth hearing about. |
| System metrics unavailable | `/proc:/host/proc:ro` is missing. The app works the same, with approximate metrics. |
| Projects cannot be created | There is no writable folder. Mount one and point `CU_PROJECTS_DIR` at it. |

---

## On plugins

The natural question on seeing this list is whether an extension system would
help, with one plugin per platform. The short answer is no, and the reason is
that **the abstraction such a system would provide already exists: it is the
Docker API**.

Every supported platform exposes the same API. A plugin per platform would add no
behaviour, only three different constants (socket, paths, markers) wrapped in an
interface, a loader and a contract to maintain. That is more code, more failure
surface and a path for arbitrary code execution inside a process that holds the
Docker socket, in exchange for nothing that automatic detection and two
environment variables do not already solve.

Where an extension would make sense is in what is **not** Docker: reading drive
temperatures and RAID status on DSM, integrating the TrueNAS app manager,
notifying through something other than Telegram. That is genuinely
platform-specific functionality, and it is where we would look first if it ever
came up.
