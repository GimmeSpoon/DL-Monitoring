// Dashboard: builds each server card once (buildServerCard) and then only
// fills in values every second (updateServer). The card structure is rebuilt
// only when the set of servers / GPUs / mounts changes.

const addr = '/monitor';
const colors = ['#00acc1', '#70cea1', '#C1C120', '#EF9B57', '#FF2020'];
const util_pivots = [30, 50, 70, 90];   // %
const temp_pivots = [60, 70, 80, 90];   // °C
const ratio_pivots = [0.3, 0.5, 0.7, 0.9];

let lastSignature = null;

function ColorByValue(value, pivots, colors){
	if(pivots.length != colors.length - 1){
		throw new Error("Should be one more Color than pivots' length.");
	}
	let i = 0;
	for(; i < pivots.length; i++){
		if(value < pivots[i]){
			return colors[i];
		}
	}
	return colors[i];
}

const fmtBytes = (b)=>{
	if(!Number.isFinite(b)) return '--';
	const TB = 1024 ** 4, GB = 1024 ** 3, MB = 1024 ** 2;
	if(b >= TB) return `${Math.round(b / TB * 10) / 10}T`;
	if(b >= GB) return `${Math.round(b / GB * 10) / 10}G`;
	return `${Math.round(b / MB)}M`;
};

const userHTML = (users)=>{
	let html = '';
	for(const user of users){
		html += `<div class="d-user"><i class="fa-solid fa-user"></i> ${user}</div>`;
	}
	return html;
};

// SVG circular gauge; ids: <prefix><sel> (circle), <prefix>-info<sel> (main
// text), <prefix>-sub<sel> (subline)
function gauge(prefix, sel, subText, mainFontSize = 8){
	return `<section>
		<svg class="circle-chart" viewbox="0 0 33.83098862 33.83098862" width="60" height="60" xmlns="http://www.w3.org/2000/svg">
			<circle class="circle-chart__circle" id="${prefix}${sel}" stroke="#00acc1" stroke-width="2" stroke-dasharray="0,100" stroke-linecap="round" fill="none" cx="16.91549431" cy="16.91549431" r="15.91549431" />
			<g class="circle-chart__info">
				<text class="circle-chart__percent" id="${prefix}-info${sel}" x="16.91549431" y="12.5" alignment-baseline="central" text-anchor="middle" font-size="${mainFontSize}"></text>
				<text class="circle-chart__subline" id="${prefix}-sub${sel}" x="16.91549431" y="21.5" alignment-baseline="central" text-anchor="middle" font-size="6">${subText}</text>
			</g>
		</svg>
	</section>`;
}

function setGauge(prefix, sel, percent, color, mainText){
	const pct = Math.max(0, Math.min(100, Number(percent) || 0));
	$(`#${prefix}${sel}`).attr({ 'stroke-dasharray': `${pct},100`, 'stroke': color });
	$(`#${prefix}-info${sel}`).text(mainText);
}

function buildGpuBox(name, gpu){
	const sel = `${name}_${gpu['gpu_id']}`;
	return `<div class="gpu-box" id="gpu${sel}">
		<div class="gpu-head">
			<div class="timestamp" id="time${sel}"></div>
			<div class="gpuname" id="name${sel}"></div>
		</div>
		<div class="fan-container gauge">
			<div class="fan" id="fan${sel}"><i class="fa-solid fa-fan"></i></div>
			<span id="fan-info${sel}"></span>
		</div>
		<div class="d-util">${gauge('util', sel, 'USAGE')}</div>
		<div class="d-mem">${gauge('mem', sel, '', 7)}</div>
		<div class="d-temp">${gauge('temp', sel, 'TEMP')}</div>
		<div class="d-pow">${gauge('pow', sel, 'POWER')}</div>
	</div>`;
}

function buildServerCard(state){
	const name = state['name'];
	const disks = (state['system'] && state['system']['disks']) || [];
	const diskHTML = disks.map((d, i)=>
		`<div class="disk-row">
			<span class="disk-mount" title="${d['mount']}">${d['mount']}</span>
			<div class="disk-bar"><div class="disk-fill" id="diskfill${name}_${i}"></div></div>
			<span class="disk-text" id="disktext${name}_${i}"></span>
		</div>`).join('');
	const gpuHTML = state['gpus'].length
		? state['gpus'].map((g)=>buildGpuBox(name, g)).join('')
		: '<div class="no-gpu">No GPUs</div>';

	return `<div class="dev-box themed" id="dev${name}">
		<div class="dev-head">
			<div>
				<span class="sb title-server">MLLAB ${name}</span><span class="offline-badge">OFFLINE</span>
			</div>
			<div class="d-info-basic">
				<div class="sl driver-version" id="driver${name}"></div>
				<div class="sl cuda-version" id="cuda${name}"></div>
			</div>
		</div>
		<div class="user-box" id="user${name}"></div>
		<div class="sys-box" id="sys${name}">
			<div class="sys-head"><span>SYSTEM</span><span class="sys-load" id="load${name}"></span></div>
			<div class="d-util">${gauge('cpu', name, 'CPU')}</div>
			<div class="d-mem">${gauge('ram', name, '', 7)}</div>
			<div class="disk-list" id="disks${name}">${diskHTML}</div>
		</div>
		<div class="dev-body">${gpuHTML}</div>
	</div>`;
}

