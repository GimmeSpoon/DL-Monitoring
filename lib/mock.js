// --mock mode: synthesizes parser-shaped data and pushes it through the
// collector's normal ingest path every second. No SSH involved. Lets the
// whole stack (dashboard, persistence, sessions, charts) run on a laptop.

const GB = 1024 * 1024 * 1024;

const MOCK_SERVERS = [
	{ name: 'mock1', gpus: 2, gpu_name: 'NVIDIA GeForce RTX 3090', mem: 24576, fan: true, cores: 32, ramTotal: 128 * GB, power_limit: 350 },
	{ name: 'mock2', gpus: 4, gpu_name: 'NVIDIA H200', mem: 143771, fan: false, cores: 224, ramTotal: 2048 * GB, power_limit: 700 },
];
const USER_POOL = ['alice', 'bob', 'carol', 'dave', 'eve'];

function timestamp(){
	const d = new Date();
	const p = (n, w = 2)=>String(n).padStart(w, '0');
	return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

function createMock(collector, { onEvent } = {}){
	onEvent = onEvent || (()=>{});
	let timer = null;
	let running = false;
	let nextPid = 10000;

	// per-server mutable sim state
	const sim = {};
	for(const s of MOCK_SERVERS){
		sim[s.name] = {
			jobs: [],                       // {gpu_index, pid, user, used_memory}
			util: s.gpus <= 2 ? 40 : 70,    // wandering baseline
			cpu: { idle: 1000000, total: 2000000 },
			offlineUntil: 0,
		};
	}

	function churnJobs(server, st){
		// ~1 start and ~1 stop every ~2 minutes per server
		if(Math.random() < 1 / 120 || (st.jobs.length === 0 && Math.random() < 1 / 20)){
			const gpu_index = Math.floor(Math.random() * server.gpus);
			const user = USER_POOL[Math.floor(Math.random() * USER_POOL.length)];
			st.jobs.push({ gpu_index, pid: nextPid++, user, used_memory: Math.round(server.mem * (0.2 + Math.random() * 0.6)) });
		}
		if(st.jobs.length > 0 && Math.random() < 1 / 120){
			st.jobs.splice(Math.floor(Math.random() * st.jobs.length), 1);
		}
	}

	function tick(){
		for(const server of MOCK_SERVERS){
			const st = sim[server.name];

			// simulated connection drops: ~once per 5 min, 10-25s long
			const now = Date.now();
			if(st.offlineUntil > now){ continue; }
			if(collector.states[server.name] && !collector.states[server.name].online){
				onEvent('ssh_connect', server.name, 'mock reconnected');
			}
			if(Math.random() < 1 / 300){
				st.offlineUntil = now + 10000 + Math.random() * 15000;
				collector.markOffline(server.name);
				onEvent('ssh_disconnect', server.name, 'mock connection drop');
				continue;
			}

			churnJobs(server, st);
			st.util = Math.max(0, Math.min(100, st.util + (Math.random() - 0.5) * 10));

			const busyGpus = new Set(st.jobs.map((j)=>j.gpu_index));
			const gpus = [];
			for(let i = 0; i < server.gpus; i++){
				const busy = busyGpus.has(i);
				const util = busy ? Math.round(st.util) : 0;
				const used = st.jobs.filter((j)=>j.gpu_index === i).reduce((a, j)=>a + j.used_memory, 0);
				gpus.push({
					'gpu_id': String(i),
					'timestamp': timestamp(),
					'gpu_name': server.gpu_name,
					'display_mode': 'Disabled',
					'display_active': 'Disabled',
					'fan_speed': server.fan ? String(30 + Math.round(util / 2)) : 'N/A',
					'temperature_gpu': String(35 + Math.round(util * 0.45)),
					'temperature_memory': String(40 + Math.round(util * 0.4)),
					'power_draw': (server.power_limit * (0.1 + util / 100 * 0.85)).toFixed(2),
					'power_limit': server.power_limit.toFixed(2),
					'used_memory': String(Math.min(used, server.mem)),
					'total_memory': String(server.mem),
					'utilization_gpu': String(util),
					'utilization_memory': String(Math.round(util * 0.7)),
					'pstate': busy ? 'P2' : 'P8',
				});
			}

			// CPU counters advance so the collector's delta logic is exercised
			const targetCpu = Math.min(95, 10 + st.util * 0.6 + Math.random() * 10);
			const jiffies = server.cores * 100; // ~1s worth
			st.cpu.total += jiffies;
			st.cpu.idle += Math.round(jiffies * (1 - targetCpu / 100));

			const load = (server.cores * targetCpu / 100);
			collector.ingest(server.name, {
				'name': server.name,
				'driver_version': '580.159.03',
				'cuda_version': '12.6.68',
				'users': Array.from(new Set(st.jobs.map((j)=>j.user))),
				'gpus': gpus,
				'apps': st.jobs.map((j)=>({ ...j })),
				'sysRaw': {
					'cpu': { 'counters': { ...st.cpu }, 'cores': server.cores, 'load': [load, load * 0.9, load * 0.8].map((x)=>Math.round(x * 100) / 100) },
					'memory': { 'total': server.ramTotal, 'used': Math.round(server.ramTotal * (0.15 + st.util / 100 * 0.5)), 'available': Math.round(server.ramTotal * 0.8) },
					'disks': [
						{ 'mount': '/', 'total': 1888425144320, 'used': Math.round(1400301363200 + st.util * 1e7) },
						{ 'mount': '/data', 'total': 30601613336576, 'used': 22892221218816 },
					],
				},
			});
		}
	}

	function start(){
		if(running) return;
		running = true;
		tick();
		timer = setInterval(tick, 1000);
	}

	function stop(){
		if(!running) return;
		running = false;
		clearInterval(timer);
		timer = null;
		for(const server of MOCK_SERVERS) collector.markOffline(server.name);
	}

	return { start, stop, isRunning: ()=>running };
}

module.exports = { createMock };
