# Technical decisions

*[Español](DECISIONS.es.md)*

Why each choice, and what was ruled out. The repo records the "what"; this
records the "why", which is what you cannot work out by reading the code.

## Findings that shaped the design

Verified live against the real registries and the local Docker, not assumed.
Several of them contradict the documentation or what gets repeated around.

| Finding | Consequence |
|---|---|
| Manifest `HEAD`s on Docker Hub do **not** count against the quota | The hot detection path is free |
| The Docker Hub token is scoped **per repository** | Cache by `(host, repo, scope)`, not globally |
| `lscr.io` issues the challenge with `realm="https://ghcr.io/token"` | The realm has to be read from the header; hardcoding it breaks linuxserver.io |
| Public `quay.io` answers 200 **with no challenge** | The unauthenticated branch is needed |
| GHCR returns **403**, not 401, for a private or non-existent repository | Tell "credentials missing" apart from "does not exist" |
| `nginx:alpine` has **two** `RepoDigests` | The comparison is against a set, not a string |
| Podman returns an empty `precpu_stats` with `stream=false` | The standard CPU% formula yields rubbish |
| Three different Compose projects **all** called `docker` | The project key is `(name, directory)` |
| Podman assigns `RepoDigests` to locally built images | The "no digest means local" heuristic does not work |
| Docker Hub answers 401 the same for private and non-existent | Its public API is used instead, which does distinguish 404 |

## Cookie session, not JWT

The deciding reason is the metrics stream: `EventSource` does not accept headers,
so with a JWT the token would have to go in the query string and would end up in
the DSM proxy logs. With an `httpOnly` cookie it works with no extra effort, it
is immune to XSS exfiltration, and revoking is deleting a row.

JWT in `localStorage` was ruled out: exfiltrable by XSS and with no real
revocation short of keeping a blocklist, which is exactly the session table it
was meant to avoid.

## Argon2id via `@node-rs/argon2`

It publishes prebuilt binaries for `linux-arm64-musl`, `linux-arm64-gnu`,
`linux-x64-musl` and `linux-x64-gnu`. Zero compilation on both Alpine and Debian
and on both architectures that have to be covered.

The classic `argon2` package was ruled out: it uses node-gyp and would mean
carrying a toolchain in the final image or compiling under emulation. bcrypt was
ruled out: it silently truncates at 72 bytes and is far less memory-hard.

## Envelope encryption with `node:crypto`

A master key from the environment wraps a data key generated on first start.
Rotating the master key means re-wrapping one key, not re-encrypting every row.

The AAD binds each ciphertext to its row and key version: without it, copying the
blob from one registry to another in the database would decrypt the neighbour's
secret.

libsodium was ruled out: another native dependency to compile on arm64 in
exchange for nothing AES-256-GCM does not cover. `crypto.createCipher` was ruled
out, deprecated and with a derived IV. AES-CBC was ruled out, unauthenticated.

**Losing the key does not stop it starting.** The app enters degraded mode,
deletes nothing and warns. Deleting is always a manual action by the user. A
failed startup because a credential could not be decrypted would be a far worse
failure than the loss itself.

## SQLite with WAL

It allows reading while writing, which is the actual pattern: the scheduler
writes results while the interface queries the inventory. `synchronous=NORMAL`
rather than `FULL` because an fsync per transaction punishes the NAS disk and all
that is risked on a power cut is the last check.

**Live metrics do not go to disk.** Writing every few seconds per container wakes
the drives constantly to store data almost nobody looks at. Ring buffer in
memory, rolled up to disk only if the user turns on history.

## SSE, not WebSocket

One-way flow, the cookie travels on its own, the browser reconnects by itself,
and it gets through the DSM reverse proxy without configuring `Upgrade`, which is
a classic source of "works locally, not on the NAS".

Keeping `stats?stream=true` open per container was ruled out: thirty containers
would be thirty permanent connections and thirty messages a second, vastly more
than is needed to draw a chart.

## One sampler, and only while somebody is watching

