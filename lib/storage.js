// Storage scanner. Driven by configs/storage.json — its own SSH connections and a
// flat list of typed *targets*, mirroring how services.json drives the service
// checker. Runs on a slow schedule (default every 6h) and never in the 1s poll,
// because a du walk is I/O-heavy.
//
// Every target measures one thing on one connection and files its results under a
// `scope` — the entry it appears under in the Storage page's server dropdown.
// Target types:
//   accounts    filesystem quotas (repquota) or `du` of <root>/* — one entry per account
//   containers  per-container writable layer and/or `du` of each mount source
//   paths       `du -sb` of explicit paths
//   command     any command printing "<bytes>\t<label>" lines (the escape hatch)
//
// Every target takes an `exclude` list, since the rows come from whatever the
// host happens to have: system accounts, sidecar containers, and above all a
// shared volume that would otherwise be du'd once per container that mounts it.
//
// Each target keeps its own last-run/error/duration status so a silently failing
// scan is visible in the UI instead of just missing from the numbers.

const { splitSections } = require('./parser');

const GiB = 1024 ** 3;
const TICK_MS = 60000;
// -B1 reports *allocated* bytes. `du -b` would report apparent size, which one
// sparse file inflates to petabytes — and which disagrees with the blocks
// repquota counts, so the two account strategies would not be comparable.
const DU = 'du -sB1';
// container mounts that are plumbing rather than data; du'ing them only adds noise
const DEFAULT_EXCLUDE_MOUNTS = ['/proc', '/sys', '/dev', '/run', '/var/run', '/etc'];
const CONTAINER_LAYERS = ['writable', 'mounts'];

