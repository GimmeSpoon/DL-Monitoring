// Per-account storage scanner. Runs on a slow interval (default 6h) — NOT in
// the 1s poll — because a du walk is I/O-heavy. Reuses the collector's live,
// already-authenticated connection (collector.exec), so it needs no keys of its
// own. "Auto" strategy: try filesystem quotas (instant, exact, but only if
// quotas are enabled + the account can read them), else fall back to a du scan
// of the configured roots (each top-level directory = one account).

const { splitSections } = require('./parser');

const MOCK_USERS = ['alice', 'bob', 'carol', 'dave', 'eve', 'frank', 'grace', 'heidi'];
const GiB = 1024 ** 3;

// Q holds repquota's output; if quotas aren't enabled it's empty and we du.
// A per-command `sudo -n` prefix is applied when the toggle is on.
function buildCommand({ roots, sudo }){
	const S = sudo ? 'sudo -n ' : '';
	const globs = roots.map((r)=>`"${r.replace(/\/+$/, '')}"/*`).join(' ');
	return `Q=$(${S}repquota -a 2>/dev/null); ` +
		`if [ -n "$Q" ]; then echo @@QUOTA; printf '%s\\n' "$Q"; ` +
		`else echo @@DU; ${S}du -sb ${globs} 2>/dev/null; fi`;
}

function parseScan(raw){
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
		for(const line of sec.DU || []){
			const m = line.match(/^(\d+)\s+(.+)$/);
			if(!m) continue;
			const account = m[2].replace(/\/+$/, '').split('/').pop();
			if(!account) continue;
			method = 'du';
			acc[account] = (acc[account] || 0) + Number(m[1]);
		}
	}

	const accounts = Object.entries(acc)
		.map(([account, bytes])=>({ account, bytes }))
		.sort((a, b)=>b.bytes - a.bytes);
	return { accounts, method };
}

// plausible synthetic per-account sizes so --mock exercises the storage page
function synth(){
	return MOCK_USERS
		.filter(()=>Math.random() < 0.85)
		.map((account)=>({ account, bytes: Math.round((5 + Math.random() * 120) * GiB) }))
		.sort((a, b)=>b.bytes - a.bytes);
}

function createStorageScanner({ collector, servers, db, onEvent, roots, sudo, intervalMs, timeoutMs, firstDelayMs, mock }){
	onEvent = onEvent || (()=>{});
	roots = (roots && roots.length) ? roots : ['/home'];
	timeoutMs = timeoutMs || 300000;
	firstDelayMs = firstDelayMs == null ? 20000 : firstDelayMs;
	let timer = null, first = null, running = false, scanning = false;

	// a hung du must not wedge the scanner; bound each server's command
	function execTimeout(name, cmd){
		return new Promise((resolve, reject)=>{
			let done = false;
			const to = setTimeout(()=>{ if(!done){ done = true; reject(new Error('scan timed out')); } }, timeoutMs);
			collector.exec(name, cmd).then(
				(r)=>{ if(!done){ done = true; clearTimeout(to); resolve(r); } },
				(e)=>{ if(!done){ done = true; clearTimeout(to); reject(e); } });
		});
	}

	async function scanServer(name){
		const ts = Math.floor(Date.now() / 1000);
		let accounts, method;
		try{
			if(mock){ accounts = synth(); method = 'mock'; }
			else{
				if(!collector.hasConn(name)) return; // offline: skip, retry next interval
				const res = await execTimeout(name, buildCommand({ roots, sudo }));
				({ accounts, method } = parseScan(res.stdout || ''));
			}
		}
		catch(err){ onEvent('storage_fail', name, `scan failed: ${err.message}`); return; }

		if(!accounts.length){ onEvent('storage_scan', name, `${method}: no accounts found`); return; }
		for(const a of accounts) db.insertStorageUsage(ts, name, a.account, a.bytes);
		const gib = accounts.reduce((s, a)=>s + a.bytes, 0) / GiB;
		onEvent('storage_scan', name, `${method}: ${accounts.length} accounts, ${gib.toFixed(1)} GiB`);
	}

	async function scanAll(){
		if(scanning) return;
		scanning = true;
		try{
			const names = mock ? Object.keys(collector.states) : servers.map((s)=>s.name);
			for(const name of names) await scanServer(name);
		}
		finally{ scanning = false; }
	}

	function start(){
		if(running) return;
		running = true;
		timer = setInterval(scanAll, intervalMs);
		first = setTimeout(()=>{ if(running) scanAll(); }, firstDelayMs);
	}

	function stop(){
		running = false;
		clearInterval(timer);
		clearTimeout(first);
		timer = first = null;
	}

	return { start, stop, scanNow: scanAll };
}

module.exports = { createStorageScanner, parseScan, buildCommand };