Ten open tabs generate the same work as one. And with the tab hidden, the
interface closes the connection, at which point the server stops sampling
entirely. On a NAS that is the difference between an app that gets in the way and
one you do not notice.

## uPlot, not Recharts

uPlot draws on canvas: a thousand points are a thousand draw operations, not a
thousand DOM nodes. SVG-based libraries generate hundreds of nodes per chart and
with thirty containers a NAS browser crawls. 45 KB against considerably more.

## Our own `/proc` reader

`systeminformation` was ruled out: it reads **fixed** `/proc` paths, meaning the
container's namespace rather than the NAS's. It would return the container's own
memory and CPU while passing them off as the system's, which is worse than
showing nothing. It takes no prefix, so there is no way to point it at
`/host/proc`.

Our own reader is a few dozen lines, has no dependencies and tells the truth.

## croner

Zero dependencies, time zones and overlap protection out of the box. BullMQ and
Agenda were ruled out: they need Redis or MongoDB to schedule four tasks on a
NAS. `node-cron` was ruled out: no overlap protection.

## grammY with long polling

The NAS is behind NAT. A webhook would mean opening a port and holding a valid
certificate; long polling only makes outbound HTTPS.

`drop_pending_updates` at startup matters: after a NAS restart, Telegram has the
messages from while it was off queued up, and without this the bot would run an
`/update` from hours ago the moment it came back.

telegraf (irregular maintenance) and node-telegram-bot-api (old API, poor types)
were ruled out.

## HTML, not MarkdownV2, on Telegram

Image references contain `.`, `-`, `_` and `/`, and MarkdownV2 forces escaping
every one of those characters. It is a guaranteed source of broken messages. In
HTML there are only three characters to escape.

## Deduplication by digest

The key is `sha256(channel|type|reference|digest|chat)`. Because it includes the
digest, while `latest` points at the same image nothing is sent again, but as
soon as it points at a new one the notification goes out by itself. It meets both
requirements with a single mechanism.

The row is **reserved before sending** and deleted if the send fails. Sending
first and recording afterwards would lose the mark if the process died in between
and would notify twice.

## Nonces on the bot buttons

The `callback_data` carries a short-lived identifier held on the server, not the
action in the clear. Without this, an "Update now" button left in the chat
history could be pressed months later and fire an update nobody expects. On top
of that, Telegram caps `callback_data` at 64 bytes and an image reference goes
well past it.

## `--no-deps` by default

The request was to "restart the project", but in practice you almost never want
to take the stack database down to update the frontend. By default only the
affected service is recreated; recreating the whole project is available as an
explicit option and warns what it entails.

## Self-update through an external helper

A process cannot recreate its own container: stopping it kills it halfway and
leaves the container in an indeterminate state. The answer is to delegate to an
ephemeral container that survives the restart (verified: a container launched by
another stays alive even when the launcher disappears, because the daemon is what
manages them).

Three decisions inside this:

**The helper runs the OLD image.** It is the one already known to start. If it
used the new one and that image were broken, nobody would be left able to go
back.

**Everything checkable happens beforehand.** The pull, verifying the image really
exists and validating the YAML all happen while the app is still standing: if
something fails there, a normal error is returned and nothing has happened. The
helper is handed decisions already made, because the less it has to decide, the
less can go wrong when there is no panel left to look at.

**The log goes to `/data`, not stdout.** While the helper works there is no
interface, and when it finishes it deletes itself. A persistent file is the only
thing left to diagnose with.

What is **not** solved: with Compose there is no reliable rollback. Compose
deletes the previous container and going back would mean changing the tag in the
user's YAML. You are warned before confirming rather than discovering it on
failure. With direct recreation there is automatic restore, verified.

It is also not offered from Telegram: the panel goes down for a few seconds and
from a phone there would be no way to see what happened.

## `bookworm-slim`, not Alpine

`better-sqlite3` compiles from source, and builder and runtime have to share libc
or the `.node` will not load. glibc gives a more predictable build than musl in
exchange for a few MB.

Only the stage compiling native code is emulated under QEMU; the Vite and
TypeScript ones carry `--platform=$BUILDPLATFORM`, because they are the expensive
part and emulating them multiplies build time.

