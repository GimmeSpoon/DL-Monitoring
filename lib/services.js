// Service checker: watches a flat, independent list of services (each with its own
// connection + check type) and reports up/down. Runs on a slow interval (default
// 20s) over its own SSH pool — NOT the monitoring collector. Services are grouped
// by connection so all of a connection's services are probed in one round-trip.
//
// Each probe is a shell expression whose *exit code* decides up (0) / down (else);
// its stdout becomes the detail text. Status is `unknown` when the connection is
// unreachable or the batch times out. Transitions (up/down/unknown) are logged as
// events; there is no DB persistence.

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

	// group services by connection (skip mis-configured entries with a warning once)
	const groups = {};
	for(const def of services){
		const conn = def.connection || 'default';
		(groups[conn] = groups[conn] || []).push(def);
	}

	// current status per service name (shown by the API); pre-seeded as pending
	const latest = {};
	const prev = {}; // name -> last status, for transition detection
	for(const def of services){
		latest[def.name] = { name: def.name, group: def.group || '', type: def.type, connection: def.connection || 'default', status: 'unknown', detail: '', checked_at: null };
	}

	// bound a hung probe batch so it can't wedge the checker
	function execTimeout(name, cmd){
		return new Promise((resolve, reject)=>{
			let done = false;
			const to = setTimeout(()=>{ if(!done){ done = true; reject(new Error('check timed out')); } }, timeoutMs);
			pool.exec(name, cmd).then(
				(r)=>{ if(!done){ done = true; clearTimeout(to); resolve(r); } },
				(e)=>{ if(!done){ done = true; clearTimeout(to); reject(e); } });
		});
	}

	function apply(def, status, detail){
		const e = latest[def.name];
		e.status = status;
		e.detail = detail;
		e.checked_at = Math.floor(Date.now() / 1000);

		const was = prev[def.name];
		prev[def.name] = status;
		// first sighting: only announce a definite up/down (skip startup 'unknown' noise)
		if(was === undefined && status === 'unknown') return;
		if(was === status) return;
		const type = status === 'up' ? 'service_up' : (status === 'down' ? 'service_down' : 'service_fail');
		onEvent(type, def.group || null, `${def.name}: ${status}${detail ? ` (${detail})` : ''}`);
	}

	async function checkGroup(conn, list){
		let parsed;
		try{
			const res = await execTimeout(conn, buildBatch(list));
			parsed = parseChecks(res.stdout || '');
		}
		catch(err){
			// connection down / timeout: everything on it is unknown
			for(const def of list) apply(def, 'unknown', `unreachable: ${err.message}`);
			return;
		}
		list.forEach((def, i)=>{
			const r = parsed[i];
			if(!r){ apply(def, 'unknown', 'no result'); return; }
			const status = r.rc === 0 ? 'up' : 'down';
			apply(def, status, r.detail || (status === 'up' ? 'running' : 'not running'));
		});
	}

	async function checkAll(){
		if(checking) return;
		checking = true;
		try{
			for(const [conn, list] of Object.entries(groups)){
				if(list.length) await checkGroup(conn, list);
			}
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
		all: ()=>Object.values(latest).map((e)=>({ ...e, online: pool.hasConn(e.connection) })),
	};
}

module.exports = { createServiceChecker, buildProbe, buildBatch, parseChecks };
