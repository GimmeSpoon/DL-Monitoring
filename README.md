# Monitor your servers at a sight!

This server shows your GPU servers' status on a single dashboard: every GPU
(utilization, memory, temperature, power, fan) plus total resources per server —
CPU, RAM, and disks. It also keeps history (charts), a server event log, and a
GPU usage log (who used which GPU when), all behind a shared-password login.

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
| `/` | Live dashboard: per-server SYSTEM row (CPU %, RAM, load, disks) + per-GPU gauges, users, offline badges |
| `/history.html` | Charts over 1h-30d: CPU, RAM, GPU util/memory/temperature, disk usage |
| `/logs.html` | EVENTS tab (connections, logins, errors) and GPU USAGE tab (user sessions per GPU) |

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

2. Make a `servers.json` file with your GPU servers (usernames may differ per
   host — no shared password needed):

```json
{
  "servers":[
    { "name" : "myserver",
      "addr" : "123.0.0.2",
      "port" : 22,
      "username" : "gusfring" },
    { "name" : "anotherserver",
      "addr" : "123.0.0.3",
      "port" : 22,
      "username" : "kidnamedfinger" }
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

## Mock mode (development without GPU servers)

```bash
npm run set-web-password -- test
npm start -- --mock
```

Serves two synthetic servers with wandering utilization, user churn, and
occasional connection drops — enough to exercise the dashboard, history,
and logs end to end. To test real collection without a GPU box, add your
own machine to `servers.json` (`"addr": "127.0.0.1"`, with a local
`openssh-server` and your key in `~/.ssh/authorized_keys`); you get
CPU/RAM/disk and an empty GPU list.

## Configuration

* `config.json` (auto-created, gitignored) holds the web password hash and
  session secret. Optional retention overrides (days):

```json
{ "retention": { "metricsDays": 30, "eventsDays": 90, "usageDays": 365 } }
```

* Port and poll/flush intervals: `lib/config.js`.
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
