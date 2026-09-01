const test = require('node:test');
const assert = require('node:assert');
const { createAlarmManager, normalizeRule, matchesAny, subjectOf } = require('../lib/alarms');
const { slackPayload, redactChannel, severityRank } = require('../lib/notify');

// A manager wired to a fake delivery function and a fake collector, so a test
// asserts on what *would* have been sent without any network.
function harness(rules, opts = {}){
	const sent = [];
	const collector = { states: opts.states || {} };
	const mgr = createAlarmManager({
		config: { channels: { ops: { type: 'slack', url: 'https://example.invalid/hook' } }, defaults: { channels: ['ops'] }, rules },
		db: opts.db || null,
		collector,
		onEvent: opts.onEvent || (()=>{}),
		deliver: async (ch, alarm)=>{ sent.push(alarm); return { sent: true, status: 200 }; },
	});
	return { mgr, sent, collector };
}

test('a repeating failure event notifies once, and once more when it recovers', ()=>{
	const { mgr, sent } = harness([{ id: 'srv', type: 'event', events: ['ssh_fail'], severity: 'critical' }]);
	// ssh_fail repeats every ~10s for as long as a box is down
	for(let i = 0; i < 20; i++) mgr.handleEvent('ssh_fail', 'gpu-1', 'connect failed: timeout');
	assert.strictEqual(sent.length, 1, 'only the transition into firing notifies');
	assert.strictEqual(sent[0].state, 'firing');
	assert.strictEqual(sent[0].severity, 'critical');

	mgr.handleEvent('ssh_connect', 'gpu-1', '10.0.0.2 connected (key)');
	assert.strictEqual(sent.length, 2);
	assert.strictEqual(sent[1].state, 'resolved');

	// and a fresh outage after the recovery is a new alarm, not a duplicate
	mgr.handleEvent('ssh_fail', 'gpu-1', 'connect failed: timeout');
	assert.strictEqual(sent.length, 3);
	assert.strictEqual(sent[2].state, 'firing');
});

test('one service recovering does not resolve another that is still down', ()=>{
	const { mgr, sent } = harness([{ id: 'svc', type: 'event', events: ['service_down'], severity: 'critical' }]);
	mgr.handleEvent('service_down', 'web', 'nginx: down (not running)');
	mgr.handleEvent('service_down', 'web', 'redis: down (not running)');
	assert.strictEqual(sent.length, 2);

	mgr.handleEvent('service_up', 'web', 'nginx: up (running)');
	const resolved = sent.filter((a)=>a.state === 'resolved');
	assert.strictEqual(resolved.length, 1);
	assert.strictEqual(resolved[0].subject, 'nginx');
	assert.strictEqual(mgr.status().active.length, 1, 'redis is still firing');
	assert.strictEqual(mgr.status().active[0].subject, 'redis');
});

test('an event rule with no recovery event dedupes on repeatMinutes', ()=>{
	const { mgr, sent } = harness([{ id: 'logins', type: 'event', events: ['login_fail'], repeatMinutes: 60 }]);
	for(let i = 0; i < 5; i++) mgr.handleEvent('login_fail', null, 'failed login from 10.0.0.9');
	assert.strictEqual(sent.length, 1, 'a burst of failed logins is one message');
	assert.strictEqual(normalizeRule({ type: 'event', events: ['login_fail'] }, 0, {}).oneShot, true);
	assert.strictEqual(normalizeRule({ type: 'event', events: ['service_down'] }, 0, {}).oneShot, false);
});

test('alarms never re-enter through their own events', ()=>{
	const events = [];
	const { mgr } = harness([{ id: 'everything', type: 'event', events: ['*'] }], { onEvent: (t, s, m)=>{
		events.push(t);
		mgr.handleEvent(t, s, m); // exactly what server.js does
	} });
	mgr.handleEvent('ssh_fail', 'gpu-1', 'boom');
	assert.ok(events.includes('alarm_fire'));
	assert.ok(events.length < 5, `no recursion (got ${events.length} events)`);
});

