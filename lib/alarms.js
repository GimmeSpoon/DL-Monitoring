// Alarms: decides *when* something is worth telling a human about, and hands it
// to lib/notify.js to deliver (Slack, or any webhook).
//
// Three rule families, because the three things worth alarming on arrive very
// differently:
//
//   type "event"       - taps the existing onEvent funnel (ssh_fail, service_down,
//                        storage_fail, login_fail, ...). Edge-triggered.
//   type "metric"      - evaluated against the collector's live state on a timer
//                        (disk 95% full, GPU at 90C, server offline 5 min).
//                        Level-triggered, with a "sustained for N minutes" guard
//                        so a one-second spike never pages anyone.
//   type "storage" /
//        "gpu_session" - evaluated against the DB on a slow timer (an account
//                        over quota, a user holding a GPU for two days).
//
// Every rule is opt-in and individually switchable: nothing is alarmed unless
// configs/alarms.json says so, and each rule can be disabled or snoozed at
// runtime without touching the file.
//
// The one invariant that matters: an alarm notifies on the *transition* into
// firing, not on every observation. `ssh_fail` repeats every 10s while a box is
// down and the metric pass runs every 30s - without a state machine in here,
// one dead server would be hundreds of Slack messages an hour.

const notify = require('./notify');

const GiB = 1024 * 1024 * 1024;
const MIN = 60 * 1000;

// Metric catalogue: how each metric is printed, and the label used in the
// message. `subject` distinguishes rows within one server (a mount, a GPU).
const UNITS = {
	pct: (v)=>`${v.toFixed(1)}%`,
	c: (v)=>`${v.toFixed(0)}C`,
	gib: (v)=>`${v.toFixed(1)} GiB`,
	min: (v)=>`${v.toFixed(1)} min`,
	mbps: (v)=>`${v.toFixed(1)} MB/s`,
	w: (v)=>`${v.toFixed(0)} W`,
	n: (v)=>`${v}`,
	x: (v)=>`${v.toFixed(2)}x`,
};

const METRICS = {
	'cpu.util': { unit: 'pct', label: 'CPU utilisation' },
	'cpu.loadPerCore': { unit: 'x', label: 'load average per core' },
	'mem.usedPct': { unit: 'pct', label: 'memory used' },
	'disk.usedPct': { unit: 'pct', label: 'filesystem used' },
	'disk.freeGiB': { unit: 'gib', label: 'filesystem free' },
	'net.rxMBps': { unit: 'mbps', label: 'network in' },
	'net.txMBps': { unit: 'mbps', label: 'network out' },
	'gpu.util': { unit: 'pct', label: 'GPU utilisation' },
	'gpu.temp': { unit: 'c', label: 'GPU temperature' },
	'gpu.memPct': { unit: 'pct', label: 'GPU memory used' },
	'gpu.memUsedGiB': { unit: 'gib', label: 'GPU memory used' },
	'gpu.power': { unit: 'w', label: 'GPU power draw' },
	'gpu.fan': { unit: 'pct', label: 'GPU fan' },
	'gpu.procs': { unit: 'n', label: 'GPU compute processes' },
	'gpu.idleMinutes': { unit: 'min', label: 'GPU idle time' },
	'server.offlineMinutes': { unit: 'min', label: 'server offline for' },
};

// nvidia-smi columns arrive as strings, and unsupported fields as 'N/A'
function num(v){
	const n = Number(v);
	return Number.isFinite(n) ? n : null;
}

