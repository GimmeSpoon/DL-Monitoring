// Dashboard: build each server card once, then only update values every second.
// Cards rebuild only when the set of servers / GPUs / mounts changes.

const addr = '/monitor';

// green -> red thermal ramp (load / heat). cyan is reserved for "in use".
const thermal = ['#2ea043', '#3fb950', '#d6b02f', '#e0863d', '#f0533f'];
const util_pivots = [30, 50, 70, 90];    // %
const temp_pivots = [50, 65, 80, 90];    // °C
const ratio_pivots = [0.3, 0.5, 0.7, 0.9];

let lastSignature = null;

function colorFor(value, pivots){
	let i = 0;
	for(; i < pivots.length; i++){ if(value < pivots[i]) return thermal[i]; }
	return thermal[i];
}

const fmtBytes = (b)=>{
	if(!Number.isFinite(b)) return '--';
	const TB = 1024 ** 4, GB = 1024 ** 3, MB = 1024 ** 2;
	if(b >= TB) return `${Math.round(b / TB * 10) / 10}T`;
	if(b >= GB) return `${Math.round(b / GB * 10) / 10}G`;
	return `${Math.round(b / MB)}M`;
};

// GPU process memory arrives in MiB (nvidia-smi query-compute-apps, nounits)
const fmtMiB = (m)=>{
	m = Number(m);
	if(!Number.isFinite(m)) return '--';
	return m >= 1024 ? `${Math.round(m / 1024 * 10) / 10}G` : `${m}M`;
};

// network rate: bytes/sec -> "12.3M/s" (own K tier — rates are smaller than capacities)
const fmtRate = (b)=>{
	if(!Number.isFinite(b)) return '--';
	const u = ['B', 'K', 'M', 'G'];
	let i = 0, v = b;
	while(v >= 1024 && i < u.length - 1){ v /= 1024; i++; }
	return `${v >= 100 ? Math.round(v) : Math.round(v * 10) / 10}${u[i]}/s`;
};

// set a meter's fill (width + thermal color) and its readout text
function setMeter(id, pct, color, text){
	const p = Math.max(0, Math.min(100, Number(pct) || 0));
	$(`#${id}`).css({ width: `${p}%`, background: color });
	$(`#${id}-val`).text(text);
}

function meterHTML(id, label){
	return `<div class="meter">
		<span class="meter-label">${label}</span>
		<div class="meter-track"><div class="meter-fill" id="${id}"></div></div>
		<span class="meter-val" id="${id}-val"></span>
	</div>`;
}

function buildGpu(name, gpu){
	const sel = `${name}_${gpu['gpu_id']}`;
	return `<div class="gpu" id="gpu${sel}">
		<div class="gpu-top">
			<span class="gpu-badge">GPU ${gpu['gpu_id']}</span>
			<span class="gpu-name" id="name${sel}"></span>
			<span class="gpu-flag" id="flag${sel}"><span class="dot"></span><span id="flag-txt${sel}">idle</span></span>
		</div>
		${meterHTML(`util${sel}`, 'UTIL')}
		${meterHTML(`mem${sel}`, 'MEM')}
		<div class="gpu-stats">
			<span class="stat"><span class="k">TEMP</span> <b id="temp${sel}">--</b></span>
			<span class="stat"><span class="k">PWR</span> <b id="pow${sel}">--</b></span>
			<span class="stat fan"><span class="fan-ico" id="fan${sel}">${window.ICONS.fan}</span> <b id="fan-val${sel}">--</b></span>
		</div>
		<div class="proc-tip" id="proc${sel}"></div>
	</div>`;
}

function buildCard(state){
	const name = state['name'];
	const disks = (state['system'] && state['system']['disks']) || [];
	const diskHTML = disks.map((d, i)=>
		`<div class="disk-row">
			<span class="disk-mount" title="${d['mount']}">${d['mount']}</span>
			<div class="meter-track"><div class="meter-fill" id="disk${name}_${i}"></div></div>
			<span class="disk-text" id="disk-text${name}_${i}"></span>
		</div>`).join('');
	const gpuHTML = state['gpus'].length
		? state['gpus'].map((g)=>buildGpu(name, g)).join('')
		: '<div class="no-gpu">No GPUs on this host</div>';

	return `<section class="card" id="dev${name}">
		<div class="card-head">
			<span class="status" id="status${name}"></span>
			<span class="srv-name">${name}</span>
			<span class="srv-flag">OFFLINE</span>
			<span class="srv-meta"><span id="driver${name}"></span><span id="cuda${name}"></span></span>
		</div>
		<div class="sys">
			${meterHTML(`cpu${name}`, 'CPU')}
			${meterHTML(`ram${name}`, 'RAM')}
			<div class="sys-sub" id="load${name}"></div>
			<div class="sys-sub" id="net${name}"></div>
			<a class="disks disks-link" href="/storage.html?server=${encodeURIComponent(name)}" title="Storage details for ${name}">${diskHTML}</a>
		</div>
		<div class="users" id="user${name}"></div>
		<div class="gpus">${gpuHTML}</div>
	</section>`;
}

// structure changes only when servers / GPU counts / mount sets change
function signature(states){
	return JSON.stringify(Object.entries(states).map(([key, s])=>
		[key, s['gpus'].length, ((s['system'] && s['system']['disks']) || []).map((d)=>d['mount'])]));
}

