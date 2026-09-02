const express = require('express');

// `features` is mutated in place by a config reload, so every handler reads it
// fresh rather than closing over the instance that existed at mount time.
function createRoutes({ collector, monitorControl, db, onEvent, features, reloadFeatures, reloadAlarms, patchAlarmRule }){
	const router = express.Router();
	features = features || {};

	router.get('/monitor', (req, res)=>{
		res.json(collector.states);
	});

	function stopCollector(req, res){
		monitorControl.stop();
		onEvent('kill', null, `monitoring stopped by ${req.ip}`);
		res.json({ running: false });
	}

	function startCollector(req, res){
		monitorControl.start();
		onEvent('revive', null, `monitoring restarted by ${req.ip}`);
		res.json({ running: true });
	}

	router.post('/api/collector/stop', stopCollector);
	router.post('/api/collector/start', startCollector);
	// legacy v1 endpoints
	router.get('/kill', stopCollector);
	router.get('/revive', startCollector);

	// live servers plus any that only exist in history
	router.get('/api/servers', (req, res)=>{
		const servers = Object.entries(collector.states).map(([name, s])=>({ name, online: !!s.online }));
		const known = new Set(servers.map((s)=>s.name));
		for(const name of db.distinctServers()){
			if(!known.has(name)) servers.push({ name, online: false });
		}
		res.json({ servers });
	});

	// ?server=<name>&from=<epoch s>&to=<epoch s>&bucket=<s>
	// defaults: last 6h, bucket auto-sized to <= ~500 points (min 60s)
	router.get('/api/history', (req, res)=>{
		const server = req.query.server;
		if(!server) return res.status(400).json({ error: 'server parameter required' });
		const now = Math.floor(Date.now() / 1000);
		const to = Number(req.query.to) || now;
		const from = Number(req.query.from) || (to - 6 * 3600);
		let bucket = Number(req.query.bucket) || Math.ceil((to - from) / 500 / 60) * 60;
		bucket = Math.max(60, bucket);
		res.json({ server, from, to, bucket, ...db.queryHistory(server, from, to, bucket) });
	});

	// ?from&to&server&type&limit&offset
	router.get('/api/events', (req, res)=>{
		res.json(db.queryEvents({
			from: Number(req.query.from) || 0,
			to: Number(req.query.to) || Math.floor(Date.now() / 1000),
			server: req.query.server || null,
			type: req.query.type || null,
			limit: Math.min(Number(req.query.limit) || 100, 1000),
			offset: Number(req.query.offset) || 0,
		}));
	});

	// every name the Storage page can show: monitored servers, configured scan
	// scopes (which may be boxes nobody monitors), and scopes only in history.
	// `online` is null for a scope that isn't a monitored server — nothing polls
	// it, so its liveness is unknown rather than down.
	router.get('/api/storage/scopes', (req, res)=>{
		const online = {};
		for(const [name, s] of Object.entries(collector.states)) online[name] = !!s.online;
		const names = new Set([...Object.keys(online), ...(features.storage ? features.storage.scopes() : []), ...db.distinctStorageScopes()]);
		res.json({ scopes: [...names].sort().map((name)=>({ name, online: name in online ? online[name] : null })) });
	});

	// ?server=<scope> -> live per-mount capacity + the latest scan entries, grouped
	// by kind (account / container+mount / path / custom), plus each target's health
	router.get('/api/storage', (req, res)=>{
		const scope = req.query.server;
		if(!scope) return res.status(400).json({ error: 'server parameter required' });
		const live = collector.states[scope];
		const liveDisks = live && live.system && live.system.disks;
		const mounts = (liveDisks && liveDisks.length)
			? liveDisks.map((d)=>({ mount: d.mount, used: d.used, total: d.total }))
			: db.latestDisks(scope);

		const targets = features.storage ? features.storage.status(scope) : [];
		const entries = db.latestStorageEntries(scope);
		// Rows are now kept per target, so a removed target (or a switched-off mount
		// layer) stops reporting its last scan as if it were current, and two targets
		// of the same kind no longer hide each other. With no targets at all the
		// scope is pure history: show it as-is.
		const liveIds = new Set(targets.map((t)=>t.id));
		const liveKinds = new Set(targets.flatMap((t)=>t.kinds || []));
		// rows written before the target column stand in until that kind is rescanned
		const rescanned = new Set(entries.filter((e)=>e.target).map((e)=>e.kind));
		const keep = (e)=>{
			if(!targets.length) return true;
			if(e.target) return liveIds.has(e.target);
			return !rescanned.has(e.kind) && liveKinds.has(e.kind);
		};
		const byKind = {};
		for(const e of entries){ if(keep(e)) (byKind[e.kind] = byKind[e.kind] || []).push(e); }
		// a container's mounts hang off it rather than standing alone in the list
		const mountsByParent = {};
		for(const m of byKind.mount || []) (mountsByParent[m.parent] = mountsByParent[m.parent] || []).push(m);
		for(const c of byKind.container || []) c.mounts = mountsByParent[c.name] || [];
		delete byKind.mount;

		res.json({
			server: scope,
			online: !!(live && live.online),
			mounts,
			kinds: byKind,
			targets,
		});
	});

	// force every target of a scope to scan now instead of waiting for its interval.
	// `ran` is false when a scan was already in flight — nothing was re-measured.
	router.post('/api/storage/scan', async (req, res)=>{
		const scope = req.query.server || null;
		const ran = features.storage ? await features.storage.scanNow(scope) : false;
		res.json({ ok: true, ran, targets: features.storage ? features.storage.status(scope) : [] });
	});

	// flat list of configured services with their current status (independent of servers)
	router.get('/api/services', (req, res)=>{
		res.json({ services: features.services ? features.services.all() : [] });
	});

	// force an immediate re-check instead of waiting for the checker's slow interval,
	// then return the freshly-updated statuses
	router.post('/api/services/check', async (req, res)=>{
		try{ if(features.services) await features.services.checkNow(); }
		catch(err){ /* checkNow + its probes catch internally; still return current state */ }
		res.json({ services: features.services ? features.services.all() : [] });
	});

	// Re-read services.json, storage.json and alarms.json and swap in fresh
	// checkers, so an edit doesn't need a restart. Deliberately manual rather than a file watcher: an
	// editor's save is several events over a briefly half-written file. Only these
	// three are reloadable — servers.json holds live poll state and config.json
	// owns the listening socket, so both still need a restart.
	router.post('/api/config/reload', (req, res)=>{
		if(!reloadFeatures) return res.status(501).json({ error: 'reload not available' });
		let loaded;
		try{ loaded = reloadFeatures(); }
		catch(err){
			onEvent('config_reload', null, `reload failed: ${err.message}`);
			return res.status(500).json({ error: err.message });
		}
		const msg = `services.json: ${loaded.services.services} services / ${loaded.services.connections} connections; ` +
			`${loaded.storage.source}: ${loaded.storage.targets} targets; ` +
			`alarms.json: ${loaded.alarms.rules} rules / ${loaded.alarms.channels} channels`;
		onEvent('config_reload', null, `${msg} (by ${req.ip})`);
		res.json({ ok: true, ...loaded });
	});

	// ---- alarms ----------------------------------------------------------
	// Rules, channels (never their webhook URLs), and what is firing right now.
	router.get('/api/alarms', (req, res)=>{
		if(!features.alarms) return res.json({ enabled: false, rules: [], channels: [], active: [] });
		res.json(features.alarms.status());
	});

	// Prove a webhook works without waiting for something to break.
	router.post('/api/alarms/test', async (req, res)=>{
		const channel = (req.body && req.body.channel) || req.query.channel;
		if(!features.alarms) return res.status(503).json({ error: 'alarms not configured' });
		if(!channel) return res.status(400).json({ error: 'channel required' });
		try{
			const out = await features.alarms.test(channel);
			res.json({ ok: true, ...out });
		}
		catch(err){ res.status(400).json({ error: err.message }); }
	});

	// Silence everything for a while (a planned maintenance window). 0 lifts it.
	router.post('/api/alarms/mute', (req, res)=>{
		if(!features.alarms) return res.status(503).json({ error: 'alarms not configured' });
		const minutes = Number((req.body && req.body.minutes) != null ? req.body.minutes : req.query.minutes) || 0;
		const until = features.alarms.muteAll(minutes);
		onEvent('alarm_config', null, `${minutes > 0 ? `all alarms snoozed ${minutes} min` : 'alarm snooze lifted'} by ${req.ip}`);
		res.json({ ok: true, muted_until: until ? Math.floor(until / 1000) : null, ...features.alarms.status() });
	});

	// Per-rule runtime control. `enabled` is durable — it is written back to
	// configs/alarms.json and the manager rebuilt, so a rule switched off stays
	// off across a restart. `snoozeMinutes` is deliberately *not* persisted: a
	// snooze is a "not right now", and one that survived a restart would silently
	// keep a rule quiet long after whoever set it had forgotten.
	router.post('/api/alarms/rule/:id', (req, res)=>{
		if(!features.alarms) return res.status(503).json({ error: 'alarms not configured' });
		const body = req.body || {};
		try{
			if(body.snoozeMinutes !== undefined){
				features.alarms.snooze(req.params.id, Number(body.snoozeMinutes) || 0);
			}
			if(body.enabled !== undefined){
				if(!patchAlarmRule || !reloadAlarms) return res.status(501).json({ error: 'rule editing not available' });
				patchAlarmRule(req.params.id, { enabled: !!body.enabled });
				onEvent('alarm_config', null, `rule "${req.params.id}" ${body.enabled ? 'enabled' : 'disabled'} by ${req.ip}`);
				reloadAlarms();
			}
		}
		catch(err){ return res.status(400).json({ error: err.message }); }
		res.json({ ok: true, ...features.alarms.status() });
	});

	// ?from&to&server&user&active&limit&offset (rows overlapping [from,to])
	router.get('/api/usage', (req, res)=>{
		res.json(db.queryUsage({
			from: Number(req.query.from) || 0,
			to: Number(req.query.to) || Math.floor(Date.now() / 1000),
			server: req.query.server || null,
			user: req.query.user || null,
			active: req.query.active === '1' || req.query.active === 'true',
			limit: Math.min(Number(req.query.limit) || 50, 1000),
			offset: Number(req.query.offset) || 0,
		}));
	});

	return router;
}

module.exports = { createRoutes };
