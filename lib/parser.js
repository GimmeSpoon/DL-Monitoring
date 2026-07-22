// Parses the output of the combined monitoring command (see lib/collector.js).
// The command separates sections with "@@NAME" marker lines; the first
// (unnamed) section is the per-GPU nvidia-smi csv.

// nvidia-smi prints bracketed placeholders like "[N/A]" or
// "[Requested functionality has been deprecated]" for unsupported fields.
function cleanValue(v){
	return v.startsWith('[') ? 'N/A' : v;
}

function splitSections(raw){
	const sections = { GPU: [] };
	let current = 'GPU';
	for(const line of raw.split('\n')){
		const m = line.match(/^@@(\w+)\s*$/);
		if(m){
			current = m[1];
			sections[current] = [];
		}
		else if(line.trim() !== ''){
			sections[current].push(line);
		}
	}
	return sections;
}

// "0, 2026/07/21 07:34:18.342, NVIDIA H200, 580.159.03, ..." (16 fields)
function parseGpuLine(line){
	const f = line.split(', ').map((s)=>cleanValue(s.trim()));
	if(f.length < 16) return null;
	return {
		'gpu_id': f[0],
		'timestamp': f[1],
		'gpu_name': f[2],
		'driver_version': f[3],
		'display_mode': f[4],
		'display_active': f[5],
		'fan_speed': f[6],
		'temperature_gpu': f[7],
		'temperature_memory': f[8],
		'power_draw': f[9],
		'power_limit': f[10],
		'used_memory': f[11],
		'total_memory': f[12],
		'utilization_gpu': f[13],
		'utilization_memory': f[14],
		'pstate': f[15],
	};
}

function parse(servn, raw){
	const sec = splitSections(raw);

	// GPUs
	const gpus = [];
	let driver_version;
	for(const line of sec.GPU || []){
		const gpu = parseGpuLine(line);
		if(gpu){
			driver_version = gpu.driver_version;
			delete gpu.driver_version; // kept per-server, as in v1
			gpus.push(gpu);
		}
	}

	// CUDA version: "Cuda compilation tools, release 12.6, V12.6.68"
	let cuda_version = 'Not Available';
	for(const line of sec.NVCC || []){
		const m = line.match(/V([0-9.]+)/);
		if(m){ cuda_version = m[1]; }
	}

	// uuid -> gpu index ("0, GPU-8b06f67c-...")
	const uuidToIndex = {};
	for(const line of sec.UUID || []){
		const [idx, uuid] = line.split(', ').map((s)=>s.trim());
		if(uuid) uuidToIndex[uuid] = Number(idx);
	}

	// pid -> username ("1234 alice")
	const pidToUser = {};
	for(const line of sec.PS || []){
		const m = line.match(/^\s*(\d+)\s+(\S+)/);
		if(m) pidToUser[m[1]] = m[2];
	}

	// compute apps ("GPU-8b06f67c-..., 1234, 2048") joined to gpu index + user
	const apps = [];
	for(const line of sec.APPS || []){
		const [uuid, pid, used_memory] = line.split(', ').map((s)=>s.trim());
		if(pid === undefined) continue;
		apps.push({
			'gpu_index': uuidToIndex[uuid] !== undefined ? uuidToIndex[uuid] : null,
			'pid': Number(pid),
			'user': pidToUser[pid] || null,
			'used_memory': Number(used_memory),
		});
	}

	const users = Array.from(new Set(Object.values(pidToUser)));

	// per-GPU running compute processes — the accurate "in use" signal
	// (pstate is unreliable: datacenter GPUs sit at P0 even when idle)
	const procByGpu = {};
	for(const a of apps){
		if(a.gpu_index !== null && a.gpu_index !== undefined){
			procByGpu[a.gpu_index] = (procByGpu[a.gpu_index] || 0) + 1;
		}
	}
	for(const g of gpus){ g.procs = procByGpu[Number(g.gpu_id)] || 0; }

	// CPU: "cpu  user nice system idle iowait irq softirq steal ..." + nproc + loadavg
	let cpu = null;
	const cpuLines = sec.CPU || [];
	if(cpuLines.length >= 1 && cpuLines[0].startsWith('cpu')){
		const c = cpuLines[0].trim().split(/\s+/).slice(1).map(Number);
		const total = c.slice(0, 8).reduce((a, b)=>a + b, 0);
		const idle = c[3] + c[4]; // idle + iowait
		cpu = {
			'counters': { idle, total },
			'cores': cpuLines[1] ? Number(cpuLines[1]) : null,
			'load': cpuLines[2] ? cpuLines[2].trim().split(/\s+/).slice(0, 3).map(Number) : null,
		};
	}

	// MEM: "total used available" in bytes
	let memory = null;
	if((sec.MEM || []).length >= 1){
		const [total, used, available] = sec.MEM[0].trim().split(/\s+/).map(Number);
		memory = { total, used, available };
	}

	// DISK: "source target size used" in bytes; dedup bind mounts by source,
	// keeping the shortest mount path
	const bySource = {};
	for(const line of sec.DISK || []){
		const f = line.trim().split(/\s+/);
		if(f.length < 4) continue;
		const [source, mount, total, used] = [f[0], f[1], Number(f[2]), Number(f[3])];
		if(!bySource[source] || mount.length < bySource[source].mount.length){
			bySource[source] = { mount, total, used };
		}
	}
	const disks = Object.values(bySource).sort((a, b)=>a.mount.localeCompare(b.mount));

	return {
		'name': servn,
		'driver_version': driver_version,
		'cuda_version': cuda_version,
		'users': users,
		'gpus': gpus,
		'apps': apps,
		'sysRaw': { cpu, memory, disks },
	};
}

module.exports = { parse, splitSections };
