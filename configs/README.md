# Configuration guide

Everything the monitor reads lives in this directory.

| File | Configures | Missing? |
|---|---|---|
| `config.json` | Web password, session secret, listen address, SSH default key, retention | Auto-created on first run |
| `servers.json` | The GPU servers to monitor (the 1s poll, dashboard, history) | **Fatal** — the server won't start |
| `services.json` | Service up/down checks (`/services.html`) | Tab is empty, nothing checked |
| `storage.json` | Storage scans (`/storage.html`) | Falls back to the legacy per-server account scan |

Each `*.example.json` here is a working template — copy it, drop the `.example`:

```bash
cp configs/servers.example.json configs/servers.json
```

Only the examples and this file are tracked by git; your real configs are
ignored (they hold hostnames, usernames, and a password hash).

### Where files are looked up

A config left in the repo root, where these used to live, is still read when
this directory doesn't have it. So an upgrade moves nothing, and you can migrate
one file at a time. `configs/` wins when both exist.

### How a bad file behaves

The three feature configs are deliberately not equally strict:

* `servers.json` — invalid JSON or a missing file **throws at startup**. It is
  the whole point of the process; failing loudly beats monitoring nothing.
* `services.json` / `storage.json` — a missing, blank, or invalid file logs one
  line and **disables just that feature**. A typo in a service definition must
  never take monitoring down with it.
* `config.json` — invalid JSON **throws** rather than being reset, so a bad edit
  can't silently wipe your web password and session secret.

### Applying an edit

`services.json` and `storage.json` reload at runtime: press **Reload config** on
either the Services or the Storage tab (both call `POST /api/config/reload`, and
both files are re-read together). The old checker and scanner are stopped, their
SSH pools disposed, and fresh ones built from disk — so added, changed, and
removed entries all take effect, and a scan runs a couple of seconds later. A
pass already in flight is allowed to finish. The reload is logged as a
`config_reload` event.

Nothing is watched automatically. A file watcher would fire on the half-written
file an editor leaves mid-save, so the trigger is deliberate.

`servers.json` and `config.json` still need a restart — the collector holds live
per-server poll state, and the listening socket and password hash are bound at
startup.

---

## config.json

Auto-created on first run with a random `sessionSecret`. Everything else is
optional.

```json
{
  "sessionSecret": "…64 hex chars, generated for you…",
  "webPasswordHash": "scrypt$…",
  "host": "127.0.0.1",
  "port": 8080,
  "sshPrivateKey": "~/.ssh/id_ed25519",
  "retention": { "metricsDays": 30, "eventsDays": 90, "usageDays": 365, "storageDays": 90 },
  "serviceCheckSeconds": 20,
  "storageScanHours": 6
}
```

| Key | Default | Notes |
|---|---|---|
| `sessionSecret` | generated | Signs login cookies. Changing it logs everyone out. |
| `webPasswordHash` | — | Set it with `npm run set-web-password -- <password>`, never by hand. Startup aborts without it. |
| `host` | all interfaces | Bind `127.0.0.1` when a reverse proxy fronts the dashboard. |
| `port` | `51234` | |
| `sshPrivateKey` | — | Default key for every SSH connection in all three configs. |
| `retention` | see above | Days kept per table. Pruned hourly. Partial objects are fine — unlisted keys keep their default. |
| `serviceCheckSeconds` | `20` | How often services are probed. |
| `storageScanHours` | `6` | Default storage scan interval; a target can override it. |

`HOST` / `PORT` environment variables **override** `config.json`. The SSH key
goes the other way: `config.json`'s `sshPrivateKey` **beats** `SSH_PRIVATE_KEY`.

### SSH authentication

Resolved per connection, first match wins:

1. `privateKey` on that server/connection entry
2. `sshPrivateKey` in `config.json`, else the `SSH_PRIVATE_KEY` env var
3. the `ssh-agent` at `SSH_AUTH_SOCK`

`~` is expanded in every key path. Entries marked `"local": true` skip all of
this — the commands run directly on this host. Startup aborts if a remote server
has no key and no agent.

---

## servers.json

The machines shown on the dashboard and charted in History. Polled once a
second over one persistent SSH connection each.

```json
{
  "servers": [
    { "name": "server-a", "addr": "10.0.0.2", "port": 22, "username": "alice" },
    { "name": "server-b", "addr": "gpu-b.example.com", "port": 2222, "username": "bob", "privateKey": "~/.ssh/gpu_b_key" },
    { "name": "this-box", "local": true }
  ]
}
```

| Field | Required | Notes |
|---|---|---|
| `name` | yes | Display name and the key for every stored sample. Renaming starts a fresh history. |
| `addr` | unless `local` | Hostname or IP. |
| `port` | unless `local` | |
| `username` | unless `local` | May differ per host; no shared account needed. |
| `privateKey` | no | Overrides the default key for this server only. |
| `local` | no | Run the commands here instead of over SSH — no key, no `sshd`. Mixes freely with remote entries. |

Only NVIDIA GPUs are read (`nvidia-smi`); a box without them still reports
CPU, RAM, disk, and network. A server that drops is retried every 10s and shows
an offline badge meanwhile.