test('a metric alarm waits out forMinutes, fires once, and clears itself', ()=>{
	const states = { 'gpu-1': { online: true, last_update: 0, system: { disks: [{ mount: '/', used: 96, total: 100 }] }, gpus: [] } };
	const { mgr, sent } = harness([{ id: 'disk', type: 'metric', metric: 'disk.usedPct', above: 90, forMinutes: 0, clearMinutes: 0 }], { states });
	mgr.evalNow();
	mgr.evalNow();
	mgr.evalNow();
	assert.strictEqual(sent.length, 1, 'a level-triggered breach notifies once, not once per pass');
	assert.strictEqual(sent[0].subject, '/');
	assert.match(sent[0].message, /filesystem used is 96\.0% \(above 90\.0%\)/);

	states['gpu-1'].system.disks[0].used = 40;
	mgr.evalNow();
	assert.strictEqual(sent.length, 2);
	assert.strictEqual(sent[1].state, 'resolved');
});

test('forMinutes suppresses a spike; a sustained breach still fires', ()=>{
	const states = { 'gpu-1': { online: true, gpus: [{ gpu_id: '0', temperature_gpu: '91', procs: 1 }], system: {} } };
	const { mgr, sent } = harness([{ id: 'hot', type: 'metric', metric: 'gpu.temp', above: 85, forMinutes: 5 }], { states });
	mgr.evalNow();
	assert.strictEqual(sent.length, 0, 'not yet held for 5 minutes');
	assert.strictEqual(mgr.status().rules[0].pending, 1);

	// rewind the pending alarm's start as if 6 minutes had passed
	const st = mgr.exportState();
	for(const e of Object.values(st.alarms)) e.since -= 6 * 60 * 1000;
	mgr.stop();
	const back = harness([{ id: 'hot', type: 'metric', metric: 'gpu.temp', above: 85, forMinutes: 5 }], { states });
	back.mgr.importState(st);
	back.mgr.evalNow();
	assert.strictEqual(back.sent.length, 1);
	assert.match(back.sent[0].message, /GPU temperature is 91C/);
	assert.strictEqual(back.sent[0].subject, 'gpu0');
});

test('an offline server contributes only its offline metric, never stale readings', ()=>{
	const states = { 'gpu-1': {
		online: false, last_update: Math.floor(Date.now() / 1000) - 600,
		system: { disks: [{ mount: '/', used: 99, total: 100 }] }, gpus: [{ gpu_id: '0', temperature_gpu: '95' }],
	} };
	const { mgr, sent } = harness([
		{ id: 'off', type: 'metric', metric: 'server.offlineMinutes', above: 5, severity: 'critical' },
		{ id: 'disk', type: 'metric', metric: 'disk.usedPct', above: 90 },
		{ id: 'hot', type: 'metric', metric: 'gpu.temp', above: 85 },
	], { states });
	mgr.evalNow();
	assert.strictEqual(sent.length, 1, 'only "offline" fires — the last poll before it died proves nothing now');
	assert.strictEqual(sent[0].ruleId, 'off');
});

test('a subject that disappears resolves instead of firing forever', ()=>{
	const states = { 'gpu-1': { online: true, system: { disks: [{ mount: '/scratch', used: 99, total: 100 }] }, gpus: [] } };
	const { mgr, sent } = harness([{ id: 'disk', type: 'metric', metric: 'disk.usedPct', above: 90, clearMinutes: 0 }], { states });
	mgr.evalNow();
	assert.strictEqual(sent.length, 1);
	states['gpu-1'].system.disks = []; // unmounted
	mgr.evalNow();
	assert.strictEqual(sent[1].state, 'resolved');
	assert.match(sent[1].message, /no longer reported/);
});

