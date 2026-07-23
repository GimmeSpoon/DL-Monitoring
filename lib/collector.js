const { NodeSSH } = require('node-ssh');
const { exec } = require('child_process');
const os = require('os');
const path = require('path');
const parser = require('./parser');

function expandHome(p){
	return p && p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p;
}

// A "connection" for a server marked `"local": true` — runs the command
// directly on this host instead of over SSH. Same interface the collector
// uses on a NodeSSH connection (execCommand / dispose), so no SSH, sshd, or
// keys are needed to monitor the machine the server runs on.
function makeLocalConn(){
	return {
		execCommand(cmd){
			return new Promise((resolve, reject)=>{
				exec(cmd, { maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr)=>{
					// like SSH: a non-zero exit still resolves with output; only a
					// spawn failure (e.g. no shell) rejects
					if(err && err.code === undefined) return reject(err);
					resolve({ stdout: stdout || '', stderr: stderr || '' });
				});
			});
		},
		dispose(){},
	};
}

// One combined command per poll. Sections are separated with "echo @@NAME"
// markers and ';' (not '&&') so CPU/mem/disk still arrive when nvidia-smi
// fails. 'nvidia-smi' is not backwards compatible, so the csv query may need
// updates after driver updates.
const COMMAND = [
	'nvidia-smi --query-gpu=index,timestamp,name,driver_version,display_mode,display_active,fan.speed,temperature.gpu,temperature.memory,power.draw,power.limit,memory.used,memory.total,utilization.gpu,utilization.memory,pstate --format=csv,nounits,noheader',
	'echo @@APPS',
	'nvidia-smi --query-compute-apps=gpu_uuid,pid,used_memory --format=csv,noheader,nounits',
	'echo @@UUID',
	'nvidia-smi --query-gpu=index,uuid --format=csv,noheader',
	'echo @@PS',
	'nvidia-smi --query-compute-apps=pid --format=csv,noheader | xargs -r ps -o pid= -o user:30= -p',
	'echo @@CPU',
	'head -1 /proc/stat',
	'nproc',
	'cat /proc/loadavg',
	'echo @@MEM',
	"free -b | awk 'NR==2{print $2,$3,$7}'",
	'echo @@DISK',
	'df -B1 -x tmpfs -x devtmpfs -x overlay -x squashfs -x vfat --output=source,target,size,used 2>/dev/null | tail -n +2',
	'echo @@NET',
	'cat /proc/net/dev',
	'echo @@NVCC',
	'/usr/local/cuda*/bin/nvcc --version 2>/dev/null | grep -i release',
].join(' ; ');

