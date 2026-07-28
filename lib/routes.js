const express = require('express');

// `features` is mutated in place by a config reload, so every handler reads it
// fresh rather than closing over the instance that existed at mount time.
function createRoutes({ collector, monitorControl, db, onEvent, features, reloadFeatures }){
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

		const entries = db.latestStorageEntries(scope);
		const byKind = {};
		for(const e of entries) (byKind[e.kind] = byKind[e.kind] || []).push(e);
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
			targets: features.storage ? features.storage.status(scope) : [],
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

	// Re-read services.json and storage.json and swap in fresh checkers, so an edit
	// doesn't need a restart. Deliberately manual rather than a file watcher: an
	// editor's save is several events over a briefly half-written file. Only these
	// two are reloadable — servers.json holds live poll state and config.json owns
	// the listening socket, so both still need a restart.
	router.post('/api/config/reload', (req, res)=>{
		if(!reloadFeatures) return res.status(501).json({ error: 'reload not available' });
		let loaded;
		try{ loaded = reloadFeatures(); }
		catch(err){
			onEvent('config_reload', null, `reload failed: ${err.message}`);
			return res.status(500).json({ error: err.message });
		}
		const msg = `services.json: ${loaded.services.services} services / ${loaded.services.connections} connections; ` +
			`${loaded.storage.source}: ${loaded.storage.targets} targets`;
		onEvent('config_reload', null, `${msg} (by ${req.ip})`);
		res.json({ ok: true, ...loaded });
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