test('a disabled or snoozed rule does not deliver, but a snoozed one keeps its state', ()=>{
	const states = { 'gpu-1': { online: true, system: { disks: [{ mount: '/', used: 99, total: 100 }] }, gpus: [] } };
	const off = harness([{ id: 'disk', type: 'metric', metric: 'disk.usedPct', above: 90, enabled: false }], { states });
	off.mgr.evalNow();
	assert.strictEqual(off.sent.length, 0);

	const on = harness([{ id: 'disk', type: 'metric', metric: 'disk.usedPct', above: 90 }], { states });
	on.mgr.snooze('disk', 60);
	on.mgr.evalNow();
	assert.strictEqual(on.sent.length, 0, 'snoozed: nothing leaves the process');
	assert.strictEqual(on.mgr.status().active.length, 1, 'but the UI still shows what is wrong');
	assert.ok(on.mgr.status().rules[0].snoozed_until);
});

test('a reload keeps a firing alarm quiet instead of re-announcing it', ()=>{
	const states = { 'gpu-1': { online: true, system: { disks: [{ mount: '/', used: 99, total: 100 }] }, gpus: [] } };
	const rules = [{ id: 'disk', type: 'metric', metric: 'disk.usedPct', above: 90 }];
	const first = harness(rules, { states });
	first.mgr.evalNow();
	assert.strictEqual(first.sent.length, 1);

	const second = harness(rules, { states });
	second.mgr.importState(first.mgr.exportState());
	second.mgr.evalNow();
	assert.strictEqual(second.sent.length, 0, 'still firing, already announced');

	// a rule deleted from the file drops its alarms rather than leaking them
	const third = harness([{ id: 'other', type: 'metric', metric: 'cpu.util', above: 90 }], { states });
	third.mgr.importState(first.mgr.exportState());
	assert.strictEqual(third.mgr.status().active.length, 0);
});

test('storage and gpu_session rules read the DB', ()=>{
	const db = {
		distinctStorageScopes: ()=>['server-a'],
		latestStorageEntries: ()=>[
			{ kind: 'account', name: 'alice', bytes: 2000 * 1024 ** 3 },
			{ kind: 'account', name: 'bob', bytes: 5 * 1024 ** 3 },
		],
		queryUsage: ()=>({ rows: [{ server: 'gpu-1', gpu_index: 3, username: 'carol', start_ts: Math.floor(Date.now() / 1000) - 72 * 3600 }] }),
	};
	const { mgr, sent } = harness([
		{ id: 'quota', type: 'storage', kind: 'account', aboveGiB: 1000 },
		{ id: 'held', type: 'gpu_session', longerThanHours: 48, notifyResolve: false },
	], { db });
	mgr.evalNow();
	assert.strictEqual(sent.length, 2);
	assert.match(sent[0].message, /account alice is using 2000\.0 GiB \(limit 1000 GiB\)/);
	assert.strictEqual(sent[0].subject, 'account:alice');
	assert.match(sent[1].message, /carol has held GPU 3 for 72\.0h/);
});

test('a webhook failure is contained, not propagated', async ()=>{
	const logged = [];
	const mgr = createAlarmManager({
		config: { channels: { ops: { type: 'slack', url: 'https://example.invalid/hook' } }, defaults: { channels: ['ops'] },
			rules: [{ id: 'svc', type: 'event', events: ['service_down'] }] },
		collector: { states: {} },
		onEvent: (t, s, m)=>logged.push(`${t}: ${m}`),
		deliver: async ()=>{ throw new Error('HTTP 404: no_service'); },
	});
	mgr.handleEvent('service_down', 'web', 'nginx: down');
	await new Promise((r)=>setImmediate(r));
	assert.ok(logged.some((l)=>l.startsWith('alarm_fire')), 'the alarm is still recorded');
	assert.ok(logged.some((l)=>/alarm_error.*404/.test(l)), 'and the delivery failure is reported');
	assert.strictEqual(mgr.status().failed, 1);
});

