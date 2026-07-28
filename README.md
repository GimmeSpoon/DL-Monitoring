# Monitor your servers at a sight!

This server shows your GPU servers' status on a single dashboard: every GPU
(utilization, memory, temperature, power, fan) plus total resources per server —
CPU, RAM, and network throughput. A Storage tab breaks down each server's
filesystems (size/used/free) and which account consumes how much. It also keeps history (charts),
a server event log, and a GPU usage log (who used which GPU when), all behind a
shared-password login.

### Pros

* Based on SSH connection, so you don't have to install anything on your GPU
  servers. (except NVIDIA driver and CUDA)
* Badass looking HTML pages. It will motivate your will of experiments.
* History charts, event log, and per-user GPU usage log stored in SQLite
  (no database server needed — uses Node's built-in `node:sqlite`).
* Easy to use.

### Cons

* Only supports NVIDIA GPUs.
* Not useful for massive amounts of servers.
* Server auth is via SSH keys; if you use ssh-agent (rather than a key file),
  the agent must be running and re-loaded after each reboot.

## Pages

| Page | What it shows |
|---|---|
| `/` | Live dashboard: per-server SYSTEM row (CPU %, RAM, load, network) + per-GPU gauges, users, offline badges |
| `/storage.html` | Per-server filesystems (size/used/free) plus whatever `configs/storage.json` measures: per-account usage, per-container usage with the storage mounted into each one, and arbitrary paths |
| `/services.html` | Up/down of configured services (containers, tmux, supervisor, systemd, ports, HTTP, custom) grouped by label; independent of the monitored servers |
| `/history.html` | Charts over 1h-30d: CPU, RAM, network, GPU util/memory/temperature, disk usage |
| `/logs.html` | EVENTS tab (connections, logins, errors, storage scans) and GPU USAGE tab (user sessions per GPU) |

## Quickstart

Requires **Node.js >= 24** on the monitoring server (meaning not one of the
GPU servers). On an older Node (>= 14) that lacks the built-in `node:sqlite`,
install the fallback driver instead:

```bash
npm install better-sqlite3     # Node 18/20
npm install better-sqlite3@8   # Node 14/16
```

1. Clone and install:

```bash
git clone https://github.com/GimmeSpoon/DL-Monitoring
cd DL-Monitoring
npm install
```

2. Copy the example and edit it for your GPU servers (usernames may differ per
   host — no shared password needed; add an optional `"privateKey"` to any
   server that needs a different key than your default). All config lives in
   `configs/`:

```bash
cp configs/servers.example.json configs/servers.json
```

```json
{
  "servers": [
    { "name": "server-a", "addr": "10.0.0.2", "port": 22, "username": "alice" },
    { "name": "server-b", "addr": "gpu-b.example.com", "port": 2222, "username": "bob", "privateKey": "~/.ssh/gpu_b_key" }
  ]
}
```

Running the monitor **on** a GPU box and watching that same machine? Give that
entry `"local": true` and it runs the commands directly — no SSH, no key, no
`sshd` for that host. Local and remote entries can mix in one file:

```json
{
  "servers": [
    { "name": "this-box", "local": true },
    { "name": "server-b", "addr": "gpu-b.example.com", "port": 22, "username": "bob" }
  ]
}
```

3. Set the web login password (what you type in the browser):

```bash
npm run set-web-password -- <WEB_PASSWORD>
```

4. Give the monitor SSH access to your GPU servers. Put your public key in each
   server's `~/.ssh/authorized_keys` (for the `username` you set above), then
   provide the private key one of two ways:

   **ssh-agent** — good for hands-on runs:

   ```bash
   eval "$(ssh-agent -s)"
   ssh-add ~/.ssh/id_ed25519
   ```

   The agent is per-shell and does not survive a reboot — you re-run these two
   commands afterward, and `SSH_AUTH_SOCK` must be visible to whatever process
   runs the monitor.

   **key file** — best for an always-on service (nothing to redo after a reboot):

   ```bash
   export SSH_PRIVATE_KEY=~/.ssh/id_ed25519
   ```

   or set `"sshPrivateKey"` in `config.json`, or `"privateKey"` per server in
   `servers.json` (a per-server value wins over the default).

5. Start it:

```bash
npm start
```

Open `http://<monitoring-server>:51234`, log in, done.

## Development without GPU servers

To test real collection without a GPU box, add your own machine to
`configs/servers.json` (`"addr": "127.0.0.1"`, with a local `openssh-server` and
your key in `~/.ssh/authorized_keys`), or mark the entry `"local": true` to skip
SSH entirely; you get CPU/RAM/disk/network and an empty GPU list.

## Configuration

Every config file lives in `configs/` (all gitignored except the `*.example.json`
templates):

| File | What it configures |
|---|---|
| `configs/config.json` | Web password hash, session secret, listen host/port, retention |
| `configs/servers.json` | The GPU servers to monitor (the 1s poll) |
| `configs/services.json` | Service up/down checks (`/services.html`) |
| `configs/storage.json` | Storage scans (`/storage.html`) |

A file left in the repo root, where these used to live, is still read when
`configs/` doesn't have it — upgrading moves nothing.

* **Listen host / port** (default `0.0.0.0:51234`). Set them in `config.json`,
  or via the `HOST` / `PORT` environment variables (env wins):

```json
{ "host": "127.0.0.1", "port": 8080 }
```

```bash
HOST=127.0.0.1 PORT=8080 npm start
```

  Bind to `127.0.0.1` if you front the dashboard with a reverse proxy and don't
  want the port reachable from outside the box.

* `config.json` (auto-created, gitignored) also holds the web password hash and
  session secret. Optional retention overrides (days):

```json
{ "retention": { "metricsDays": 30, "eventsDays": 90, "usageDays": 365, "storageDays": 90 } }
```

* **Storage** (the `/storage.html` tab) is measured by a slow background scan —
  never in the 1s poll, since a `du` walk is I/O-heavy. It is configured in
  `configs/storage.json` (see `configs/storage.example.json`), which, like
  `services.json`, has **its own SSH connections**: a storage target may live on
  a box nobody monitors, and container sizes usually need a host-level account:

```json
{
  "connections": {
    "gpu-1-host": { "addr": "10.0.0.2", "port": 22, "username": "hostadmin" },
    "local": { "local": true }
  },
  "targets": [
    { "scope": "server-a", "connection": "gpu-1-host", "type": "accounts", "roots": ["/home"], "sudo": true },
    { "scope": "server-a", "connection": "gpu-1-host", "type": "containers", "sudo": true, "everyHours": 2 },
    { "scope": "server-a", "connection": "gpu-1-host", "type": "paths", "label": "Datasets", "paths": ["/data/datasets"] }
  ]
}
```

  Each target measures one thing on one connection and files its results under a
  `scope` — the name it appears under in the Storage page's server dropdown (use
  the monitored server's name to have it share that server's filesystem panel;
  it defaults to the connection name). Target types:

  | `type` | Measures | Options |
  |---|---|---|
  | `accounts` | One entry per account: filesystem quotas (`repquota`), falling back to `du` of `<root>/*` | `roots`, `strategy` (`auto`/`quota`/`du`) |
  | `containers` | One entry per container, expandable to the storage mounted into it | `engine` (`docker`/`podman`), `layers`, `excludeMounts` |
  | `paths` | `du -sb` of explicit paths | `paths` |
  | `command` | Any command printing `<bytes>\t<label>` lines — the escape hatch | `command` |

  Every target also takes `"label"` (shown in the UI), `"sudo": true` (prefix the
  privileged command with `sudo -n`), and `"everyHours"` to override the global
  scan interval — so a cheap container listing can run hourly while a `du` walk
  stays at 6h. Each target's last run, duration, entry count and error are shown
  in the page's **Scan targets** panel, and a **Scan now** button forces a pass.

  `containers` measures two layers, both on by default via
  `"layers": ["writable", "mounts"]`:

  * `writable` — the container's writable layer and virtual size, from
    `docker ps -s` (one cheap command).
  * `mounts` — `du -sb` of the host source behind every mount, so a container's
    volumes *and* bind mounts are sized and listed with their in-container
    destination. This is the `du` cost; drop it from `layers` to keep the target
    instant. Plumbing mounts (`/etc`, `/proc`, `/run`, …) are skipped —
    override with `"excludeMounts"`. A source mounted into two containers is
    charged to both and flagged `shared`.

  Sizing *other* users' data (or talking to the docker socket) requires the
  connection's account to have access: set `"sudo": true` on the target (needs
  passwordless `sudo`) or use a privileged account. Without it, only
  world-readable data is counted.

  With **no `configs/storage.json`**, the pre-v2 behaviour applies: one
  `accounts` target per monitored server, over the collector's own connections,
  configured in `config.json` as
  `{ "storageRoots": ["/home"], "storageScanSudo": false, "storageScanHours": 6 }`.

