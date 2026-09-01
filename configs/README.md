# Configuration guide

Everything the monitor reads lives in this directory.

| File | Configures | Missing? |
|---|---|---|
| `config.json` | Web password, session secret, listen address, SSH default key, retention | Auto-created on first run |
| `servers.json` | The GPU servers to monitor (the 1s poll, dashboard, history) | **Fatal** — the server won't start |
| `services.json` | Service up/down checks (`/services.html`) | Tab is empty, nothing checked |
| `storage.json` | Storage scans (`/storage.html`) | Falls back to the legacy per-server account scan |
| `alarms.json` | Alarms and where to send them — Slack, any webhook (`/alarms.html`) | Nothing is alarmed, nothing is sent |

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
* `services.json` / `storage.json` / `alarms.json` — a missing, blank, or invalid
  file logs one line and **disables just that feature**. A typo in a service or
  alarm definition must never take monitoring down with it.
* `config.json` — invalid JSON **throws** rather than being reset, so a bad edit
  can't silently wipe your web password and session secret.

### Applying an edit

`services.json`, `storage.json` and `alarms.json` reload at runtime: press
**Reload config** on the Services, Storage or Alarms tab (all call
`POST /api/config/reload`, and all three files are re-read together). The old checker and scanner are stopped, their
SSH pools disposed, and fresh ones built from disk — so added, changed, and
removed entries all take effect, and a scan runs a couple of seconds later. A
pass already in flight is allowed to finish. The reload is logged as a
`config_reload` event.

Alarms additionally survive the swap: a rule that was already firing is carried
across the reload, so editing one rule doesn't re-announce every problem that was
already open.

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

## alarms.json

Optional. It answers two questions: **what is worth waking someone for**, and
**where does that message go**. Nothing is alarmed until a rule says so — an
empty or missing file means the feature is simply off.

```bash
cp configs/alarms.example.json configs/alarms.json
```

```json
{
  "enabled": true,
  "origin": "gpu-cluster",
  "channels": {
    "ops-slack": { "type": "slack", "urlEnv": "SLACK_WEBHOOK_URL", "channel": "#gpu-alerts" }
  },
  "defaults": { "channels": ["ops-slack"], "notifyResolve": true },
  "rules": [
    { "id": "server-offline", "name": "Server offline", "type": "metric",
      "metric": "server.offlineMinutes", "above": 5, "severity": "critical" },
    { "id": "service-down", "name": "Service down", "type": "event",
      "events": ["service_down", "service_fail"], "severity": "critical" }
  ]
}
```

### Channels

A channel is one delivery target. `type` decides the body shape; everything else
is per-service.

| Field | Meaning |
|---|---|
| `type` | `slack` (incoming webhook), `webhook` (raw JSON POST), `discord` |
| `url` | The webhook URL |
| `urlEnv` | Name of an env var holding the URL instead — keeps the secret out of the file |
| `channel`, `username`, `iconEmoji` | Slack overrides, sent only when set (a modern Slack app ignores them unless the webhook allows overrides) |
| `headers` | Extra request headers, e.g. `{"Authorization": "Bearer ..."}` for an internal endpoint |
| `minSeverity` | `info` (default), `warning`, `critical` — a paging channel takes only criticals while a chat channel takes everything |
| `enabled` | `false` parks a channel without deleting it |
| `timeoutMs` | Request timeout, default 10000 |

**Getting a Slack URL:** create an app at `api.slack.com/apps` → *Incoming
Webhooks* → *Add New Webhook to Workspace*, pick the channel, copy the
`https://hooks.slack.com/services/...` URL. That URL is a bearer credential —
anyone holding it can post to the channel. Prefer `urlEnv`:

```bash
export SLACK_WEBHOOK_URL='https://hooks.slack.com/services/T000/B000/xxxx'
```

The URL is never sent to the browser. The Alarms tab shows only whether a
channel is configured and where its URL came from.