test('server and subject filters are honoured', ()=>{
	assert.ok(matchesAny(null, 'anything'), 'no filter means every subject');
	assert.ok(matchesAny(['gpu-*'], 'gpu-1'));
	assert.ok(!matchesAny(['gpu-*'], 'cpu-1'));
	assert.ok(matchesAny(['*'], ''));
	assert.strictEqual(subjectOf('service_down', 'nginx: down (not running)'), 'nginx');
	assert.strictEqual(subjectOf('ssh_fail', 'connect failed: timeout'), '');

	const states = {
		'gpu-1': { online: true, system: { disks: [{ mount: '/', used: 99, total: 100 }] }, gpus: [] },
		'gpu-2': { online: true, system: { disks: [{ mount: '/', used: 99, total: 100 }, { mount: '/boot', used: 99, total: 100 }] }, gpus: [] },
	};
	const { mgr, sent } = harness([{ id: 'disk', type: 'metric', metric: 'disk.usedPct', above: 90, servers: ['gpu-2'], subjects: ['/'] }], { states });
	mgr.evalNow();
	assert.strictEqual(sent.length, 1);
	assert.strictEqual(sent[0].server, 'gpu-2');
	assert.strictEqual(sent[0].subject, '/');
});

test('slack payload carries the point in `text` and the detail in a coloured attachment', ()=>{
	const alarm = { rule: 'GPU too hot', state: 'firing', severity: 'critical', server: 'gpu-1', subject: 'gpu0',
		message: 'GPU temperature is 91C (above 85C)', valueText: '91C', forText: '6m', ts: 1700000000 };
	const p = slackPayload(alarm, { channel: '#ops', username: 'Server Monitor' });
	assert.match(p.text, /\[CRITICAL\] GPU too hot — gpu-1 gpu0/);
	assert.strictEqual(p.attachments[0].color, '#f0533f');
	assert.strictEqual(p.channel, '#ops');
	assert.deepStrictEqual(p.attachments[0].fields.map((f)=>f.value), ['gpu-1', 'gpu0', '91C', '6m']);

	const ok = slackPayload({ ...alarm, state: 'resolved' }, {});
	assert.strictEqual(ok.attachments[0].color, '#3fb950');
	assert.match(ok.text, /\[RESOLVED\]/);
	assert.strictEqual(ok.channel, undefined, 'no channel override unless configured');
});

test('a channel below its minSeverity is skipped, and its URL never leaves the process', async ()=>{
	const { deliver } = require('../lib/notify');
	const res = await deliver({ type: 'slack', url: 'https://example.invalid/x', minSeverity: 'critical' },
		{ severity: 'warning', rule: 'noisy', message: 'x' });
	assert.deepStrictEqual(res, { sent: false, reason: 'below channel minSeverity' });
	assert.strictEqual(severityRank('critical') > severityRank('warning'), true);

	const shown = redactChannel('ops', { type: 'slack', url: 'https://hooks.slack.com/services/SECRET' });
	assert.strictEqual(JSON.stringify(shown).includes('SECRET'), false);
	assert.strictEqual(shown.configured, true);
	assert.strictEqual(redactChannel('ops', { type: 'slack', urlEnv: 'NOT_SET_ANYWHERE' }).configured, false);
});

test('switching a rule off drops its firing alarms instead of freezing them', ()=>{
	const states = { 'gpu-1': { online: true, system: { disks: [{ mount: '/', used: 99, total: 100 }] }, gpus: [] } };
	const on = harness([{ id: 'disk', type: 'metric', metric: 'disk.usedPct', above: 90 }], { states });
	on.mgr.evalNow();
	assert.strictEqual(on.mgr.status().active.length, 1);

	// what a UI toggle does: rewrite the file, rebuild, carry the state over
	const off = harness([{ id: 'disk', type: 'metric', metric: 'disk.usedPct', above: 90, enabled: false }], { states });
	off.mgr.importState(on.mgr.exportState());
	assert.strictEqual(off.mgr.status().active.length, 0, 'no ghost row for a rule nothing is evaluating');
	assert.strictEqual(off.mgr.status().rules[0].firing, 0);
	assert.strictEqual(off.sent.length, 0, 'and no misleading "resolved" message');

	// turning it back on re-fires, because the condition still holds
	const again = harness([{ id: 'disk', type: 'metric', metric: 'disk.usedPct', above: 90 }], { states });
	again.mgr.importState(off.mgr.exportState());
	again.mgr.evalNow();
	assert.strictEqual(again.sent.length, 1);
});
