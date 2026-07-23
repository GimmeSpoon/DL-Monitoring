// Service checker: watches a flat, independent list of services (each with its own
// connection + check type) and reports up/down. Runs on a slow interval (default
// 20s) over its own SSH pool — NOT the monitoring collector. Services are grouped
// by connection so all of a connection's probes run in one round-trip.
//
// Each probe is a shell expression whose *exit code* decides up (0) / down (else);
// its stdout becomes the detail text. Status is `unknown` when the connection is
// unreachable or the batch times out. A `containers` entry is special: instead of a
// fixed probe it runs `docker ps -a` and expands to one row per container. Status
// transitions (up/down/unknown) are logged as events; there is no DB persistence.

const CONTAINER_WRAP = new Set(['command', 'port', 'http']); // types checked *inside* a container

function squote(s){
	return `'` + String(s).replace(/'/g, `'\\''`) + `'`;
}

// The core test expression for a service type (exit 0 = up; stdout = detail).
function core(def){
	switch(def.type){
		case 'systemd':
			return `systemctl is-active ${def.unit}`;
		case 'container':
			return `s=$(docker inspect -f '{{.State.Status}}{{if .State.Health}} ({{.State.Health.Status}}){{end}}' ${def.container} 2>/dev/null); printf '%s' "$s"; case "$s" in running*) exit 0;; *) exit 1;; esac`;
		case 'supervisor':
			return `s=$(supervisorctl status ${def.program} 2>/dev/null); printf '%s' "$s"; printf '%s' "$s" | awk '{print $2}' | grep -qx RUNNING`;
		case 'tmux':
			return `${def.user ? `sudo -u ${def.user} ` : ''}tmux has-session -t ${def.session}`;
		case 'port':
			return `timeout 3 bash -c '(exec 3<>/dev/tcp/${def.host || '127.0.0.1'}/${def.port})'`;
		case 'http':
			return `code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 5 ${def.url} 2>/dev/null); printf '%s' "$code"; case "$code" in 2*|3*) exit 0;; *) exit 1;; esac`;
		case 'command':
			return def.command;
		default:
			return `echo 'unsupported type ${def.type}'; exit 1`;
	}
}

// Full probe with modifiers: run inside a container (docker exec) for the relevant
// types, then a sudo prefix if requested.
function buildProbe(def){
	let cmd = core(def);
	if(def.container && CONTAINER_WRAP.has(def.type)){
		cmd = `docker exec ${def.container} sh -c ${squote(cmd)}`;
	}
	if(def.sudo) cmd = `sudo -n ${cmd}`;
	return cmd;
}

// One command that probes every service in a connection group. Each service emits
// a single line `@@S <idx>|<rc>|<detail>`; joined with ';' so one probe failing
// doesn't abort the rest.
function buildBatch(services){
	return services.map((def, i)=>
		`out=$( ${buildProbe(def)} 2>&1 ); rc=$?; ` +
		`printf '@@S ${i}|%s|%s\\n' "$rc" "$(printf '%s' "$out" | tr '\\n' ' ' | cut -c1-80)"`
	).join(' ; ');
}

// Parse the batch output into { idx: { rc, detail } }.
function parseChecks(raw){
	const out = {};
	for(const line of String(raw).split('\n')){
		const m = line.match(/^@@S (\d+)\|(-?\d+)\|(.*)$/);
		if(m) out[Number(m[1])] = { rc: Number(m[2]), detail: m[3].trim() };
	}
	return out;
}

function createServiceChecker({ services, pool, onEvent, intervalMs, timeoutMs, firstDelayMs }){
	services = Array.isArray(services) ? services : [];
	onEvent = onEvent || (()=>{});
	timeoutMs = timeoutMs || 20000;
	firstDelayMs = firstDelayMs == null ? 8000 : firstDelayMs;
	let timer = null, first = null, running = false, checking = false;

	// explicit probes (batched per connection) vs. `containers` discovery entries
	// (each expands to one row per container at check time).
	const probeGroups = {};
	const discoveries = [];
	for(const def of services){
		if(def.type === 'containers'){ discoveries.push(def); continue; }
		const conn = def.connection || 'default';
		(probeGroups[conn] = probeGroups[conn] || []).push(def);
	}

	// current status per row, keyed internally: the service name for explicit
	// services, `disc:<conn>:<container>` for discovered ones. `prev` mirrors it
	// for transition detection.
	const latest = {};
	const prev = {};
	for(const def of services){
		if(def.type === 'containers') continue; // dynamic: seeded when first discovered
		latest[def.name] = { key: def.name, name: def.name, group: def.group || '', type: def.type, connection: def.connection || 'default', status: 'unknown', detail: '', checked_at: null };
	}

	// bound a hung probe/discovery so it can't wedge the checker
	function execTimeout(name, cmd){
		return new Promise((resolve, reject)=>{
			let done = false;
			const to = setTimeout(()=>{ if(!done){ done = true; reject(new Error('check timed out')); } }, timeoutMs);
			pool.exec(name, cmd).then(
				(r)=>{ if(!done){ done = true; clearTimeout(to); resolve(r); } },
				(e)=>{ if(!done){ done = true; clearTimeout(to); reject(e); } });
		});
	}

	// record a row's status and announce a transition (up/down/unknown -> event)
	function set(key, r){
		latest[key] = { key, name: r.name, group: r.group, type: r.type, connection: r.connection, status: r.status, detail: r.detail, checked_at: Math.floor(Date.now() / 1000) };
		const was = prev[key];
		prev[key] = r.status;
		if(was === undefined && r.status === 'unknown') return; // quiet startup 'unknown'
		if(was === r.status) return;
		const type = r.status === 'up' ? 'service_up' : (r.status === 'down' ? 'service_down' : 'service_fail');
		onEvent(type, r.group || null, `${r.name}: ${r.status}${r.detail ? ` (${r.detail})` : ''}`);
	}

	function row(def, status, detail){
		return { name: def.name, group: def.group || '', type: def.type, connection: def.connection || 'default', status, detail };
	}

	async function checkProbes(conn, list){
		let parsed;
		try{
			const res = await execTimeout(conn, buildBatch(list));
			parsed = parseChecks(res.stdout || '');
		}
		catch(err){
			for(const def of list) set(def.name, row(def, 'unknown', `unreachable: ${err.message}`));
			return;
		}
		list.forEach((def, i)=>{
			const r = parsed[i];
			if(!r){ set(def.name, row(def, 'unknown', 'no result')); return; }
			const status = r.rc === 0 ? 'up' : 'down';
			set(def.name, row(def, status, r.detail || (status === 'up' ? 'running' : 'not running')));
		});
	}

	// `docker ps -a` on a connection -> one row per container (running=up, else down)
	async function discover(entry){
		const conn = entry.connection || 'default';
		const engine = entry.engine || 'docker';
		const prefix = `disc:${conn}:`;
		const cmd = `${entry.sudo ? 'sudo -n ' : ''}${engine} ps -a --no-trunc --format '{{.Names}}|{{.Status}}'`;
		let res;
		try{ res = await execTimeout(conn, cmd); }
		catch(err){ markKnown(prefix, conn, 'unknown', `unreachable: ${err.message}`); return; }

		const lines = String(res.stdout || '').split('\n').map((l)=>l.trim()).filter(Boolean);
		if(!lines.length && String(res.stderr || '').trim()){
			// engine missing / errored: keep last-known rows but flag them unknown
			markKnown(prefix, conn, 'unknown', `${engine}: ${String(res.stderr).split('\n')[0].slice(0, 60)}`);
			return;
		}
		const seen = new Set();
		for(const line of lines){
			const bar = line.indexOf('|');
			const cname = (bar < 0 ? line : line.slice(0, bar)).trim();
			if(!cname) continue;
			const st = bar < 0 ? '' : line.slice(bar + 1).trim();
			const key = prefix + cname;
			seen.add(key);
			const up = /^Up\b/.test(st) && !/\(unhealthy\)/.test(st);
			set(key, { name: cname, group: entry.group || 'containers', type: 'container', connection: conn, status: up ? 'up' : 'down', detail: st || 'no status' });
		}
		// a real listing arrived: forget containers that no longer exist
		for(const k of Object.keys(latest)){
			if(k.startsWith(prefix) && !seen.has(k)){ delete latest[k]; delete prev[k]; }
		}
	}

	function markKnown(prefix, conn, status, detail){
		for(const k of Object.keys(latest)){
			if(k.startsWith(prefix)) set(k, { name: latest[k].name, group: latest[k].group, type: 'container', connection: conn, status, detail });
		}
	}

	async function checkAll(){
		if(checking) return;
		checking = true;
		try{
			for(const [conn, list] of Object.entries(probeGroups)) if(list.length) await checkProbes(conn, list);
			for(const entry of discoveries) await discover(entry);
		}
		finally{ checking = false; }
	}

	function start(){
		if(running || !services.length) return;
		running = true;
		timer = setInterval(checkAll, intervalMs);
		first = setTimeout(()=>{ if(running) checkAll(); }, firstDelayMs);
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
		checkNow: checkAll,
		all: ()=>Object.values(latest).map(({ key, ...e })=>({ ...e, online: pool.hasConn(e.connection) })),
	};
}

module.exports = { createServiceChecker, buildProbe, buildBatch, parseChecks };