// structure only changes when servers / GPUs / mounts change
function signature(states){
	return JSON.stringify(Object.entries(states).map(([key, s])=>
		[key, s['gpus'].length, ((s['system'] && s['system']['disks']) || []).map((d)=>d['mount'])]));
}

function updateGPU(name, gpu){
	const sel = `${name}_${gpu['gpu_id']}`;

	// P0-P5: high performance (in use), above: idle
	const pn = Number(gpu['pstate'].slice(1));
	$(`#gpu${sel}`).toggleClass('using', pn <= 5);

	$(`#time${sel}`).text(gpu['timestamp'].slice(0, -4));
	$(`#name${sel}`).text(gpu['gpu_name']);

	const fan = Number(gpu['fan_speed']);
	if(Number.isFinite(fan)){
		$(`#fan${sel}`).css({ 'animation-duration': `${fan > 0 ? -fan / 100 * 2.7 + 3 : 0}s` });
		$(`#fan-info${sel}`).text(`${gpu['fan_speed']}%`);
	}
	else{ // datacenter GPUs report no fan
		$(`#fan${sel}`).css({ 'animation-duration': '0s' });
		$(`#fan-info${sel}`).text('N/A');
	}

	const usage = Number(gpu['utilization_gpu']);
	setGauge('util', sel, usage, ColorByValue(usage, util_pivots, colors), `${usage}%`);

	const temp = Number(gpu['temperature_gpu']);
	setGauge('temp', sel, temp, ColorByValue(temp, temp_pivots, colors), `${temp}°C`);

	const memRatio = Number(gpu['used_memory']) / Number(gpu['total_memory']);
	setGauge('mem', sel, memRatio * 100, ColorByValue(memRatio, ratio_pivots, colors), `${Math.round(Number(gpu['used_memory']) / 1024 * 10) / 10}GB`);
	$(`#mem-sub${sel}`).text(`/ ${Math.round(Number(gpu['total_memory']) / 1024 * 10) / 10}GB`);

	const powRatio = Number(gpu['power_draw']) / Number(gpu['power_limit']);
	setGauge('pow', sel, powRatio * 100, ColorByValue(powRatio, ratio_pivots, colors), `${parseInt(Number(gpu['power_draw']))}W`);
}

function updateServer(state){
	const name = state['name'];
	$(`#dev${name}`).toggleClass('offline', state['online'] === false);
	$(`#driver${name}`).text(`DRIVER Version : ${state['driver_version'] || 'N/A'}`);
	$(`#cuda${name}`).text(`CUDA Version : ${state['cuda_version'] || 'N/A'}`);
	$(`#user${name}`).html(state['users'] && state['users'].length
		? userHTML(state['users'])
		: '<div class="d-user">No Users</div>');

	const sys = state['system'] || {};
	if(sys['cpu']){
		const util = sys['cpu']['util'];
		if(util === null || util === undefined){
			setGauge('cpu', name, 0, colors[0], '--'); // needs two polls after (re)connect
		}
		else{
			setGauge('cpu', name, util, ColorByValue(util, util_pivots, colors), `${Math.round(util)}%`);
		}
		const load = sys['cpu']['load'] ? sys['cpu']['load'][0] : '--';
		$(`#load${name}`).text(`LOAD ${load} · ${sys['cpu']['cores'] != null ? sys['cpu']['cores'] : '--'} CORES`);
	}
	if(sys['memory']){
		const ratio = sys['memory']['used'] / sys['memory']['total'];
		setGauge('ram', name, ratio * 100, ColorByValue(ratio, ratio_pivots, colors), fmtBytes(sys['memory']['used']));
		$(`#ram-sub${name}`).text(`/ ${fmtBytes(sys['memory']['total'])}`);
	}
	(sys['disks'] || []).forEach((disk, i)=>{
		const ratio = disk['total'] ? disk['used'] / disk['total'] : 0;
		$(`#diskfill${name}_${i}`).css({ 'width': `${(ratio * 100).toFixed(1)}%`, 'background': ColorByValue(ratio, ratio_pivots, colors) });
		$(`#disktext${name}_${i}`).text(`${fmtBytes(disk['used'])} / ${fmtBytes(disk['total'])}`);
	});

	for(const gpu of state['gpus']){
		updateGPU(name, gpu);
	}
}

function refresh(){
	$.getJSON(addr).done((states)=>{
		const sig = signature(states);
		if(sig !== lastSignature){
			lastSignature = sig;
			$('#dashboard').html(Object.values(states).map(buildServerCard).join(''));
		}
		for(const state of Object.values(states)){
			updateServer(state);
		}
	});
}

$(document).ready(function(){
	refresh();
	setInterval(refresh, 1000);
});