## `react-router-dom` pinned to 7.18.2

There is an open advisory about RSC mode, which this app does not use (purely
client-side router, no server actions). `npm audit` proposes dropping to 7.11.0,
but that version drags in **fourteen** old advisories instead of one. The current
version is the option with the least real exposure.

Revisit when they publish a forward fix.

## Recreating a service in two steps, not with `--force-recreate`

The "recreate" action runs:

```bash
docker compose rm -f -s <service>
docker compose up -d <service>
```

and not the apparently equivalent `docker compose up -d --force-recreate
<service>`. The difference is not stylistic:

- `--force-recreate` recreates **the service's dependencies too**.
- The two-step sequence only destroys the requested service. Its dependencies are
  left as they are and `up` only starts them if they were stopped.

In a stack where a service sits behind a VPN (`network_mode: service:vpn`) or
depends on a database, `--force-recreate` would take that VPN down and with it
the connectivity of everything hanging off it. The long sequence is what people
do by hand for a reason.

`--no-deps` was ruled out as an alternative: it avoids recreating the
dependencies, but it does not start them either if they were down, which is
exactly what you want when bringing a service up by hand.

## Service actions share a queue with the updates

Recreating, stopping or starting a service goes through the same queue as an
update, and lands in the same history. They are conceptually different
operations, but they share the two properties that matter: they cannot overlap on
the same project without corrupting its state, and it is worth being able to look
afterwards at what was done and with what output.

Keeping two independent queues would have allowed a recreate and an update to
collide, which is the failure the queue existed to prevent.

## Project operations also became queued jobs

Bringing a project up used to run Compose inside the HTTP request. It was the
same mistake already fixed for the updates: a large stack takes longer than the
browser or the DSM proxy will hold the connection, and meanwhile there was no way
to see how it was going. Now they share the queue, the history and the live
output with everything else.

## Reactive detection of local images

The "no `RepoDigests` means a local image" heuristic fails: Podman assigns them a
digest anyway, so they get queried against Docker Hub, where they do not exist,
and the user sees an "authentication required" that means nothing.

It is solved by **reacting to the result** rather than guessing: when the registry
confirms the repository does not exist, the image is marked as locally built and
left out of future checks. It corrects itself and the message explains what is
actually going on.

## Project creation writes to a separate folder

The recommended mount puts the projects folder read-only, because until then only
the YAML had to be read. Creating projects needs write access, and the obvious
move would have been to drop the `:ro`.

It goes in a **separate mount** for a specific reason: the risk of writing is not
symmetric. Reading the wrong file is harmless; overwriting the compose of a stack
in production is not. Confining writes to one subfolder means a bug in the
creation path cannot reach the stacks that already work, and the cost is one
extra line in the compose.

The consequence is that without that mount the feature is simply off. That is
deliberate too: silently falling back to writing wherever there happens to be
permission would be the worst of both.

## The `.env` is not encrypted on disk

Compose has to read it in the clear, and so does anything else that brings the
stack up over SSH or from Container Manager. Encrypting it on disk would mean
only this app could start the project, which trades a real capability for the
appearance of security.

What is done instead is what actually holds:

- `0600` permissions, so it is not readable by the rest of the system.
- Values whose key looks like it names a secret are masked in the interface, and
  revealing one is a separate, audited request for that single variable rather
  than a dump of the file.
- Each save archives the previous version encrypted in the database, with the
  same envelope as the registry credentials. A backup of a secret is still a
  secret.

Materialising the file only for the duration of the Compose run and deleting it
afterwards was considered and ruled out: it would break every use outside the
app, and a stack you cannot start over SSH is a trap for whoever inherits it.

## Any project can be edited, not only the ones created here

The first version only allowed editing what the app had created, on the argument
that overwriting a file somebody else wrote destroys trust. That argument does
not hold: on a personal NAS that "somebody else" is the user, and the app could
already do considerably more destructive things to those projects (`down`,
recreating services) than editing a text file.

The practical result was that the feature was useless to precisely the people who
needed it: on a real NAS every project was made by the user in Container Manager,
so the button was always disabled.