For anything that isn't Slack or Discord, use `"type": "webhook"`: the alarm
object is POSTed as-is, so the receiver can route on `severity`, `ruleId`,
`server`, `value` and `threshold` rather than parsing prose.

### Rule types

Every rule needs `type`; `id` (or `name`) identifies it in the UI and in the
file. All four types share the fields in [Fields on any rule](#fields-on-any-rule).

**`event`** — matches the event log as it is written. Edge-triggered.

```json
{ "id": "service-down", "type": "event", "events": ["service_down", "service_fail"],
  "servers": ["gpu-*"], "match": "postgres", "severity": "critical" }
```

| Field | Meaning |
|---|---|
| `events` | Event types to fire on; `["*"]` matches every event |
| `resolveEvents` | Events that clear it. Defaults to the natural pair: `ssh_fail`/`ssh_disconnect` → `ssh_connect`, `service_down`/`service_fail` → `service_up`, `storage_fail` → `storage_scan` |
| `servers` | Filter on the event's server/group; exact names or globs |
| `match` | Case-insensitive regex the message must contain |

Alarmable event types: `ssh_connect`, `ssh_disconnect`, `ssh_fail`, `service_up`,
`service_down`, `service_fail`, `storage_scan`, `storage_fail`, `login_ok`,
`login_fail`, `kill`, `revive`, `config_reload`, `server_start`.

A rule whose events have no recovery pair (`login_fail`, `kill`) is a **one-shot
notice**: it announces, then stays quiet for `repeatMinutes` (default 5) so a
burst of failed logins is one message rather than fifty.

**`metric`** — evaluated against the live poll every `metricIntervalSeconds`
(default 30). Level-triggered.

```json
{ "id": "disk-nearly-full", "type": "metric", "metric": "disk.usedPct",
  "above": 90, "forMinutes": 5, "subjects": ["/", "/data"], "severity": "warning" }
```

| Field | Meaning |
|---|---|
| `metric` | One of the metrics below |
| `above` / `below` | The threshold. One of the two |
| `forMinutes` | Must hold this long before firing — how a one-second spike is kept out of Slack |
| `servers` | Which servers to watch (names or globs; default all) |
| `subjects` | Which rows within a server: mount paths for `disk.*`, `gpu0`/`gpu1` for `gpu.*` (`mounts` and `gpus` are accepted as aliases) |

| Metric | Unit | What it is |
|---|---|---|
| `server.offlineMinutes` | min | How long a server has been unreachable. **The one to start with** |
| `disk.usedPct` / `disk.freeGiB` | % / GiB | Per filesystem (`subject` is the mount) |
| `cpu.util` | % | CPU utilisation |
| `cpu.loadPerCore` | ratio | load1 ÷ cores — comparable across differently-sized boxes |
| `mem.usedPct` | % | RAM used |
| `net.rxMBps` / `net.txMBps` | MB/s | Network throughput |
| `gpu.temp` | C | GPU temperature (`subject` is `gpu0`, `gpu1`, …) |
| `gpu.util` | % | GPU utilisation |
| `gpu.memPct` / `gpu.memUsedGiB` | % / GiB | GPU memory |
| `gpu.power` | W | Power draw |
| `gpu.fan` | % | Fan speed |
| `gpu.procs` | count | Compute processes on the GPU — `"below": 1` means "nobody is using it" |
| `gpu.idleMinutes` | min | How long since a compute process was last seen on it |

An **offline server contributes only `server.offlineMinutes`**. The last reading
before it died proves nothing about the present, so it can neither fire nor clear
any other metric.

**`storage`** — checked against the latest storage scan every
`slowIntervalMinutes` (default 10).

```json
{ "id": "account-over-quota", "type": "storage", "kind": "account",
  "aboveGiB": 1000, "scopes": ["server-a"], "names": ["*"], "severity": "warning" }
```

`kind` is `account`, `container` or `path` (omit for all); `aboveGiB` is the
limit; `scopes` and `names` filter by scope and entry name.

**`gpu_session`** — open GPU sessions from the usage log, same slow interval.

```json
{ "id": "long-gpu-session", "type": "gpu_session", "longerThanHours": 48,
  "users": ["*"], "severity": "info", "notifyResolve": false }
```

### Fields on any rule

| Field | Default | Meaning |
|---|---|---|
| `id` | the `name` | Stable identifier — the UI toggle writes back to this rule |
| `name` | the `id` | What the message is titled |
| `enabled` | `true` | `false` parks the rule; the Alarms tab toggles this and saves it here |
| `severity` | `warning` | `info` / `warning` / `critical`. Sets the Slack colour and picks which channels take it |
| `channels` | `defaults.channels` | Which channels this rule delivers to. Empty means every channel |
| `forMinutes` | `0` | How long the condition must hold before firing |
| `clearMinutes` | `1` | How long it must be clear before resolving (anti-flap). A recovery *event* ignores this — it is a statement, not a sample |
| `repeatMinutes` | `0` | Re-send while still firing. `0` = announce once and stay quiet until it clears |
| `notifyResolve` | `true` | Whether a "resolved" message follows |

`defaults` sets any of these for every rule at once.

### What a message looks like

Firing and resolving are separate messages. The Slack `text` line carries the
whole point — severity, rule, server, row — because that is what a phone
notification shows; the coloured attachment carries the detail.

```
:rotating_light: [CRITICAL] Service down — web nginx
  Service down
  service_down: nginx: down (not running)
  Server: web    Where: nginx    For: 12m
```

### It notifies on the transition, not on the observation

This is the part that decides whether the channel stays readable. `ssh_fail`
repeats every 10 seconds while a box is down, and the metric pass runs every 30
seconds. Each rule keeps per-subject state, so:

* a firing alarm notifies **once**, and again only if `repeatMinutes` says so;
* one service recovering resolves **only that service**, not everything in the group;
* a subject that disappears (unmounted filesystem, deleted container) resolves as
  *no longer reported*, rather than firing forever;
* a delivery failure is logged as `alarm_error` and never stops the next channel,
  the next rule, or the monitoring itself.

### Runtime control

The Alarms tab (`/alarms.html`) is live, and everything on it applies without a
restart:

| Control | Effect | Durable? |
|---|---|---|
| Rule checkbox | Enable/disable one rule | **Yes** — written back to `alarms.json` |
| Snooze 1h (per rule) | Keeps evaluating, sends nothing | No — a snooze that outlived a restart would silence a rule after everyone forgot |
| Snooze all | Same, for every rule (a maintenance window) | No |
| Send test | Posts a test message to one channel | — |
| Reload config | Re-reads the file | — |

Alarm activity is in the event log under `alarm_fire`, `alarm_resolve`,
`alarm_error`, `alarm_muted`, `alarm_config` and `alarm_test`.

### Checking it works

1. Alarms tab → **Send test** next to the channel. A message should land in
   Slack within a second; failures print the HTTP status in the status line.
2. For a real end-to-end check, add a rule that is deliberately true — e.g.
   `disk.usedPct` `"above": 1` — press **Reload config**, watch it fire, then set
   the threshold back and reload again to watch it resolve.

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
| Edits did nothing | `services.json` / `storage.json` / `alarms.json` need **Reload config**; `servers.json` / `config.json` need a restart |
| Alarms tab says no rules | No `configs/alarms.json`, or it failed to parse (one line in the log names the file) |
| Test message fails with HTTP 403/404 | The Slack webhook URL is wrong, revoked, or the app was removed from the channel |
| Channel shows **missing** | `urlEnv` names an env var the service doesn't have — export it in the unit/shell that starts the monitor |
| An alarm never resolves | Its trigger has no recovery pair; give the rule an explicit `resolveEvents`, or use a `metric` rule, which clears itself |
| Too many messages | Raise `forMinutes` (spikes), set `repeatMinutes: 0` (repeats), or `notifyResolve: false` (recovery notices) |
| A scan reports 0 entries and looks fine | It isn't fine — check the target's error. A scan that measures nothing *and* writes to stderr is reported as failed. |
