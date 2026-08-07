# Synology and DSM

*[Español](SYNOLOGY.es.md)*

The NAS specifics that shape how this works, and the problems you are most
likely to run into.

## Container Manager

Since DSM 7.2 the Docker package is called Container Manager and ships Compose
built in. Its "projects" are ordinary Compose stacks: the containers carry the
standard `com.docker.compose.*` labels, so there is no need to talk to any
proprietary Synology API.

Projects normally live under `/volume1/docker/<name>`.

### The project name is not unique

Container Manager derives the project name from the folder name. Two stacks in
`/repos/a/docker` and `/repos/b/docker` are **both** called `docker`. Verified in
a real environment with three same-named projects.

That is why the app identifies each project by `(name, directory)`. Grouping by
name alone would land a `compose down` on the wrong stack, which is a disaster
that is hard to undo.

### The project may show up as modified

After the app runs Compose, Container Manager may show the project as changed
outside its control. It usually reconciles on its own. That is why the default
behaviour is to recreate only the affected service (`--no-deps`), which touches
the least.

### The project variables are not in a .env

Container Manager keeps the project environment in its own store, so there may be
no `.env` next to the YAML at all. If the file references `${DB_PASSWORD}` and
that variable is not available, `compose up` fails halfway and leaves the stack
half up.

That is why `compose config --quiet` always runs before anything is touched: if
variables are missing, the failure happens without having stopped any container
and you get a clear error.

## Mounts

### The path has to match

```yaml
- /volume1/docker:/volume1/docker:ro
```

Compose labels hold NAS paths. Inside the container they only resolve if the
mount point is identical. With `-v /volume1/docker:/projects`, the app would look
for `/volume1/docker/n8n/docker-compose.yml` and not find it.

It is not fatal: projects would fall back to being updated by recreating the
container through the API, which works but leaves the Container Manager view less
in sync. The interface tells you which method each project will use and why.

If your projects are on `volume2`, adjust the mount and `CU_COMPOSE_ROOTS`, which
takes a comma-separated list.

### Read-only

That mount can and should be `:ro`. Compose only needs to **read** the YAML; the
volumes the services declare are resolved by the NAS daemon and never go through
this mount.

### The writable folder for new projects

Creating projects from the web does need write access, and that is why it goes in
a **separate** mount:

```yaml
- /volume1/docker:/volume1/docker:ro
- /volume1/docker/projects:/volume1/docker/projects
```

Reading still covers all of `/volume1/docker`, but writing is confined to that
subfolder. It is deliberate: a mistake while creating a project cannot overwrite
a stack that already works. Point `CU_PROJECTS_DIR` at it.

If you leave that mount out, everything else works exactly the same and the app
says why the create button is disabled.

## "No IP address pools available"

```
could not find an available, non-overlapping IPv4 address pool
among the defaults to assign to the network
```

This is the most common error on a NAS with many projects, and it has nothing to
do with this app: it happens to any stack trying to start.

**Why it happens.** Each Compose project creates its own network, and Docker
hands them out from limited ranges: `172.17.0.0/12` carved into `/16` (16
networks) and `192.168.0.0/16` into `/20` (16 more). A dozen-odd projects exhaust
them. On top of that, `docker compose down` **leaves the network behind**, so
orphan networks from projects that no longer exist pile up.

### Immediate fix

```bash
docker network prune -f
```

Deletes the networks no container is using. In most cases that is enough, because
nearly all the accumulated ones are orphans.

To see how many there are and which range each takes:

```bash
docker network ls | wc -l
docker network ls --format '{{.Name}}' | while read -r n; do
  printf '%-40s %s\n' "$n" "$(docker network inspect "$n" \
    --format '{{range .IPAM.Config}}{{.Subnet}} {{end}}')"
done
```

### Permanent fix

Widen the ranges Docker hands out. On DSM, edit
`/var/packages/ContainerManager/etc/dockerd.json` (over SSH as root) and add:

```json
{
  "default-address-pools": [
    { "base": "10.200.0.0/16", "size": 24 }
  ]
}
```

That gives 256 networks instead of 32. Restart Container Manager afterwards.

Pick a base that does **not** clash with your LAN or your VPN: if your home
network is `192.168.1.0/24`, do not use `192.168.0.0/16` as the base or you will
lose access to the NAS from some machines.

### Why the example compose uses `network_mode: bridge`

ContainerUpdater does not need a network of its own: it talks to Docker over the
socket, which is a file, and only needs outbound internet to query the
registries. Using the bridge network that already exists avoids burning one of
those scarce ranges. If you would rather isolate it, drop that line and Compose
will create its network.

## Old kernels and cgroup v1

Many Synology models ship old kernels with cgroup v1, where:

- `online_cpus` does not exist in the stats; you have to use
  `percpu_usage.length`.
- The memory cache is called `total_inactive_file` instead of `inactive_file`.

The app tries both, so it works either way with nothing to configure.

## Drive hibernation

If you have hibernation on, any filesystem read wakes the drives. That is why:

- The default check interval is **6 hours**, not one hour.
- Disk usage is measured every 5 minutes, separately from the CPU sampling.
- Live metrics are not written to the database unless you turn on history by
  hand.

## DSM reverse proxy

If you publish the app through the DSM reverse proxy, bear in mind its nginx
**buffers** responses by default, which cuts off the live event stream. The app
sends `X-Accel-Buffering: no` to turn that off, plus a heartbeat every 15 seconds
so no intermediary closes the connection for being idle.

If you use HTTPS through the proxy, turn on `CU_SECURE_COOKIES=1`. On a plain
HTTP LAN **do not turn it on**: the `Secure` cookie would not be sent and sign-in
would appear to do nothing.

## NAS metrics that are missing

Drive temperatures, SMART status and RAID health are **not** in `/proc`: they
live in the DSM API (`webapi/entry.cgi`) and need DSM credentials. They are out
of scope for this version. The app reports them as unavailable rather than
showing an invented figure.

## Permissions

The example compose uses `user: "0:0"`. The Docker socket already grants
privileges equivalent to root on the NAS, so running as root inside the container
makes nothing worse and avoids a whole class of incidents.

If you would rather not, find the GID of the socket's group and use `group_add`:

```bash
stat -c %g /var/run/docker.sock
```

```yaml
user: "1026:100"
group_add:
  - "<whatever GID the command returned>"
```

That GID varies between models and DSM versions, and changes after some updates,
so keep it in mind if one day the app stops seeing the containers.

## Updating the app itself

You can, from the Images screen: it launches a helper container that recreates
it, because the process itself would die halfway. There are about 30 seconds
without a panel, and the detail of what happened goes to
`/data/self-update.log`.

If something goes wrong and the panel does not come back:

```bash
# The helper log says exactly which step failed
cat /volume1/docker/container-updater/data/self-update.log

# Is there a copy of the previous container left?
docker ps -a | grep container-updater

# If a container-updater__cu_old_... exists, start it:
docker rename container-updater__cu_old_XXXX container-updater
docker start container-updater
```

You can also update it by hand from Container Manager, which is still the safest
route: stop the project, change the image tag in the `docker-compose.yml` and
rebuild. Your data lives in `/volume1/docker/container-updater/data` and is never
touched.

**With Compose there is no automatic rollback.** Compose deletes the previous
container, so if the new version fails to start you have to fix it from Container
Manager. The interface warns you before you confirm.