* **Services** (the `/services.html` tab) are configured in
  `configs/services.json` (gitignored; see `configs/services.example.json`),
  which is **independent of the
  monitored servers** — a service may live in a container on a monitored host, on
  another box, or locally. The file has its own SSH connections (so you can check
  services as a host-level account even if monitoring runs as a container account):

```json
{
  "connections": {
    "gpu-1-host": { "addr": "10.0.0.2", "port": 22, "username": "hostadmin", "privateKey": "~/.ssh/host_key" },
    "local": { "local": true }
  },
  "services": [
    { "name": "Inference API", "group": "gpu-1", "connection": "gpu-1-host", "type": "container", "container": "infer-api" },
    { "name": "Nginx", "group": "edge", "connection": "local", "type": "systemd", "unit": "nginx" }
  ]
}
```

  Each service has a `type` (`container` / `tmux` / `supervisor` / `systemd` /
  `port` / `http` / `command`) plus its fields, a `connection` (name ref), and an
  optional `group` label used only for UI grouping. To list **every** container on
  a connection without naming each one, add a discovery entry
  `{ "type": "containers", "connection": "<conn>", "group": "<label>" }` — it runs
  `docker ps -a` each cycle and shows one row per container (running → up, stopped
  → down, health in the detail), along with the image, published ports, mount
  sources (volume names / host paths), and launch command, adding/removing rows
  as containers come and go
  (optional `"engine": "podman"` and `"sudo": true`). Modifiers on any service:
  `"sudo": true` (prefix the probe with `sudo -n`), `"container": "<name>"` (run a
  `command`/`port`/`http` probe *inside* that container via `docker exec`), and
  `"user": "<u>"` for a tmux session owner. Checks run every 20s (override with
  `"serviceCheckSeconds"` in `config.json`); up→down / down→up transitions are
  logged to the Events tab. Absent `services.json` ⇒ the tab is empty and nothing
  is checked.

  Permissions: probing other users' docker/tmux/supervisor needs the connection
  account to have the rights — the docker group or `sudo` for docker; the tmux
  socket belongs to the session owner (use `user:`/`sudo:`); supervisorctl socket
  access; `systemctl is-active` works unprivileged for system units. `port` needs
  `bash` + `timeout`, `http` needs `curl`.

* Poll/flush intervals: `lib/config.js`.
* Metrics are aggregated to one sample per minute in `data/monitor.db`;
  old rows are pruned hourly per the retention settings.

## Tests

```bash
npm test
```

## Notes

* `nvidia-smi` is not backwards compatible, so the csv query in
  `lib/collector.js` may need updates after major driver updates.
* `/kill` (pause polling) and `/revive` (resume) still exist, now behind
  the login, also as `POST /api/collector/stop` / `start`.