function sq(s){
	return `'` + String(s).replace(/'/g, `'\\''`) + `'`;
}

// A target's `exclude` list, compiled once. A pattern is an exact name, a glob
// if it contains `*`, or — for anything starting with `/` — a path prefix that
// covers everything under it (`/data` covers `/data/models`, not `/database`).
// The matcher takes several values because a container mount is worth excluding
// by either end: its host source or its in-container destination.
function makeMatcher(patterns){
	const tests = (patterns || []).map((p)=>{
		const s = String(p).trim();
		if(s.includes('*')){
			const re = new RegExp('^' + s.split('*').map((x)=>x.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');
			return (v)=>re.test(v);
		}
		if(s.startsWith('/')){
			const base = s.replace(/\/+$/, '');
			return (v)=>v === base || v.startsWith(base + '/');
		}
		return (v)=>v === s;
	});
	return (...vals)=>tests.length > 0 && vals.some((v)=>v && tests.some((f)=>f(v)));
}

// "<bytes>\t<name>" (du) -> {name, bytes}. Blank/garbage lines are dropped, and
// so is anything past 2^53: sqlite stores it happily but reading the row back
// throws, which would take the whole storage API down for one bad number.
function parseSized(lines){
	const out = [];
	for(const line of lines || []){
		const m = String(line).match(/^\s*(\d+)\s+(.+?)\s*$/);
		if(!m) continue;
		const bytes = Number(m[1]);
		if(bytes > Number.MAX_SAFE_INTEGER) continue;
		out.push({ name: m[2], bytes });
	}
	return out;
}

// docker prints sizes as "12.3GB (virtual 5.6GB)" — SI units, occasionally binary
const SIZE_UNITS = { b: 1, kb: 1e3, mb: 1e6, gb: 1e9, tb: 1e12, pb: 1e15, kib: 1024, mib: 1024 ** 2, gib: 1024 ** 3, tib: 1024 ** 4 };
function humanBytes(s){
	const m = String(s).trim().match(/^([\d.]+)\s*([a-zA-Z]*)/);
	if(!m) return 0;
	return Math.round(Number(m[1]) * (SIZE_UNITS[m[2].toLowerCase()] || 1));
}

// ---------------------------------------------------------------- accounts

// Q holds repquota's output; when quotas aren't enabled it's empty and we du.
// A per-command `sudo -n` prefix is applied when the toggle is on. du's stderr is
// deliberately *not* discarded: "sudo: a password is required" is the difference
// between "this account owns nothing" and "this scan never ran".
function accountsCommand({ roots, sudo, strategy }){
	const S = sudo ? 'sudo -n ' : '';
	const globs = roots.map((r)=>`"${r.replace(/\/+$/, '')}"/*`).join(' ');
	const du = `echo @@DU; ${S}${DU} ${globs}`;
	const quota = `echo @@QUOTA; ${S}repquota -a 2>/dev/null`;
	if(strategy === 'du') return du;
	if(strategy === 'quota') return quota;
	return `Q=$(${S}repquota -a 2>/dev/null); if [ -n "$Q" ]; then echo @@QUOTA; printf '%s\\n' "$Q"; else ${du}; fi`;
}

function parseAccounts(raw){
	const sec = splitSections(raw);
	const acc = {};
	let method = 'none';

	// repquota: "user  --  <blocks-used-KB>  <soft>  <hard>  <grace>  <inodes>..."
	// header rows lack the "[-+][-+]" flag column, so the regex skips them.
	for(const line of sec.QUOTA || []){
		const m = line.match(/^(\S+)\s+[-+][-+]\s+(\d+)/);
		if(!m || m[1] === 'User' || m[1] === 'Group') continue;
		method = 'quota';
		acc[m[1]] = (acc[m[1]] || 0) + Number(m[2]) * 1024; // KB blocks -> bytes
	}

	// du -sb: "<bytes>\t<path>"; account = the last path component
	if(method === 'none'){
		for(const r of parseSized(sec.DU)){
			const account = r.name.replace(/\/+$/, '').split('/').pop();
			if(!account) continue;
			method = 'du';
			acc[account] = (acc[account] || 0) + r.bytes;
		}
	}

	const entries = Object.entries(acc).map(([name, bytes])=>({ kind: 'account', name, bytes }));
	return { entries, method };
}

// -------------------------------------------------------------- containers

// One round-trip for the cheap docker metadata. `-s` (which makes docker compute
// every writable layer) is only asked for when that layer is actually wanted, and
// the inspect pass is skipped unless mounts are. Mount sizes need a second call:
// the paths to du aren't known until inspect has answered.
function containersCommand({ engine, sudo, layers }){
	const S = sudo ? 'sudo -n ' : '';
	const size = layers.includes('writable') ? ' -s' : '';
	const parts = [`echo @@PS; ${S}${engine} ps -a --no-trunc${size} --format '{{.Names}}|{{.Size}}|{{.Status}}|{{.Image}}' 2>&1`];
	if(layers.includes('mounts')){
		parts.push(`echo @@MOUNTS; ${S}${engine} inspect --format '{{.Name}}{{range .Mounts}}|{{.Type}};{{.Source}};{{.Destination}}{{end}}' $(${S}${engine} ps -aq 2>/dev/null) 2>/dev/null`);
	}
	return parts.join('; ');
}

function mountsCommand({ sources, sudo }){
	return `${sudo ? 'sudo -n ' : ''}${DU} ${sources.map(sq).join(' ')}`;
}

function parseContainers(raw){
	const sec = splitSections(raw);
	const byName = new Map();
	const get = (name)=>{
		if(!byName.has(name)) byName.set(name, { name, writable: 0, virtual: 0, status: '', image: '', mounts: [] });
		return byName.get(name);
	};

	for(const line of sec.PS || []){
		const p = line.split('|');
		const name = (p[0] || '').trim();
		if(!name || p.length < 2) continue; // stderr from a failed engine command
		const size = (p[1] || '').trim();
		const virt = size.match(/virtual\s+([\d.]+\s*\w+)/i);
		const c = get(name);
		c.writable = humanBytes(size);
		c.virtual = virt ? humanBytes(virt[1]) : 0;
		c.status = (p[2] || '').trim();
		c.image = (p[3] || '').trim();
	}

	// "/infer-api|bind;/data/models;/models|volume;/var/lib/docker/volumes/x/_data;/var/lib/x"
	for(const line of sec.MOUNTS || []){
		const p = line.split('|');
		const name = (p[0] || '').trim().replace(/^\//, ''); // inspect prefixes a slash
		if(!name) continue;
		const c = get(name);
		for(const spec of p.slice(1)){
			const [type, source, dest] = spec.split(';').map((s)=>(s || '').trim());
			if(!dest || !source) continue; // tmpfs has no host source
			c.mounts.push({ type, source, dest });
		}
	}

	// stdout that produced nothing parseable is the engine itself failing (no
	// binary, no socket permission) — surface its first line rather than "0 containers"
	const list = [...byName.values()];
	const noise = (sec.PS || []).filter((l)=>!l.includes('|'));
	return { containers: list, error: (!list.length && noise.length) ? noise[0].slice(0, 120) : null };
}

// container/mount entries from the docker metadata plus the du of each source.
// A source mounted into two containers is charged to both (and flagged `shared`),
// since there is no single owner to attribute it to.
function buildContainerEntries(containers, sizeBySource){
	const users = {};
	for(const c of containers) for(const m of c.mounts) users[m.source] = (users[m.source] || 0) + 1;

	const entries = [];
	for(const c of containers){
		let mounted = 0;
		for(const m of c.mounts){
			const bytes = sizeBySource[m.source];
			if(bytes == null) continue; // excluded, or du couldn't read it
			mounted += bytes;
			entries.push({ kind: 'mount', parent: c.name, name: m.dest, bytes, meta: { type: m.type, source: m.source, shared: users[m.source] } });
		}
		entries.push({
			kind: 'container', name: c.name, bytes: c.writable + mounted,
			meta: { writable: c.writable, virtual: c.virtual, mounted, mounts: c.mounts.length, status: c.status, image: c.image },
		});
	}
	return entries;
}

// ------------------------------------------------------------------ target

// Fill in defaults so the rest of the scanner never re-checks optional fields.
function normalize(def, i){
	const t = {
		...def,
		type: def.type,
		scope: def.scope || def.connection || 'default',
		connection: def.connection || 'default',
		sudo: !!def.sudo,
		label: def.label || def.type,
	};
	t.id = `${t.scope}/${t.type}#${i}`;
	t.exclude = Array.isArray(def.exclude) ? def.exclude : [];
	t.excluded = makeMatcher(t.exclude);
	if(t.type === 'accounts'){
		t.roots = (Array.isArray(def.roots) && def.roots.length) ? def.roots : ['/home'];
		t.strategy = def.strategy || 'auto';
	}
	if(t.type === 'containers'){
		t.engine = def.engine || 'docker';
		const want = Array.isArray(def.layers) ? def.layers : CONTAINER_LAYERS;
		t.layers = CONTAINER_LAYERS.filter((l)=>want.includes(l));
		if(!t.layers.length) t.layers = ['writable'];
		t.excludeMounts = Array.isArray(def.excludeMounts) ? def.excludeMounts : DEFAULT_EXCLUDE_MOUNTS;
		// the plumbing list and the user's own exclusions are one filter on mounts
		t.excludedMount = makeMatcher([...t.excludeMounts, ...t.exclude]);
	}
	if(t.type === 'paths') t.paths = Array.isArray(def.paths) ? def.paths : [];
	return t;
}

function createStorageScanner({ targets, db, onEvent, intervalMs, timeoutMs, firstDelayMs }){
	onEvent = onEvent || (()=>{});
	intervalMs = intervalMs || 6 * 3600 * 1000;
	timeoutMs = timeoutMs || 300000;
	firstDelayMs = firstDelayMs == null ? 20000 : firstDelayMs;

	const list = (targets || []).map((def, i)=>{
		const t = normalize(def, i);
		t.everyMs = def.everyHours ? def.everyHours * 3600 * 1000 : intervalMs;
		t.stat = { ts: null, ok: null, error: null, entries: 0, bytes: 0, ms: 0, method: null, next: null };
		return t;
	});

	let timer = null, first = null, running = false, scanning = false;

	// a hung du must not wedge the scanner; bound every command
	function exec(t, cmd){
		return new Promise((resolve, reject)=>{
			let done = false;
			const to = setTimeout(()=>{ if(!done){ done = true; reject(new Error('scan timed out')); } }, timeoutMs);
			t.pool.exec(t.connection, cmd).then(
				(r)=>{ if(!done){ done = true; clearTimeout(to); resolve(r); } },
				(e)=>{ if(!done){ done = true; clearTimeout(to); reject(e); } });
		});
	}

	async function runAccounts(t){
		const res = await exec(t, accountsCommand(t));
		const { entries, method } = parseAccounts(res.stdout || '');
		return { entries, method, stderr: res.stderr };
	}

	async function runPaths(t){
		if(!t.paths.length) return { entries: [] };
		const res = await exec(t, `${t.sudo ? 'sudo -n ' : ''}${DU} ${t.paths.map(sq).join(' ')}`);
		return { entries: parseSized(String(res.stdout || '').split('\n')).map((r)=>({ kind: 'path', name: r.name, bytes: r.bytes })), stderr: res.stderr };
	}

	async function runCommand(t){
		if(!t.command) throw new Error('target has no "command"');
		const res = await exec(t, t.command);
		return { entries: parseSized(String(res.stdout || '').split('\n')).map((r)=>({ kind: 'custom', name: r.name, bytes: r.bytes })), stderr: res.stderr };
	}

	async function runContainers(t){
		const res = await exec(t, containersCommand(t));
		const { containers: all, error } = parseContainers(res.stdout || '');
		if(error) throw new Error(`${t.engine}: ${error}`);

		// prune before the du, not after: the point of excluding a volume shared by
		// five containers is to stop paying to measure it, and a mount dropped
		// afterwards would still be sitting inside its container's total
		const containers = all.filter((c)=>!t.excluded(c.name));
		for(const c of containers) c.mounts = c.mounts.filter((m)=>m.source.startsWith('/') && !t.excludedMount(m.source, m.dest));

		const sizeBySource = {};
		let duErr = null;
		if(t.layers.includes('mounts')){
			const sources = [...new Set(containers.flatMap((c)=>c.mounts.map((m)=>m.source)))];
			if(sources.length){
				const du = await exec(t, mountsCommand({ sources, sudo: t.sudo }));
				for(const r of parseSized(String(du.stdout || '').split('\n'))) sizeBySource[r.name] = r.bytes;
				duErr = du.stderr;
			}
		}
		return { entries: buildContainerEntries(containers, sizeBySource), method: t.layers.join('+'), stderr: duErr };
	}

	const RUNNERS = { accounts: runAccounts, containers: runContainers, paths: runPaths, command: runCommand };

	async function scanTarget(t){
		const started = Date.now();
		const ts = Math.floor(started / 1000);
		t.stat.next = started + t.everyMs;

		let entries, method = null, stderr = null;
		try{
			const run = RUNNERS[t.type];
			if(!run) throw new Error(`unsupported target type "${t.type}"`);
			({ entries, method, stderr } = await run(t));
			// accounts/paths/command are filtered here; a containers target was
			// already pruned before its du, so this pass finds nothing left
			entries = entries.filter((e)=>!t.excluded(e.name));
			// nothing measured *and* the command complained: that is a failure
			// ("sudo: a password is required"), not an empty filesystem
			const first = String(stderr || '').split('\n').map((l)=>l.trim()).filter(Boolean)[0];
			if(!entries.length && first) throw new Error(first.slice(0, 120));
		}
		catch(err){
			const was = t.stat.ok;
			t.stat = { ...t.stat, ts, ok: false, error: err.message, ms: Date.now() - started };
			if(was !== false) onEvent('storage_fail', t.scope, `${t.label} on ${t.connection}: ${err.message}`); // once per outage
			return;
		}

		for(const e of entries){
			db.insertStorageEntry(ts, t.scope, e.kind, e.parent || '', e.name, e.bytes, e.meta ? JSON.stringify(e.meta) : null);
		}
		// a container's mounts are already counted inside its own total
		const bytes = entries.filter((e)=>e.kind !== 'mount').reduce((s, e)=>s + (e.bytes || 0), 0);
		t.stat = { ts, ok: true, error: null, entries: entries.length, bytes, ms: Date.now() - started, method, next: t.stat.next };
		onEvent('storage_scan', t.scope, `${t.label}${method ? ` (${method})` : ''}: ${entries.length} entries, ${(bytes / GiB).toFixed(1)} GiB`);
	}

	// one pass over every target that is due (or all of them, when forced).
	// Returns false when a pass was already running, so a forced scan can say it
	// didn't actually happen instead of reporting someone else's results.
	async function scanAll(force, scope){
		if(scanning) return false;
		scanning = true;
		try{
			const now = Date.now();
			for(const t of list){
				if(scope && t.scope !== scope) continue;
				if(!force && t.stat.next && now < t.stat.next) continue;
				await scanTarget(t);
			}
		}
		finally{ scanning = false; }
		return true;
	}

	function start(){
		if(running || !list.length) return;
		running = true;
		timer = setInterval(()=>scanAll(false), TICK_MS);
		first = setTimeout(()=>{ if(running) scanAll(true); }, firstDelayMs);
	}

	function stop(){
		running = false;
		clearInterval(timer);
		clearTimeout(first);
		timer = first = null;
	}

	return {
		start,
		stop,
		scanNow: (scope)=>scanAll(true, scope),
		scopes: ()=>[...new Set(list.map((t)=>t.scope))],
		// per-target health for the UI: a target that has been failing for days is
		// otherwise indistinguishable from one that simply found nothing
		status: (scope)=>list.filter((t)=>!scope || t.scope === scope).map((t)=>({
			id: t.id, scope: t.scope, type: t.type, label: t.label, connection: t.connection,
			every_hours: t.everyMs / 3600000, ...t.stat,
		})),
	};
}

module.exports = {
	createStorageScanner, normalize, makeMatcher,
	accountsCommand, parseAccounts,
	containersCommand, parseContainers, buildContainerEntries, humanBytes,
	parseSized,
};