---

## services.json

Up/down checks, **independent of `servers.json`**: a service may run in a
container on a monitored host, on a box nobody monitors, or locally. Hence its
own `connections` block — you can probe as a host-level account even when
monitoring runs as someone else.

```json
{
  "connections": {
    "gpu-1-host": { "addr": "10.0.0.2", "port": 22, "username": "hostadmin", "privateKey": "~/.ssh/host_key" },
    "local": { "local": true }
  },
  "services": [
    { "name": "Inference API", "group": "gpu-1", "connection": "gpu-1-host", "type": "container", "container": "infer-api" },
    { "group": "gpu-1", "connection": "gpu-1-host", "type": "containers", "sudo": true },
    { "name": "Nginx", "group": "edge", "connection": "local", "type": "systemd", "unit": "nginx" }
  ]
}
```

Every check is a shell expression whose **exit code** decides up (0) or down;
its output becomes the detail text. Status is `unknown` when the connection is
unreachable or the batch times out. All of a connection's probes are sent in one
round-trip. Transitions are written to the Events tab; nothing is persisted.

### Types

| `type` | Fields | Checks |
|---|---|---|
| `systemd` | `unit` | `systemctl is-active` |
| `container` | `container` | `docker inspect` state, health included in the detail |
| `supervisor` | `program`, opt. `config`, `serverurl` | `supervisorctl status` is `RUNNING`. Pass `config`/`serverurl` when a bare shell would resolve the wrong supervisord. |
| `tmux` | `session`, opt. `user` | `tmux has-session`. `user` runs it as that session's owner. |
| `port` | `port`, opt. `host` | TCP connect, 3s timeout. Host defaults to `127.0.0.1`. |
| `http` | `url` | `curl`, 5s timeout, 2xx/3xx is up. Detail is the status code. |
| `command` | `command` | Anything you like; exit 0 is up. |
| `containers` | opt. `engine`, `sudo` | **Discovery**: `docker ps -a` each cycle, one row per container, added and removed as containers come and go. Shows image, published ports, mount sources, and launch command. `engine` may be `podman`. |

### Fields on any service

| Field | Notes |
|---|---|
| `name` | Row label. Not used by `containers`, which names rows after the containers it finds. |
| `group` | UI grouping only. `containers` defaults to `containers`. |
| `connection` | Name from the `connections` block. Defaults to `default`. |
| `sudo` | Prefix the privileged binary with `sudo -n`. Injected next to that binary, not around the whole expression, so a tight `NOPASSWD: /usr/bin/supervisorctl` rule is enough. |
| `container` | On a `command` / `port` / `http` check, run the probe **inside** that container via `docker exec`. |

---

## storage.json

Storage measurement, same shape and same independence as `services.json`. Scans
are slow by design — never in the 1s poll, since `du` is I/O-heavy.

```json
{
  "connections": {
    "gpu-1-host": { "addr": "10.0.0.2", "port": 22, "username": "hostadmin", "privateKey": "~/.ssh/host_key" },
    "local": { "local": true }
  },
  "targets": [
    { "scope": "server-a", "connection": "gpu-1-host", "type": "accounts", "roots": ["/home"], "sudo": true },
    { "scope": "server-a", "connection": "gpu-1-host", "type": "containers", "sudo": true, "everyHours": 2 },
    { "scope": "server-a", "connection": "gpu-1-host", "type": "paths", "label": "Datasets", "paths": ["/data/datasets", "/data/models"] },
    { "scope": "local", "connection": "local", "type": "command", "label": "Model cache", "command": "du -sb ~/.cache/huggingface" }
  ]
}
```

Each target measures one thing on one connection.

### Types

| `type` | Produces | Own fields |
|---|---|---|
| `accounts` | One row per account | `roots` (default `["/home"]`), `strategy` |
| `containers` | One row per container, expandable to the storage mounted into it | `engine`, `layers`, `excludeMounts` |
| `paths` | One row per path | `paths` |
| `command` | One row per output line | `command` |

`accounts` tries filesystem quotas first (`repquota` — instant and exact, but
only if quotas are enabled and readable) and falls back to `du` of `<root>/*`,
where each top-level directory counts as one account. Pin one method with
`"strategy": "quota"` or `"du"`; the default is `"auto"`.

`command` is the escape hatch: run anything that prints `<bytes>\t<label>` lines
— which is exactly what `du -sb` produces, so most one-off measurements are a
`du` with your own filters.

### Fields on any target

| Field | Default | Notes |
|---|---|---|
| `scope` | the connection name | Which entry in the Storage page's **Server** dropdown this target files under. Use a monitored server's name and it shares that server's Filesystems panel. |
| `label` | the type | Shown in the Scan targets panel. |
| `connection` | `default` | Name from the `connections` block. |
| `sudo` | `false` | Prefix `repquota` / `du` / the container engine with `sudo -n`. |
| `everyHours` | `storageScanHours` (6) | Per-target interval. A cheap container listing can run hourly while a `du` walk stays at 6h. |
| `exclude` | `[]` | Rows to drop. See below. |