function createCollector({ servers, agentSock, defaultKey, pollIntervalMs, reconnectDelayMs, onEvent, onIngest }){

	const states = {};       // server name -> latest state (kept, greyed-out, when offline)
	const conns = {};        // server name -> NodeSSH
	const inFlight = {};     // server name -> bool (skip a tick instead of piling up)
	const cpuPrev = {};      // server name -> {idle, total} for CPU% delta
	const netPrev = {};      // server name -> {rx, tx, ts} for network rate delta
	const lastAttempt = {};  // server name -> ms timestamp of last connect attempt
	let timer = null;
	let running = false;

	onEvent = onEvent || (()=>{});

	// Shared ingest path: real polls and --mock both go through here.
	// `parsed` is the output shape of parser.parse().
	function ingest(name, parsed){
		let util = null;
		const cpu = parsed.sysRaw && parsed.sysRaw.cpu;
		if(cpu && cpu.counters){
			const prev = cpuPrev[name];
			if(prev && cpu.counters.total > prev.total){
				const dTotal = cpu.counters.total - prev.total;
				const dIdle = cpu.counters.idle - prev.idle;
				util = Math.max(0, Math.min(100, 100 * (1 - dIdle / dTotal)));
			}
			cpuPrev[name] = cpu.counters;
		}

		// network throughput: bytes/sec from the delta of cumulative counters.
		// null on the first poll (and after a gap/counter reset) until two
		// consecutive readings exist.
		let network = null;
		const net = parsed.sysRaw && parsed.sysRaw.network;
		if(net){
			const prev = netPrev[name];
			const nowMs = Date.now();
			if(prev && nowMs > prev.ts && net.rx >= prev.rx && net.tx >= prev.tx){
				const dt = (nowMs - prev.ts) / 1000;
				network = { rx: (net.rx - prev.rx) / dt, tx: (net.tx - prev.tx) / dt };
			}
			netPrev[name] = { rx: net.rx, tx: net.tx, ts: nowMs };
		}

		states[name] = {
			'name': parsed.name,
			'driver_version': parsed.driver_version,
			'cuda_version': parsed.cuda_version,
			'users': parsed.users,
			'gpus': parsed.gpus,
			'system': {
				'cpu': cpu ? { 'util': util, 'cores': cpu.cores, 'load': cpu.load } : null,
				'memory': (parsed.sysRaw && parsed.sysRaw.memory) || null,
				'disks': (parsed.sysRaw && parsed.sysRaw.disks) || [],
				'network': network,
			},
			'online': true,
			'last_update': Math.floor(Date.now() / 1000),
		};
		if(onIngest) onIngest(name, states[name], parsed.apps || []);
	}

	function markOffline(name){
		if(states[name]) states[name].online = false;
		delete cpuPrev[name]; // CPU% needs consecutive polls; restart the delta after a gap
		delete netPrev[name]; // same for the network rate
	}

	async function connect(server){
		lastAttempt[server.name] = Date.now();
		if(server['local']){
			conns[server.name] = makeLocalConn();
			onEvent('ssh_connect', server.name, 'local (no ssh)');
			return;
		}
		const conn = new NodeSSH();
		const cfg = {
			host: server['addr'],
			port: server['port'],
			username: server['username'],
		};
		// per-server key wins; else a default key file; else the ssh-agent
		const keyPath = expandHome(server['privateKey'] || defaultKey);
		if(keyPath) cfg.privateKeyPath = keyPath;
		else cfg.agent = agentSock;
		await conn.connect(cfg);
		conns[server.name] = conn;
		onEvent('ssh_connect', server.name, `${server['addr']} connected (${keyPath ? 'key' : 'agent'})`);
	}

	async function pollServer(server){
		const conn = conns[server.name];
		if(!conn || inFlight[server.name]) return;
		inFlight[server.name] = true;
		try{
			// execCommand resolves even on non-zero exit; it only throws on
			// transport errors. Missing sections are handled by the parser.
			const res = await conn.execCommand(COMMAND);
			ingest(server.name, parser.parse(server.name, res.stdout));
		}
		catch(err){
			onEvent('ssh_disconnect', server.name, `poll failed: ${err.message}`);
			try{ conn.dispose(); } catch(e){ /* already dead */ }
			delete conns[server.name];
			markOffline(server.name);
		}
		finally{
			inFlight[server.name] = false;
		}
	}

	async function reconnect(server){
		if(inFlight[server.name]) return;
		if(Date.now() - (lastAttempt[server.name] || 0) < reconnectDelayMs) return;
		inFlight[server.name] = true;
		try{
			await connect(server);
		}
		catch(err){
			onEvent('ssh_fail', server.name, `connect failed: ${err.message}`);
			markOffline(server.name);
		}
		finally{
			inFlight[server.name] = false;
		}
	}

	function tick(){
		for(const server of servers){
			if(conns[server.name]) pollServer(server);
			else reconnect(server);
		}
	}

	function start(){
		if(running) return;
		running = true;
		tick();
		timer = setInterval(tick, pollIntervalMs);
	}

	function stop(){
		if(!running) return;
		running = false;
		clearInterval(timer);
		timer = null;
		for(const [name, conn] of Object.entries(conns)){
			try{ conn.dispose(); } catch(e){ /* ignore */ }
			delete conns[name];
			markOffline(name);
		}
	}

	// run an arbitrary command on a server's live connection (used by the
	// storage scanner, which reuses the already-authenticated connection so it
	// needs no keys of its own). node-ssh opens a separate channel, so this
	// doesn't block the poll loop.
	function exec(name, cmd){
		const conn = conns[name];
		if(!conn) return Promise.reject(new Error(`${name} not connected`));
		return conn.execCommand(cmd);
	}

	return { states, ingest, markOffline, start, stop, isRunning: ()=>running, exec, hasConn: (name)=>!!conns[name] };
}

module.exports = { createCollector, COMMAND };