What decides now is what actually determines whether writing is possible:

1. The YAML is reachable from the container.
2. There is a single compose file. With several it is not clear which to edit,
   and picking one would be guessing about the user's configuration.
3. The folder is writable.

All three reasons travel to the interface, which says which one is failing rather
than leaving a disabled button saying nothing, which is exactly what it did
before.

### Consequence in the data model

`managed_projects.name` stopped being UNIQUE. While only projects created here
were recorded, with validated names, the constraint was fine; as soon as outside
ones come in, it would reject the second project called `docker`, which is a real
and documented case (ADR-004). Identity moved to the directory, and a
`created_here` column tells apart what was created here, which has to stay
visible even with no containers, from what has merely been edited.

For the same reason, files are addressed by **project key** rather than by name.
Addressing by name would have walked back into ADR-004 through another door.

## Quarantine lets through what it cannot date

Waiting before auto-updating requires knowing when a version was published. That
date is not always there, and when it is it is not always usable: reproducible
builds pin the config blob's `created` field to a constant, almost always the
Unix epoch. Taking it at face value would make a freshly published image look
fifty years old and quarantine would always let it through, which is exactly the
opposite of what was asked for.

Hence dates before the year 2000 are discarded, and for Docker Hub the
`last_updated` field of its own API is preferred, which is reliable.

That leaves the case of not being able to find out at all. **The update is let
through**, and the interface says so. The alternative (holding back indefinitely
whatever cannot be dated) would turn any registry that does not publish OCI
labels into an auto-update that does not work and nobody knows why. A setting
that sometimes fails to protect is worse than one that never protects only if it
keeps quiet about it; saying it out loud makes it the honest option.

## Rolling back marks the version you leave as ignored

Undoing an update and nothing else would last until the next check: the checker
would see a new version again and auto-update would reapply it, probably that
same night. The feature would be a trap.

So when rolling back, the digest being left behind goes into `ignored_digest`.
**That specific digest** is ignored, not the image: the next version published
will still be applied, which is what you want. It is the same mechanism already
used by the "ignore this version" button in the Telegram alerts.

### And why retagging is necessary

Rolling back pulls the old version by digest and gives it back its original tag
before recreating. Without that step it would not work with Compose, because the
project file names the tag (`image: something:latest`) and not the digest: while
the tag points at the new version, bringing the project up would fetch it again.

That retagging also forced a `skipPull` option into the recreator. The first
version retagged and then immediately recreated, and the recreator pulled that
same tag from the registry: it fetched the new version again and undid the
rollback. The container ended up on exactly the version you were trying to leave,
the job finished as "successful" and there was not a single error in the log. It
was found by running a real rollback; neither typechecking nor type-level tests
could see it.

## The watchdog alerts on transitions, not on situations

A container that goes down produces **one** alert, not one every five minutes for
as long as it stays down. That requires keeping state, which is what the
`container_watch` table is for. Deriving it from the notification history does
not work: that history is purged by retention, so the same container would stop
alerting or alert twice depending on the day.

Three decisions inside that table:

- **The key is the name, not the id.** Recreating a container (which is what any
  update does) changes the id entirely, so keying by id would make every update
  look like one container vanishing and another being born.
- **Exiting with code 0 does not alert.** That is a clean stop, almost always
  somebody stopping it on purpose. Alerting on that means alerting the user about
  what they themselves just did, which is the fastest way to get alerts switched
  off.
- **The updater mutes what it is about to touch.** During an update a container
  goes through stopped, removed and recreated. Without that mute, every
  successful update would fire a down alert.

## Volumes are not pruned in bulk

An orphaned image can be pulled again; the data in a volume cannot. That is why
the disk space screen lists unused volumes one by one, with their size and which
project they came from, and offers no "clean everything" button. `docker volume
prune` exists for anyone who wants that risk, and we do not need to hand it over
ready-made.

"Nobody is using it" does not mean "it is disposable" either: it can be precisely
the data of something stopped in March and wanted back in October.

### Two daemon calls are required