### Excluding rows

Every row a target produces is discovered, not declared — whatever accounts the
host has, whatever containers are running, whatever is mounted into them. So
each target takes an `exclude` list to drop the ones you don't want:

```json
{ "type": "accounts", "roots": ["/home"], "exclude": ["root", "lost+found", "svc_*"] },
{ "type": "containers", "exclude": ["/srv/shared", "k8s_*", "node-exporter"] }
```

A pattern is one of three things:

| Pattern | Matches |
|---|---|
| `root` | that name exactly — `rootish` survives |
| `k8s_*` | glob; `*` matches any run of characters |
| `/srv/shared` | that path **and everything under it** — `/srv/shared/datasets` goes, `/srv/shared-old` stays |

What it is matched against depends on the row: an account name, a container
name, a path, a `command` label — and for a container mount, **either** its host
source or its in-container destination, so `/srv/shared` and `/mnt/shared` both
work.

Excluding a container drops its mounts with it. Excluding a mount removes it
from its container's total as well as from the list — and it happens *before*
the `du`, so an excluded volume costs nothing to skip.

**The shared-volume case.** One dataset volume mounted into eight containers is
`du`'d eight times and charged to all eight, so the section total counts it
eight times over. It is flagged `shared ×8` in the UI, but the honest fix is to
exclude it from the `containers` target and measure it once on its own:

```json
{ "type": "containers", "exclude": ["/data/datasets"] },
{ "type": "paths", "label": "Datasets", "paths": ["/data/datasets"] }
```

### Container layers

`containers` measures in two layers, both on by default:

```json
{ "type": "containers", "layers": ["writable", "mounts"], "excludeMounts": ["/etc", "/srv/shared"] }
```

* **`writable`** — the container's writable layer and virtual size, from
  `docker ps -s`. One command, no walking.
* **`mounts`** — `du -sb` of the host source behind every mount, so volumes
  *and* bind mounts are sized and listed against their in-container
  destination. This is the expensive half; drop it from `layers` to keep the
  target instant.

Plumbing mounts are skipped by default: `/proc`, `/sys`, `/dev`, `/run`,
`/var/run`, `/etc`. Setting `excludeMounts` **replaces** that list, so include
what you still want skipped — it exists to get one of those defaults back, not
to hide your own volumes; that is what `exclude` is for, and the two are
applied together. A source mounted into two containers is charged to both and
flagged `shared ×2` — there is no single owner to attribute it to.

### Reading other people's data

Sizing accounts you don't own, or talking to the docker socket, needs access:
set `"sudo": true` on the target (requires passwordless `sudo` for that
account) or point the connection at a privileged account. Without it only
world-readable data is counted, and the numbers quietly come out too low.

### Checking it works

The Storage page's **Scan targets** panel shows every target's last run,
duration, entry count, and error. A target that has been failing for days is
otherwise indistinguishable from one that found nothing. **Scan now** forces a
pass for the selected scope instead of waiting for the interval — it is the one
button that measures anything, and can take minutes. **Reload config** only
re-reads the JSON. Both report what they did in the line beside them.

### With no storage.json

The pre-v2 behaviour applies: one `accounts` target per monitored server, over
the collector's own SSH connections, configured by three keys in `config.json`:

```json
{ "storageRoots": ["/home"], "storageScanSudo": false, "storageScanHours": 6 }
```

Those three are ignored the moment `storage.json` exists — except
`storageScanHours`, which stays the default interval for targets without
`everyHours`.

---

## Recipes

**Watch a box you don't monitor.** Give `storage.json` (or `services.json`) a
connection to it and a target with its own `scope`. It appears in the dropdown
with no Filesystems panel, since nothing polls it.

**Find what filled the disk.** A `containers` target with both layers ranks
containers by total bytes; expanding one shows which mount holds them. Pair it
with an `accounts` target if home directories are also suspects.

**Keep a heavy scan from running often.** `"everyHours": 24` on the `du`-ish
target, and a separate light one (`layers: ["writable"]`) at `1`.

**Same host, two identities.** Define two connections to the same address with
different `username`s — the storage scan can run as root while monitoring stays
unprivileged.

## Troubleshooting

| Symptom | Cause |
|---|---|
| Startup aborts, "No web password set" | Run `npm run set-web-password -- <password>` |
| Startup aborts, "No SSH authentication for remote servers" | No agent and no key — see [SSH authentication](#ssh-authentication) |
| Services tab empty | No `services.json`, or it failed to parse (check the log for one line naming the file) |
| Storage account totals far too low | The scan account can't read other users' files — `"sudo": true` |
| Container target reports `command not found` | No docker on that connection, or `sudo -n` isn't permitted for it |
| A storage section is missing entirely | No target of that type for the selected scope — the page only draws sections something feeds |
| Edits did nothing | `services.json` / `storage.json` need **Reload config**; `servers.json` / `config.json` need a restart |
| A scan reports 0 entries and looks fine | It isn't fine — check the target's error. A scan that measures nothing *and* writes to stderr is reported as failed. |