// glob-ish name filter: exact names, or '*' / 'gpu-*' patterns. An absent or
// empty list means "every subject" - a rule shouldn't need to enumerate servers.
function matchesAny(patterns, value){
	if(!patterns || !patterns.length) return true;
	if(value == null) return false;
	return patterns.some((p)=>{
		if(p === '*') return true;
		if(!String(p).includes('*')) return p === value;
		const re = new RegExp('^' + String(p).split('*').map((s)=>s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');
		return re.test(value);
	});
}

// Recovery events for the failures worth pairing. An event rule that watches
// `service_down` is only cleared by `service_up` for the *same* subject, so one
// service coming back doesn't silence another that is still down.
const RESOLVE_PAIRS = {
	ssh_fail: ['ssh_connect'],
	ssh_disconnect: ['ssh_connect'],
	service_down: ['service_up'],
	service_fail: ['service_up'],
	storage_fail: ['storage_scan'],
};

// Which row an event is about, within its server/group. Service events read
// "<name>: down (detail)" and storage events "<label> on <conn>: ...", so the
// text before the first colon identifies the row; other event types have no
// sub-subject and use ''.
function subjectOf(type, message){
	if(/^service_/.test(type) || /^storage_/.test(type)){
		const m = String(message || '').match(/^([^:]{1,80}):/);
		return m ? m[1].trim() : '';
	}
	return '';
}

function normalizeRule(raw, i, defaults){
	defaults = defaults || {};
	const r = { ...raw };
	r.type = r.type || 'event';
	r.id = String(r.id || r.name || `rule-${i + 1}`).trim();
	r.name = r.name || r.id;
	r.enabled = r.enabled !== false;
	r.severity = String(r.severity || 'warning').toLowerCase();
	r.channels = (r.channels && r.channels.length) ? r.channels : (defaults.channels || []);
	r.forMinutes = r.forMinutes == null ? (defaults.forMinutes || 0) : r.forMinutes;
	r.clearMinutes = r.clearMinutes == null ? (defaults.clearMinutes == null ? 1 : defaults.clearMinutes) : r.clearMinutes;
	// 0 = notify once per firing and stay quiet until it clears
	r.repeatMinutes = r.repeatMinutes == null ? (defaults.repeatMinutes || 0) : r.repeatMinutes;
	r.notifyResolve = r.notifyResolve == null ? (defaults.notifyResolve !== false) : !!r.notifyResolve;
	if(r.type === 'event'){
		r.events = (r.events && r.events.length) ? r.events : ['*'];
		if(!r.resolveEvents){
			const pairs = new Set();
			for(const e of r.events) for(const p of RESOLVE_PAIRS[e] || []) pairs.add(p);
			r.resolveEvents = [...pairs];
		}
		// a rule with no recovery event (login_fail, config_reload) is a one-shot
		// notice: it announces and clears itself, deduped by repeatMinutes
		r.oneShot = !r.resolveEvents.length;
		if(r.oneShot && raw.repeatMinutes == null && defaults.repeatMinutes == null) r.repeatMinutes = 5;
	}
	return r;
}

function createAlarmManager({ config, db, collector, onEvent, deliver, log }){
	config = config || {};
	deliver = deliver || notify.deliver;
	onEvent = onEvent || (()=>{});
	log = log || (()=>{});

	const defaults = config.defaults || {};
	const channels = config.channels || {};
	const rules = (Array.isArray(config.rules) ? config.rules : []).map((r, i)=>normalizeRule(r, i, defaults));
	const byId = {};
	for(const r of rules) byId[r.id] = r;

	const enabled = config.enabled !== false;
	const origin = config.origin || null;
	const metricIntervalMs = (config.metricIntervalSeconds || 30) * 1000;
	const slowIntervalMs = (config.slowIntervalMinutes || 10) * MIN;

	// key -> { ruleId, server, subject, state, since, firedAt, lastNotify, ... }
	const alarms = {};
	const gpuIdleSince = {}; // "server|gpu" -> ms, for gpu.idleMinutes
	let mutedUntil = 0;      // global snooze (ms epoch); rules carry their own
	const snoozed = {};      // ruleId -> ms epoch
	let lastError = null;
	let sent = 0, failed = 0;
	let metricTimer = null, slowTimer = null, running = false;

	const key = (rule, server, subject)=>`${rule.id} ${server || ''} ${subject || ''}`;

	function ruleActive(r){
		return enabled && r.enabled;
	}

	// snoozing silences delivery but keeps evaluating, so the UI still shows what
	// is wrong and the alarm resolves normally once it clears
	function silenced(r, nowMs){
		return nowMs < mutedUntil || nowMs < (snoozed[r.id] || 0);
	}

	function humanSince(ms){
		const m = ms / MIN;
		if(m < 1) return `${Math.round(ms / 1000)}s`;
		if(m < 90) return `${Math.round(m)}m`;
		return `${(m / 60).toFixed(1)}h`;
	}

	// ---- delivery ---------------------------------------------------------

	async function send(rule, entry, state){
		const nowMs = Date.now();
		const alarm = {
			id: `${rule.id}:${entry.server || '-'}:${entry.subject || '-'}`,
			rule: rule.name,
			ruleId: rule.id,
			state,
			severity: rule.severity,
			server: entry.server || null,
			subject: entry.subject || null,
			message: entry.message,
			valueText: entry.valueText || null,
			value: entry.value == null ? null : entry.value,
			threshold: entry.threshold == null ? null : entry.threshold,
			forText: entry.since ? humanSince(nowMs - entry.since) : null,
			ts: Math.floor(nowMs / 1000),
			origin,
		};
		entry.lastNotify = nowMs;
		if(silenced(rule, nowMs)){
			onEvent('alarm_muted', entry.server, `${rule.name}${entry.subject ? ` [${entry.subject}]` : ''}: ${state} (snoozed, not sent)`);
			return;
		}
		onEvent(state === 'resolved' ? 'alarm_resolve' : 'alarm_fire', entry.server,
			`${rule.name}${entry.subject ? ` [${entry.subject}]` : ''}: ${entry.message}`);

		const targets = rule.channels.length ? rule.channels : Object.keys(channels);
		for(const name of targets){
			const ch = channels[name];
			if(!ch){
				lastError = `rule "${rule.id}" points at unknown channel "${name}"`;
				onEvent('alarm_error', null, lastError);
				continue;
			}
			try{
				const res = await deliver(ch, alarm);
				if(res && res.sent) sent++;
			}
			catch(err){
				failed++;
				lastError = `${name}: ${err.message}`;
				// the failure is logged, never thrown: a broken webhook must not
				// stop the next channel, the next rule, or the monitor itself
				onEvent('alarm_error', entry.server, `notify ${name} failed for ${rule.name}: ${err.message}`);
			}
		}
	}

	// fire-and-forget: nothing upstream awaits a notification, and an unhandled
	// rejection here would take the process down
	function detach(p){
		if(p && p.catch) p.catch((err)=>{ lastError = err.message; });
	}

	// ---- state machine ----------------------------------------------------

	// Condition holds. Waits out forMinutes, fires once, then repeats only if
	// repeatMinutes says so.
	function raise(rule, server, subject, info){
		const nowMs = Date.now();
		const k = key(rule, server, subject);
		let e = alarms[k];
		if(!e){
			e = alarms[k] = { ruleId: rule.id, server: server || null, subject: subject || null, state: 'pending', since: nowMs, lastNotify: 0 };
		}
		Object.assign(e, { message: info.message, value: info.value, valueText: info.valueText, threshold: info.threshold, okSince: 0 });
		if(e.state === 'pending'){
			if(nowMs - e.since < rule.forMinutes * MIN) return null;
			e.state = 'firing';
			e.firedAt = nowMs;
			return send(rule, e, 'firing');
		}
		if(e.state === 'firing' && rule.repeatMinutes > 0 && nowMs - e.lastNotify >= rule.repeatMinutes * MIN){
			return send(rule, e, 'firing');
		}
		return null;
	}

	// Condition no longer holds. A firing alarm has to stay clear for
	// clearMinutes before it resolves, so a flapping service doesn't produce
	// alternating fire/resolve pairs.
	//
	// `definitive` skips that wait. A recovery *event* (service_up, ssh_connect)
	// is a statement, not a sample: there is no second observation coming, so
	// holding the alarm open would leave it firing until the next outage.
	// Sampled sources (metrics, DB scans) always take the delay.
	function clear(rule, server, subject, why, definitive){
		const nowMs = Date.now();
		const k = key(rule, server, subject);
		const e = alarms[k];
		if(!e) return null;
		if(e.state === 'pending'){ delete alarms[k]; return null; }
		if(!definitive){
			if(!e.okSince) e.okSince = nowMs;
			if(nowMs - e.okSince < rule.clearMinutes * MIN) return null;
		}
		delete alarms[k];
		if(why) e.message = why;
		return rule.notifyResolve ? send(rule, e, 'resolved') : null;
	}

	// ---- event rules ------------------------------------------------------

	// Called for every event the monitor logs. Must never throw, and ignores its
	// own alarm_* output or it would recurse.
	function handleEvent(type, server, message){
		if(!enabled) return;
		if(String(type).startsWith('alarm_')) return;
		for(const rule of rules){
			if(rule.type !== 'event' || !ruleActive(rule)) continue;
			const isTrigger = rule.events.includes('*') || rule.events.includes(type);
			const isResolve = rule.resolveEvents.includes(type);
			if(!isTrigger && !isResolve) continue;
			if(!matchesAny(rule.servers, server)) continue;
			if(rule.match && !new RegExp(rule.match, 'i').test(String(message || ''))) continue;
			const subject = subjectOf(type, message);
			if(isTrigger){
				const k = key(rule, server, subject);
				const e = alarms[k];
				// one-shot notices have no recovery event, so they dedupe on
				// repeatMinutes instead of on a state transition
				if(rule.oneShot && e && Date.now() - e.lastNotify < rule.repeatMinutes * MIN) continue;
				detach(raise(rule, server, subject, { message: `${type}: ${message}`, value: null, valueText: null, threshold: null }));
			}
			else{
				detach(clear(rule, server, subject, `recovered (${type}: ${message})`, true));
			}
		}
	}

	// ---- metric rules -----------------------------------------------------

	// Flatten the collector's live state into (server, subject, metric, value)
	// samples. Only online servers contribute - a stale reading from a box that
	// dropped 20 minutes ago must not hold an alarm open or clear one.
	function samples(){
		const out = [];
		const nowMs = Date.now();
		const states = (collector && collector.states) || {};
		for(const [server, s] of Object.entries(states)){
			if(!s) continue;
			const offlineMin = s.online ? 0 : Math.max(0, (nowMs / 1000 - (s.last_update || 0)) / 60);
			out.push({ server, subject: '', metric: 'server.offlineMinutes', value: offlineMin });
			if(!s.online) continue;

			const sys = s.system || {};
			if(sys.cpu){
				if(sys.cpu.util != null) out.push({ server, subject: '', metric: 'cpu.util', value: sys.cpu.util });
				if(sys.cpu.load && sys.cpu.cores) out.push({ server, subject: '', metric: 'cpu.loadPerCore', value: sys.cpu.load[0] / sys.cpu.cores });
			}
			if(sys.memory && sys.memory.total){
				out.push({ server, subject: '', metric: 'mem.usedPct', value: 100 * sys.memory.used / sys.memory.total });
			}
			for(const d of sys.disks || []){
				if(!d.total) continue;
				out.push({ server, subject: d.mount, metric: 'disk.usedPct', value: 100 * d.used / d.total });
				out.push({ server, subject: d.mount, metric: 'disk.freeGiB', value: (d.total - d.used) / GiB });
			}
			if(sys.network){
				out.push({ server, subject: '', metric: 'net.rxMBps', value: sys.network.rx / 1e6 });
				out.push({ server, subject: '', metric: 'net.txMBps', value: sys.network.tx / 1e6 });
			}
			for(const g of s.gpus || []){
				const subject = `gpu${g.gpu_id}`;
				const push = (metric, value)=>{ if(value != null) out.push({ server, subject, metric, value }); };
				push('gpu.util', num(g.utilization_gpu));
				push('gpu.temp', num(g.temperature_gpu));
				push('gpu.power', num(g.power_draw));
				push('gpu.fan', num(g.fan_speed));
				const used = num(g.used_memory), total = num(g.total_memory);
				if(used != null && total) push('gpu.memPct', 100 * used / total);
				if(used != null) push('gpu.memUsedGiB', used / 1024); // nvidia-smi reports MiB
				push('gpu.procs', g.procs || 0);

				// idle time is in no sample; it is the age of the last poll that
				// saw a compute process on this GPU
				const gk = `${server}|${g.gpu_id}`;
				if(g.procs > 0) gpuIdleSince[gk] = 0;
				else if(!gpuIdleSince[gk]) gpuIdleSince[gk] = nowMs;
				if(gpuIdleSince[gk]) push('gpu.idleMinutes', (nowMs - gpuIdleSince[gk]) / MIN);
			}
		}
		return out;
	}

	function breach(rule, v){
		if(rule.above != null && v > rule.above) return { hit: true, threshold: rule.above, dir: 'above' };
		if(rule.below != null && v < rule.below) return { hit: true, threshold: rule.below, dir: 'below' };
		return { hit: false, threshold: rule.above != null ? rule.above : rule.below, dir: rule.above != null ? 'above' : 'below' };
	}

	function evalMetrics(){
		const active = rules.filter((r)=>r.type === 'metric' && ruleActive(r));
		const rows = active.length ? samples() : [];
		const touched = new Set();
		for(const rule of active){
			const meta = METRICS[rule.metric] || {};
			const fmt = UNITS[meta.unit] || UNITS.n;
			const label = meta.label || rule.metric;
			for(const s of rows){
				if(s.metric !== rule.metric) continue;
				if(!matchesAny(rule.servers, s.server)) continue;
				if(!matchesAny(rule.subjects || rule.mounts || rule.gpus, s.subject || '')) continue;
				touched.add(key(rule, s.server, s.subject));
				const b = breach(rule, s.value);
				if(b.hit){
					detach(raise(rule, s.server, s.subject, {
						message: `${label} is ${fmt(s.value)} (${b.dir} ${fmt(b.threshold)})`,
						value: s.value, valueText: fmt(s.value), threshold: b.threshold,
					}));
				}
				else{
					detach(clear(rule, s.server, s.subject, `${label} back to ${fmt(s.value)}`));
				}
			}
		}
		reconcile(active, touched);
	}

	// A subject can vanish between passes (a server dropped out of the config, a
	// mount was unmounted, a container went away). Its alarm can never clear on
	// its own, so anything the pass didn't see resolves as "no longer reported"
	// rather than sitting firing forever.
	function reconcile(activeRules, touched){
		const ids = new Set(activeRules.map((r)=>r.id));
		for(const [k, e] of Object.entries(alarms)){
			if(!ids.has(e.ruleId)) continue;
			if(touched.has(k)) continue;
			const rule = byId[e.ruleId];
			if(!rule){ delete alarms[k]; continue; }
			detach(clear(rule, e.server, e.subject, 'no longer reported'));
		}
	}

	// ---- slow rules (DB-backed) -------------------------------------------

	function evalStorage(active, touched){
		if(!db || !active.length) return;
		for(const scope of db.distinctStorageScopes()){
			let entries;
			try{ entries = db.latestStorageEntries(scope); }
			catch(err){ lastError = `storage query for ${scope}: ${err.message}`; continue; }
			for(const rule of active){
				if(!matchesAny(rule.scopes || rule.servers, scope)) continue;
				const limit = (rule.aboveGiB || 0) * GiB;
				for(const e of entries){
					if(rule.kind && e.kind !== rule.kind) continue;
					if(e.kind === 'mount') continue; // already counted inside its container
					if(!matchesAny(rule.names, e.name)) continue;
					const subject = `${e.kind}:${e.name}`;
					touched.add(key(rule, scope, subject));
					const gib = (e.bytes || 0) / GiB;
					if((e.bytes || 0) > limit){
						detach(raise(rule, scope, subject, {
							message: `${e.kind} ${e.name} is using ${gib.toFixed(1)} GiB (limit ${rule.aboveGiB} GiB)`,
							value: gib, valueText: `${gib.toFixed(1)} GiB`, threshold: rule.aboveGiB,
						}));
					}
					else{
						detach(clear(rule, scope, subject, `${e.kind} ${e.name} back to ${gib.toFixed(1)} GiB`));
					}
				}
			}
		}
	}

	function evalSessions(active, touched){
		if(!db || !active.length) return;
		const now = Math.floor(Date.now() / 1000);
		let open;
		try{ open = db.queryUsage({ from: 0, to: now, server: null, user: null, active: true, limit: 1000, offset: 0 }).rows; }
		catch(err){ lastError = `usage query: ${err.message}`; return; }
		for(const rule of active){
			const limitH = rule.longerThanHours || 24;
			for(const r of open){
				if(!matchesAny(rule.servers, r.server)) continue;
				if(!matchesAny(rule.users, r.username)) continue;
				const hours = (now - r.start_ts) / 3600;
				const subject = `gpu${r.gpu_index}:${r.username}`;
				touched.add(key(rule, r.server, subject));
				if(hours > limitH){
					detach(raise(rule, r.server, subject, {
						message: `${r.username} has held GPU ${r.gpu_index} for ${hours.toFixed(1)}h (limit ${limitH}h)`,
						value: hours, valueText: `${hours.toFixed(1)}h`, threshold: limitH,
					}));
				}
				// no else: a session that ended is simply gone from the query, and
				// reconcile() is what resolves its alarm
			}
		}
	}

	function evalSlow(){
		const storageRules = rules.filter((r)=>r.type === 'storage' && ruleActive(r));
		const sessionRules = rules.filter((r)=>r.type === 'gpu_session' && ruleActive(r));
		const touched = new Set();
		evalStorage(storageRules, touched);
		evalSessions(sessionRules, touched);
		reconcile([...storageRules, ...sessionRules], touched);
	}

	function tick(fn){
		try{ fn(); }
		catch(err){
			lastError = err.message;
			onEvent('alarm_error', null, `evaluation failed: ${err.message}`);
		}
	}

	// ---- lifecycle and runtime control ------------------------------------

	function start(){
		if(running || !rules.length) return;
		running = true;
		metricTimer = setInterval(()=>tick(evalMetrics), metricIntervalMs);
		slowTimer = setInterval(()=>tick(evalSlow), slowIntervalMs);
	}

	function stop(){
		running = false;
		clearInterval(metricTimer);
		clearInterval(slowTimer);
		metricTimer = slowTimer = null;
	}

	// Carried across a config reload so a rule that is already firing doesn't
	// re-announce itself (and its "for 3h" doesn't reset to zero) just because
	// someone edited an unrelated rule.
	function exportState(){
		return { alarms: JSON.parse(JSON.stringify(alarms)), snoozed: { ...snoozed }, mutedUntil, gpuIdleSince: { ...gpuIdleSince }, sent, failed };
	}

	function importState(prev){
		if(!prev) return;
		for(const [k, e] of Object.entries(prev.alarms || {})){
			// A rule that was deleted from the file, or switched off, drops its
			// alarms rather than carrying them over: nothing is watching that
			// condition any more, so a "firing" row for it would be a ghost that
			// can never clear. No resolve notice - it was turned off deliberately,
			// and claiming the problem went away would be a lie.
			if(byId[e.ruleId] && ruleActive(byId[e.ruleId])) alarms[k] = e;
		}
		for(const [id, until] of Object.entries(prev.snoozed || {})) if(byId[id]) snoozed[id] = until;
		Object.assign(gpuIdleSince, prev.gpuIdleSince || {});
		mutedUntil = prev.mutedUntil || 0;
		sent = prev.sent || 0;
		failed = prev.failed || 0;
	}

	// Send a synthetic alarm so an operator can prove the webhook works without
	// waiting for something to break.
	async function test(channelName){
		const ch = channels[channelName];
		if(!ch) throw new Error(`unknown channel "${channelName}"`);
		const alarm = {
			id: 'test', rule: 'Test notification', ruleId: '__test__', state: 'firing', severity: 'info',
			server: null, subject: null, message: 'This is a test from Server Monitor. Alarms are wired up correctly.',
			valueText: null, value: null, threshold: null, forText: null, ts: Math.floor(Date.now() / 1000), origin,
		};
		const res = await deliver(ch, alarm);
		onEvent('alarm_test', null, `test notification to ${channelName}: ${res && res.sent ? 'sent' : (res && res.reason) || 'not sent'}`);
		return res;
	}

	function snooze(ruleId, minutes){
		if(!byId[ruleId]) throw new Error(`unknown rule "${ruleId}"`);
		snoozed[ruleId] = minutes > 0 ? Date.now() + minutes * MIN : 0;
		onEvent('alarm_config', null, `rule "${ruleId}" ${minutes > 0 ? `snoozed for ${minutes} min` : 'un-snoozed'}`);
		return snoozed[ruleId];
	}

	function muteAll(minutes){
		mutedUntil = minutes > 0 ? Date.now() + minutes * MIN : 0;
		onEvent('alarm_config', null, minutes > 0 ? `all alarms snoozed for ${minutes} min` : 'alarms un-snoozed');
		return mutedUntil;
	}

	// What the Alarms page shows: every rule with its live state, plus the
	// currently-firing alarms. Channel URLs are never included.
	function status(){
		const nowMs = Date.now();
		const list = Object.values(alarms);
		return {
			enabled,
			muted_until: mutedUntil > nowMs ? Math.floor(mutedUntil / 1000) : null,
			metric_interval_s: metricIntervalMs / 1000,
			slow_interval_s: slowIntervalMs / 1000,
			sent, failed, last_error: lastError,
			channels: Object.entries(channels).map(([name, ch])=>notify.redactChannel(name, ch)),
			rules: rules.map((r)=>{
				const mine = list.filter((e)=>e.ruleId === r.id);
				return {
					id: r.id, name: r.name, type: r.type, severity: r.severity, enabled: r.enabled,
					channels: r.channels, metric: r.metric || null, events: r.events || null,
					above: r.above == null ? null : r.above, below: r.below == null ? null : r.below,
					for_minutes: r.forMinutes, repeat_minutes: r.repeatMinutes, notify_resolve: r.notifyResolve,
					snoozed_until: (snoozed[r.id] || 0) > nowMs ? Math.floor(snoozed[r.id] / 1000) : null,
					firing: mine.filter((e)=>e.state === 'firing').length,
					pending: mine.filter((e)=>e.state === 'pending').length,
				};
			}),
			active: list.filter((e)=>e.state === 'firing').map((e)=>({
				rule: e.ruleId, name: (byId[e.ruleId] || {}).name || e.ruleId,
				severity: (byId[e.ruleId] || {}).severity || 'warning',
				server: e.server, subject: e.subject, message: e.message,
				value_text: e.valueText || null,
				since: Math.floor((e.firedAt || e.since) / 1000),
			})).sort((a, b)=>a.since - b.since),
		};
	}

	return {
		start, stop, handleEvent, status, test, snooze, muteAll,
		exportState, importState,
		evalNow: ()=>{ tick(evalMetrics); tick(evalSlow); },
		ruleCount: rules.length,
		channelCount: Object.keys(channels).length,
	};
}

module.exports = { createAlarmManager, normalizeRule, matchesAny, subjectOf, METRICS, RESOLVE_PAIRS };
