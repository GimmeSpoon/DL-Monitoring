// Downsampler: accumulates the 1s in-memory states and writes one aggregated
// row per server (+ per GPU, + per mount) per flush interval (60s).
function createAggregator({ db }){

	let buf = {}; // server -> accumulators

	function bucketFor(server){
		if(!buf[server]){
			buf[server] = {
				cpuSum: 0, cpuMax: null, cpuN: 0, load1Sum: 0, load1N: 0,
				memUsedSum: 0, memN: 0, memTotal: null,
				rxSum: 0, txSum: 0, netN: 0,
				gpus: {},   // index -> {utilSum, utilMax, n, memUsedSum, memTotal, tempSum, tempMax, powerSum}
				disks: {},  // mount -> {used, total} (last value wins)
			};
		}
		return buf[server];
	}

	// called from the collector's ingest path on every poll
	function add(server, state){
		const b = bucketFor(server);
		const sys = state.system || {};

		if(sys.cpu && sys.cpu.util !== null && sys.cpu.util !== undefined){
			b.cpuSum += sys.cpu.util;
			b.cpuMax = b.cpuMax === null ? sys.cpu.util : Math.max(b.cpuMax, sys.cpu.util);
			b.cpuN++;
		}
		if(sys.cpu && sys.cpu.load){
			b.load1Sum += sys.cpu.load[0];
			b.load1N++;
		}
		if(sys.memory){
			b.memUsedSum += sys.memory.used;
			b.memN++;
			b.memTotal = sys.memory.total;
		}
		if(sys.network){
			b.rxSum += sys.network.rx;
			b.txSum += sys.network.tx;
			b.netN++;
		}
		for(const disk of sys.disks || []){
			b.disks[disk.mount] = { used: disk.used, total: disk.total };
		}

		for(const gpu of state.gpus || []){
			const idx = Number(gpu.gpu_id);
			const g = b.gpus[idx] = b.gpus[idx] || { utilSum: 0, utilMax: null, n: 0, memUsedSum: 0, memTotal: null, tempSum: 0, tempMax: null, powerSum: 0 };
			const util = Number(gpu.utilization_gpu);
			const temp = Number(gpu.temperature_gpu);
			if(Number.isFinite(util)){
				g.utilSum += util;
				g.utilMax = g.utilMax === null ? util : Math.max(g.utilMax, util);
			}
			if(Number.isFinite(temp)){
				g.tempSum += temp;
				g.tempMax = g.tempMax === null ? temp : Math.max(g.tempMax, temp);
			}
			g.memUsedSum += Number(gpu.used_memory) || 0;
			g.memTotal = Number(gpu.total_memory) || g.memTotal;
			g.powerSum += Number(gpu.power_draw) || 0;
			g.n++;
		}
	}

	// called every flush interval (60s)
	function flush(){
		const ts = Math.floor(Date.now() / 1000);
		for(const [server, b] of Object.entries(buf)){
			if(b.cpuN > 0 || b.memN > 0){
				db.insertSysSample(ts, server, {
					cpu_avg: b.cpuN ? b.cpuSum / b.cpuN : null,
					cpu_max: b.cpuMax,
					load1: b.load1N ? b.load1Sum / b.load1N : null,
					mem_used_avg: b.memN ? Math.round(b.memUsedSum / b.memN) : null,
					mem_total: b.memTotal,
					rx_avg: b.netN ? Math.round(b.rxSum / b.netN) : null,
					tx_avg: b.netN ? Math.round(b.txSum / b.netN) : null,
				});
			}
			for(const [idx, g] of Object.entries(b.gpus)){
				if(g.n === 0) continue;
				db.insertGpuSample(ts, server, Number(idx), {
					util_avg: g.utilSum / g.n,
					util_max: g.utilMax,
					mem_used_avg: g.memUsedSum / g.n,
					mem_total: g.memTotal,
					temp_avg: g.tempSum / g.n,
					temp_max: g.tempMax,
					power_avg: g.powerSum / g.n,
				});
			}
			for(const [mount, d] of Object.entries(b.disks)){
				db.insertDiskSample(ts, server, mount, d);
			}
		}
		buf = {};
	}

	return { add, flush };
}

module.exports = { createAggregator };