`/system/df` computes sizes but returns volumes **without** their labels;
`/volumes` carries the labels but no size. Verified live against Podman. Joining
them is mandatory in order to say which project each volume came from, which is
the fact that lets you decide whether it is disposable.

The join has a trap: `/system/df` returns `Labels: {}`, an empty object rather
than null, so a `??` keeps it and the real labels are never used. Nothing fails;
the field just comes out blank.

## The backup carries no secrets

No registry passwords, no second-factor secret, no passkeys. A file that gets
downloaded and ends up in a downloads folder, in an email or on a shared drive is
no place for those, and everything omitted takes minutes to set up again. What
actually costs time to redo, and is therefore the core of the backup, are the
per-image policies.

Registries are exported, without their secret, so you know which ones to
configure again: a list of what is missing is worth more than nothing.

**Telegram chats are exported but not restored.** Registering an authorised chat
from a file would bypass the single-use link code, which is not bureaucracy: it
is the proof that whoever asks for access controls that chat. If importing a JSON
were enough, anyone able to upload a backup would add themselves as an
administrator of the bot.

## The service worker is deliberately cowardly

It exists for one thing: so the app can be installed on a phone's home screen and
start without the browser chrome. It does not try to work offline, because a
panel that manages live containers is useless without its server.

Three rules that avoid the classic disasters:

1. **It never touches `/api/`.** That is where mutations and the metrics SSE
   stream live, and a worker intercepting an `EventSource` breaks it in ways that
   are very hard to debug.
2. **It only caches hash-named assets.** Their content never changes, so serving
   them from cache cannot hand back a stale version.
3. **HTML always goes to the network first.** Serving a cached index would point
   at assets that no longer exist after a deploy, leaving the app broken until a
   forced reload.

It is registered with `updateViaCache: 'none'` and with the version in the URL,
because the server serves static files as `immutable` for a year and the browser
compares the script byte by byte: with a fixed URL and identical content, it
would never update.

## Launch options apply to one run and are never stored

Profiles and extra environment variables are chosen when you press "start" or
"update", and they are not remembered. It would be easy to keep them on the
project, and it was tempting: you would set the `debug` profile once and forget.

The reason not to is that automatic updates would then inherit them. Weeks
later a nightly update would bring up a service nobody asked for, and the only
place recording why would be a checkbox in a dialog nobody remembers ticking.
What the project runs would stop matching what its compose file says, with no
way to tell from the file itself. A one-off decision belongs to the run that
made it.

The dialog is only offered for `up` and `update`, which are the two actions
where Compose creates containers. `start`, `stop`, `restart` and `down` work on
what already exists, so a profile or a variable would change nothing there.

**There is no free-form arguments field.** It was the obvious way to cover
everything and it was asked for explicitly, but that text ends up on the
`docker compose` command line, and there `--project-directory /etc` or
`--file /anything` redirect what the whole operation points at. The service
account behind that command reads and writes real stacks. So the flags are a
closed list of the ones that are useful and cannot redirect anything, and the
open space is the environment variables, which are data and not options.

Variable names are validated (`[A-Za-z_][A-Za-z0-9_]*`) and a reserved list is
rejected: `PATH`, `HOME`, `DOCKER_HOST`, `COMPOSE_FILE` and friends. Those are
exactly the ones that would change which daemon is contacted or which file is
read. As a second lock, the user's variables are spread **first** in the child
process environment, so the fixed ones always win even if some day one slips
through the filter.

**What gets logged is what actually got applied**, not what arrived. The job log
listed the raw names at first, so it claimed a `PATH` had been set that never
left the server. A log that lies about what ran is worse than no log, so
discarded profiles are not announced and rejected variables are reported as
ignored, with the reason. Values are never written: the log is stored and shown
on screen, and that is where somebody would put a password.

A shell variable is not a container variable. It feeds `${VAR}` substitution in
the compose file, which is what makes `TAG=3.19` work; it only reaches the
process inside the container if the service declares it under `environment`.
The dialog says so, because the alternative is people wondering why their
`API_KEY` never arrived.