function updateGpu(name, gpu){
	const sel = `${name}_${gpu['gpu_id']}`;

	// "in use" = a compute process is running, or the GPU is doing work / holding
	// memory. pstate is NOT used: datacenter GPUs sit at P0 even when idle.
	const memRatio = Number(gpu['used_memory']) / Number(gpu['total_memory']);
	const inUse = Number(gpu['procs']) > 0 || Number(gpu['utilization_gpu']) > 0 || memRatio > 0.1;
	$(`#gpu${sel}`).toggleClass('busy', inUse);
	$(`#flag-txt${sel}`).text(inUse ? (Number(gpu['procs']) > 0 ? `busy · ${gpu['procs']} proc${gpu['procs'] > 1 ? 's' : ''}` : 'busy') : 'idle');

	// hover popover: the compute processes running on this GPU (pid · user · mem)
	const procs = gpu['processes'] || [];
	$(`#gpu${sel}`).toggleClass('has-procs', procs.length > 0);
	$(`#proc${sel}`).html(procs.length
		? `<div class="proc-tip-head">${procs.length} process${procs.length > 1 ? 'es' : ''}</div>` + procs.map((p)=>
			`<div class="proc-row"><span class="proc-user">${window.ICONS.user}${p['user'] || '—'}</span><span class="proc-pid">pid ${p['pid']}</span><span class="proc-mem">${fmtMiB(p['used_memory'])}</span></div>`).join('')
		: '');

	$(`#name${sel}`).text(gpu['gpu_name']);

	const util = Number(gpu['utilization_gpu']);
	setMeter(`util${sel}`, util, colorFor(util, util_pivots), `${util}%`);
	setMeter(`mem${sel}`, memRatio * 100, colorFor(memRatio * 100, util_pivots),
		`${Math.round(Number(gpu['used_memory']) / 1024 * 10) / 10}/${Math.round(Number(gpu['total_memory']) / 1024)}G`);

	const temp = Number(gpu['temperature_gpu']);
	$(`#temp${sel}`).text(`${temp}°C`).css('color', colorFor(temp, temp_pivots));
	$(`#pow${sel}`).text(`${parseInt(Number(gpu['power_draw']))}/${parseInt(Number(gpu['power_limit']))}W`);

	const fan = Number(gpu['fan_speed']);
	if(Number.isFinite(fan)){
		$(`#fan${sel}`).css('animation-duration', fan > 0 ? `${-fan / 100 * 2.7 + 3}s` : '0s');
		$(`#fan-val${sel}`).text(`${gpu['fan_speed']}%`);
	}
	else{
		$(`#fan${sel}`).css('animation-duration', '0s');
		$(`#fan-val${sel}`).text('—');
	}
}

function updateCard(state){
	const name = state['name'];
	$(`#dev${name}`).toggleClass('offline', state['online'] === false);
	$(`#status${name}`).attr('title', state['online'] === false ? 'offline' : 'online');
	$(`#driver${name}`).text(state['driver_version'] ? `drv ${state['driver_version']}` : '');
	$(`#cuda${name}`).text(state['cuda_version'] && state['cuda_version'] !== 'Not Available' ? `cuda ${state['cuda_version']}` : '');

	$(`#user${name}`).html(state['users'] && state['users'].length
		? state['users'].map((u)=>`<span class="chip">${window.ICONS.user}${u}</span>`).join('')
		: '<span class="chip empty">no active users</span>');

	const sys = state['system'] || {};
	if(sys['cpu']){
		const u = sys['cpu']['util'];
		if(u === null || u === undefined) setMeter(`cpu${name}`, 0, thermal[0], '-- %');   // needs 2 polls
		else setMeter(`cpu${name}`, u, colorFor(u, util_pivots), `${Math.round(u)}%`);
		const load = sys['cpu']['load'] ? sys['cpu']['load'][0] : '--';
		$(`#load${name}`).text(`load ${load}  ·  ${sys['cpu']['cores'] != null ? sys['cpu']['cores'] : '--'} cores`);
	}
	const net = sys['network'];
	$(`#net${name}`).text(net ? `net  ↓ ${fmtRate(net['rx'])}  ↑ ${fmtRate(net['tx'])}` : 'net  ↓ --  ↑ --');
	if(sys['memory']){
		const r = sys['memory']['used'] / sys['memory']['total'];
		setMeter(`ram${name}`, r * 100, colorFor(r * 100, util_pivots), `${fmtBytes(sys['memory']['used'])}/${fmtBytes(sys['memory']['total'])}`);
	}
	(sys['disks'] || []).forEach((disk, i)=>{
		const r = disk['total'] ? disk['used'] / disk['total'] : 0;
		setMeter(`disk${name}_${i}`, r * 100, colorFor(r * 100, util_pivots), '');
		$(`#disk-text${name}_${i}`).text(`${fmtBytes(disk['used'])}/${fmtBytes(disk['total'])}`);
	});

	for(const gpu of state['gpus']) updateGpu(name, gpu);
}

function refresh(){
	$.getJSON(addr).done((states)=>{
		const sig = signature(states);
		if(sig !== lastSignature){
			lastSignature = sig;
			$('#dashboard').html(Object.values(states).map(buildCard).join(''));
		}
		for(const state of Object.values(states)) updateCard(state);
	});
}

$(function(){
	$('#brand-mark').html(window.ICONS.signal);
	refresh();
	setInterval(refresh, 1000);
});
