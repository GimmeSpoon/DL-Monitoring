const test = require('node:test');
const assert = require('node:assert');
const { parse } = require('../lib/parser');
const { createCollector } = require('../lib/collector');
const { REAL_H200, SYNTHETIC } = require('./fixtures');

test('parses real H200 output (bracketed placeholders, no apps)', ()=>{
	const s = parse('srv1', REAL_H200);

	assert.strictEqual(s.name, 'srv1');
	assert.strictEqual(s.driver_version, '580.159.03');
	assert.strictEqual(s.cuda_version, '12.6.68');
	assert.strictEqual(s.gpus.length, 4);
	assert.strictEqual(s.gpus[0].gpu_name, 'NVIDIA H200');
	assert.strictEqual(s.gpus[0].fan_speed, 'N/A');            // "[N/A]" cleaned
	assert.strictEqual(s.gpus[0].display_mode, 'N/A');         // deprecated-notice cleaned
	assert.strictEqual(s.gpus[0].utilization_gpu, '100');
	assert.strictEqual(s.gpus[3].pstate, 'P0');
	assert.deepStrictEqual(s.users, []);
	assert.deepStrictEqual(s.apps, []);

	assert.strictEqual(s.sysRaw.cpu.cores, 224);
	assert.deepStrictEqual(s.sysRaw.cpu.load, [10.62, 10.02, 9.72]);
	assert.strictEqual(s.sysRaw.cpu.counters.total, 23270496881);
	assert.strictEqual(s.sysRaw.cpu.counters.idle, 22724181092); // idle + iowait

	assert.deepStrictEqual(s.sysRaw.memory, { total: 2164193714176, used: 186191519744, available: 1966154215424 });
	assert.strictEqual(s.sysRaw.disks.length, 2);
});

test('parses synthetic output with apps/users and dedups bind mounts', ()=>{
	const s = parse('srv2', SYNTHETIC);

	assert.strictEqual(s.cuda_version, '11.8.89');
	assert.strictEqual(s.gpus.length, 2);
	assert.deepStrictEqual(s.users.sort(), ['alice', 'bob']);

	assert.strictEqual(s.apps.length, 3);
	assert.deepStrictEqual(s.apps[0], { gpu_index: 0, pid: 1234, user: 'alice', used_memory: 2048 });
	assert.deepStrictEqual(s.apps[2], { gpu_index: 1, pid: 2345, user: 'bob', used_memory: 8192 });

	// /dev/sda1 appears twice (bind mount); the shortest mount path wins
	assert.strictEqual(s.sysRaw.disks.length, 2);
	assert.deepStrictEqual(s.sysRaw.disks.map((d)=>d.mount).sort(), ['/', '/data']);
});

test('handles empty/garbage output without throwing', ()=>{
	const s = parse('dead', '');
	assert.deepStrictEqual(s.gpus, []);
	assert.strictEqual(s.cuda_version, 'Not Available');
	assert.strictEqual(s.sysRaw.cpu, null);
	assert.strictEqual(s.sysRaw.memory, null);
	assert.deepStrictEqual(s.sysRaw.disks, []);

	const g = parse('half', 'garbage line\n@@CPU\nnot a cpu line\n@@MEM\n');
	assert.deepStrictEqual(g.gpus, []);
	assert.strictEqual(g.sysRaw.cpu, null);
});

test('collector computes CPU% from consecutive counter deltas', ()=>{
	const collector = createCollector({ servers: [], pollIntervalMs: 1000, reconnectDelayMs: 1000 });
	const mkParsed = (idle, total)=>({
		name: 's', driver_version: 'd', cuda_version: 'c', users: [], gpus: [], apps: [],
		sysRaw: { cpu: { counters: { idle, total }, cores: 8, load: [1, 1, 1] }, memory: null, disks: [] },
	});

	collector.ingest('s', mkParsed(1000, 2000));
	assert.strictEqual(collector.states['s'].system.cpu.util, null); // first poll: no delta yet

	collector.ingest('s', mkParsed(1500, 3000));
	assert.strictEqual(collector.states['s'].system.cpu.util, 50);   // 1 - 500/1000

	// offline gap resets the delta
	collector.markOffline('s');
	assert.strictEqual(collector.states['s'].online, false);
	collector.ingest('s', mkParsed(1600, 3200));
	assert.strictEqual(collector.states['s'].system.cpu.util, null);
	assert.strictEqual(collector.states['s'].online, true);
});
